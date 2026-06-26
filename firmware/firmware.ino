#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include "freertos/ringbuf.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include "esp_gap_ble_api.h"

// ==========================================
// CONFIGURATION
// ==========================================
#define BOOT_BUTTON_PIN 0            // ESP32 Dev Board Boot/Flash button
#define PIN_SWITCH1 16               // Relay Channel 1 Pin
#define PIN_SWITCH2 17               // Relay Channel 2 Pin
#define PIN_LED 2                    // ESP32 Onboard LED Pin
const char *hostname = "esp32auto";  // http://esp32auto.local

// BLE UUIDs - Match these in the React Native App
#define SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHAR_CREDENTIALS_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define CHAR_STATUS_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a9"

// ==========================================
// GLOBALS
// ==========================================
struct Device {
  bool state;
  int pin;
};

Device switch1 = { false, PIN_SWITCH1 };
Device switch2 = { false, PIN_SWITCH2 };
Device onboardLed = { false, PIN_LED };

Preferences preferences;
WebServer server(80);

bool isBleActive = false;
bool isWifiConnected = false;

// BLE pointers
BLEServer *pServer = NULL;
BLECharacteristic *pStatusCharacteristic = NULL;

// Pending connection values (processed in loop to avoid BLE thread crash)
bool wifiConnectionPending = false;
String pendingSSID = "";
String pendingPass = "";

// Runtime factory reset button tracking
unsigned long buttonPressStart = 0;
bool buttonActive = false;

// Helper to send standard JSON response with CORS
void sendJSONResponse(String jsonString) {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(200, "application/json", jsonString);
}

void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(204);
}

bool isSafeGPIOPin(int pin) {
  // Input-only pins on ESP32
  if (pin == 34 || pin == 35 || pin == 36 || pin == 39) return false;
  // Flash memory pins (SPI) - using these crashes the chip
  if (pin >= 6 && pin <= 11) return false;
  // All other GPIO pins 0 to 33 are generally safe to configure as outputs
  if (pin >= 0 && pin <= 33) return true;
  return false;
}

String getStatusJSON() {
  String json = "{";
  json += "\"status\":\"ok\",";
  json += "\"devices\":{";
  json += "\"switch1\":{\"state\":" + String(switch1.state ? "true" : "false") + "},";
  json += "\"switch2\":{\"state\":" + String(switch2.state ? "true" : "false") + "},";
  json += "\"onboardLed\":{\"state\":" + String(onboardLed.state ? "true" : "false") + "}";
  json += "}";
  json += "}";
  return json;
}

void handleStatus() {
  sendJSONResponse(getStatusJSON());
}

void handleSet() {
  if ((!server.hasArg("device") && !server.hasArg("pin")) || !server.hasArg("state")) {
    sendJSONResponse("{\"status\":\"error\",\"message\":\"Missing device/pin or state argument\"}");
    return;
  }

  String stateStr = server.arg("state");
  String stateLower = stateStr;
  stateLower.toLowerCase();
  bool newState = (stateStr == "1" || stateLower == "true");

  bool found = false;

  if (server.hasArg("pin")) {
    int targetPin = server.arg("pin").toInt();
    if (isSafeGPIOPin(targetPin)) {
      pinMode(targetPin, OUTPUT);
      
      // Update local structured state if it matches a known device
      if (targetPin == switch1.pin) {
        switch1.state = newState;
        digitalWrite(targetPin, newState ? LOW : HIGH); // Active-low relay
      } else if (targetPin == switch2.pin) {
        switch2.state = newState;
        digitalWrite(targetPin, newState ? LOW : HIGH); // Active-low relay
      } else if (targetPin == onboardLed.pin) {
        onboardLed.state = newState;
        digitalWrite(targetPin, newState ? HIGH : LOW); // Active-high onboard LED
      } else {
        digitalWrite(targetPin, newState ? HIGH : LOW); // Generic pin defaults to active-high
      }
      
      Serial.println("[Set Pin] Set GPIO " + String(targetPin) + " to " + String(newState ? "ON" : "OFF"));
      found = true;
    } else {
      sendJSONResponse("{\"status\":\"error\",\"message\":\"GPIO pin is unsafe or input-only\"}");
      return;
    }
  } else if (server.hasArg("device")) {
    String device = server.arg("device");
    if (device == "switch1") {
      switch1.state = newState;
      digitalWrite(switch1.pin, newState ? LOW : HIGH); // Active-low relay
      found = true;
    } else if (device == "switch2") {
      switch2.state = newState;
      digitalWrite(switch2.pin, newState ? LOW : HIGH); // Active-low relay
      found = true;
    } else if (device == "onboardLed") {
      onboardLed.state = newState;
      digitalWrite(onboardLed.pin, newState ? HIGH : LOW); // Active-high onboard LED
      found = true;
    }
  }

  if (found) {
    sendJSONResponse(getStatusJSON());
  } else {
    sendJSONResponse("{\"status\":\"error\",\"message\":\"Unknown device or invalid pin argument\"}");
  }
}

void handleMaster() {
  if (!server.hasArg("state")) {
    sendJSONResponse("{\"status\":\"error\",\"message\":\"Missing state argument\"}");
    return;
  }

  String stateStr = server.arg("state");
  String stateLower = stateStr;
  stateLower.toLowerCase();
  bool newState = (stateStr == "1" || stateLower == "true");

  switch1.state = newState;
  digitalWrite(switch1.pin, newState ? LOW : HIGH); // Active-low relay
  switch2.state = newState;
  digitalWrite(switch2.pin, newState ? LOW : HIGH); // Active-low relay

  Serial.println("Master switch triggered: turning both " + String(newState ? "ON" : "OFF"));
  sendJSONResponse(getStatusJSON());
}

void handleNotFound() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(404, "text/plain", "Endpoint not found");
}

void handleResetWifi() {
  Serial.println("[Reset] Clear WiFi credentials request received via HTTP.");
  
  // Clear Wi-Fi credentials from Preferences
  preferences.begin("wifi-creds", false);
  preferences.clear();
  preferences.end();
  Serial.println("[Reset] Preferences cleared. Sending response and restarting...");

  sendJSONResponse("{\"status\":\"ok\",\"message\":\"WiFi credentials cleared. Restarting device...\"}");
  
  // Wait for the HTTP response to finish sending, then reboot the ESP32
  delay(1000);
  ESP.restart();
}

void startWebServer() {
  if (MDNS.begin(hostname)) {
    Serial.print("MDNS responder started: http://");
    Serial.print(hostname);
    Serial.println(".local");
  }

  server.on("/status", HTTP_GET, handleStatus);
  server.on("/set", HTTP_GET, handleSet);
  server.on("/master", HTTP_GET, handleMaster);
  server.on("/reset-wifi", HTTP_GET, handleResetWifi);

  server.on("/status", HTTP_OPTIONS, handleOptions);
  server.on("/set", HTTP_OPTIONS, handleOptions);
  server.on("/master", HTTP_OPTIONS, handleOptions);
  server.on("/reset-wifi", HTTP_OPTIONS, handleOptions);

  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTP Web Server started on port 80.");
}

// BLE Server Callbacks to track phone connections
class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    Serial.println("[BLE Debug] Client connected!");
  }

  void onDisconnect(BLEServer* pServer) {
    Serial.println("[BLE Debug] Client disconnected. Restarting advertising...");
    // Restart advertising to allow the app to reconnect if needed
    BLEDevice::startAdvertising();
    Serial.println("[BLE Debug] BLE Advertising restarted.");
  }
};

// BLE Callbacks class
class BLECallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) {
    std::string value = pCharacteristic->getValue();
    Serial.print("[BLE Debug] Write request received. Raw length: ");
    Serial.print(value.length());
    Serial.println(" bytes.");

    if (value.length() > 0) {
      String rawInput = String(value.c_str());
      Serial.print("[BLE Debug] Raw payload: ");
      Serial.println(rawInput);

      int newlineIdx = rawInput.indexOf('\n');
      if (newlineIdx == -1) {
        Serial.println("[BLE Debug] Error: Invalid credentials format. Expected SSID\\nPASSWORD");
        pStatusCharacteristic->setValue("FAILED");
        pStatusCharacteristic->notify();
        return;
      }
      
      pendingSSID = rawInput.substring(0, newlineIdx);
      pendingPass = rawInput.substring(newlineIdx + 1);
      
      // Trim any trailing carriage returns if present (\r\n format)
      if (pendingSSID.endsWith("\r")) {
        pendingSSID = pendingSSID.substring(0, pendingSSID.length() - 1);
      }
      if (pendingPass.endsWith("\r")) {
        pendingPass = pendingPass.substring(0, pendingPass.length() - 1);
      }
      
      Serial.print("[BLE Debug] Parsed SSID: '");
      Serial.print(pendingSSID);
      Serial.print("' (");
      Serial.print(pendingSSID.length());
      Serial.println(" chars)");
      
      Serial.print("[BLE Debug] Parsed Password (length: ");
      Serial.print(pendingPass.length());
      Serial.println(" chars)");
      
      wifiConnectionPending = true;
    }
  }
};

void startBLE() {
  Serial.println("Starting BLE Advertising for provisioning...");
  BLEDevice::init("NEXUS_Controller");

  // Lower BLE TX power to reduce current draw spikes and prevent brownouts
  esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_DEFAULT, ESP_PWR_LVL_N3);
  esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_ADV, ESP_PWR_LVL_N3);
  esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_SCAN, ESP_PWR_LVL_N3);

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());
  
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // Write Characteristic (for receiving SSID\nPASS)
  BLECharacteristic *pCredsCharacteristic = pService->createCharacteristic(
    CHAR_CREDENTIALS_UUID,
    BLECharacteristic::PROPERTY_WRITE);
  pCredsCharacteristic->setCallbacks(new BLECallbacks());

  // Read/Notify Characteristic (for connection status & IP feedback)
  pStatusCharacteristic = pService->createCharacteristic(
    CHAR_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  pStatusCharacteristic->addDescriptor(new BLE2902());
  pStatusCharacteristic->setValue("IDLE");

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);  // functions that help with iPhone connections issues
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  isBleActive = true;
  Serial.println("BLE Active. Search for 'NEXUS_Controller' in your app.");
}

void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0); // Disable brownout detector to prevent resets during transceiver current spikes
  Serial.begin(115200);
  delay(10);

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  pinMode(PIN_SWITCH1, OUTPUT);
  pinMode(PIN_SWITCH2, OUTPUT);
  pinMode(PIN_LED, OUTPUT);

  digitalWrite(PIN_SWITCH1, HIGH); // Set relay pin HIGH to keep active-low relay turned OFF on boot
  digitalWrite(PIN_SWITCH2, HIGH); // Set relay pin HIGH to keep active-low relay turned OFF on boot
  digitalWrite(PIN_LED, LOW);      // Keep active-high LED turned OFF

  // Check Factory Reset trigger
  if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
    Serial.println("Boot button held on startup. Checking hold time...");
    int holdCount = 0;
    while (digitalRead(BOOT_BUTTON_PIN) == LOW && holdCount < 30) {
      delay(100);
      holdCount++;
    }
    if (holdCount >= 30) {
      Serial.println("Factory Reset: Clearing stored Wi-Fi credentials!");
      preferences.begin("wifi-creds", false);
      preferences.clear();
      preferences.end();
      // Onboard blink indicator (rapid blinks)
      for (int i = 0; i < 10; i++) {
        digitalWrite(PIN_SWITCH1, LOW); // ON
        delay(100);
        digitalWrite(PIN_SWITCH1, HIGH); // OFF
        delay(100);
      }
    }
  }

  // Load Wi-Fi credentials
  preferences.begin("wifi-creds", true);  // Read-only
  String savedSSID = preferences.getString("ssid", "");
  String savedPass = preferences.getString("pass", "");
  preferences.end();

  if (savedSSID.length() > 0) {
    Serial.print("Stored Wi-Fi detected: ");
    Serial.println(savedSSID);

    WiFi.begin(savedSSID.c_str(), savedPass.c_str());
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
      delay(500);
      Serial.print(".");
      attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\nWi-Fi Connected successfully.");
      Serial.print("IP Address: ");
      Serial.println(WiFi.localIP());
      isWifiConnected = true;
      startWebServer();
    } else {
      Serial.println("\nFailed to connect to saved Wi-Fi network.");
      startBLE();
    }
  } else {
    Serial.println("No saved Wi-Fi credentials found.");
    startBLE();
  }
}

void loop() {
  // Handle Wi-Fi provisioning attempt from BLE write callback
  if (wifiConnectionPending) {
    wifiConnectionPending = false;

    Serial.print("[WiFi Debug] Connecting to Wi-Fi SSID: '");
    Serial.print(pendingSSID);
    Serial.println("'");
    pStatusCharacteristic->setValue("CONNECTING");
    pStatusCharacteristic->notify();

    Serial.println("[WiFi Debug] Disconnecting previous Wi-Fi connection...");
    WiFi.disconnect();
    delay(500);

    Serial.println("[WiFi Debug] Starting WiFi.begin()...");
    WiFi.begin(pendingSSID.c_str(), pendingPass.c_str());

    int retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 30) {
      delay(500);
      Serial.print(".");
      if (retries % 10 == 0 && retries > 0) {
        Serial.print(" (WiFi status code: ");
        Serial.print(WiFi.status());
        Serial.println(")");
      }
      retries++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\n[WiFi Debug] Wi-Fi connected successfully!");
      Serial.print("[WiFi Debug] Local IP Address: ");
      Serial.println(WiFi.localIP());

      // Save credentials in Prefs
      preferences.begin("wifi-creds", false);
      preferences.putString("ssid", pendingSSID);
      preferences.putString("pass", pendingPass);
      preferences.end();
      Serial.println("[Prefs Debug] WiFi credentials saved in Preferences.");

      // Notify App of connection & local IP (shortened to prevent BLE MTU truncation)
      String ipAddr = WiFi.localIP().toString();
      String notifyVal = "IP:" + ipAddr;
      Serial.print("[BLE Debug] Notifying app client: ");
      Serial.println(notifyVal);
      pStatusCharacteristic->setValue(notifyVal.c_str());
      pStatusCharacteristic->notify();

      delay(2000);  // Wait for transmission before deinit

      // Shutdown BLE
      Serial.println("[BLE Debug] Shutting down BLE...");
      BLEDevice::deinit(true);
      isBleActive = false;
      isWifiConnected = true;

      startWebServer();
    } else {
      Serial.print("\n[WiFi Debug] Wi-Fi connection failed. Final status code: ");
      Serial.println(WiFi.status());
      pStatusCharacteristic->setValue("FAILED");
      pStatusCharacteristic->notify();
    }
  }

  // Handle server clients
  if (isWifiConnected) {
    server.handleClient();
  }

  // Monitor physical Factory Reset button (BOOT button) held for 3 seconds
  if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
    if (!buttonActive) {
      buttonPressStart = millis();
      buttonActive = true;
      Serial.println("[Reset] Reset button pressed. Hold for 3 seconds to clear Wi-Fi credentials...");
    } else if (millis() - buttonPressStart >= 3000) {
      Serial.println("[Reset] 3-second hold detected. Initiating Factory Reset...");
      
      // Visual feedback: blink onboard LED rapidly
      for (int i = 0; i < 10; i++) {
        digitalWrite(PIN_LED, HIGH);
        delay(100);
        digitalWrite(PIN_LED, LOW);
        delay(100);
      }
      
      // Clear preferences
      preferences.begin("wifi-creds", false);
      preferences.clear();
      preferences.end();
      
      Serial.println("[Reset] Preferences cleared. Rebooting device...");
      delay(500);
      ESP.restart();
    }
  } else {
    buttonActive = false;
  }

  delay(5);
}
