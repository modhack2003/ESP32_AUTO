#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include "freertos/ringbuf.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ==========================================
// CONFIGURATION
// ==========================================
#define BOOT_BUTTON_PIN 0            // ESP32 Dev Board Boot/Flash button
#define PIN_SWITCH1 16               // Relay Channel 1 Pin
#define PIN_SWITCH2 17               // Relay Channel 2 Pin
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

String getStatusJSON() {
  String json = "{";
  json += "\"status\":\"ok\",";
  json += "\"devices\":{";
  json += "\"switch1\":{\"state\":" + String(switch1.state ? "true" : "false") + "},";
  json += "\"switch2\":{\"state\":" + String(switch2.state ? "true" : "false") + "}";
  json += "}";
  json += "}";
  return json;
}

void handleStatus() {
  sendJSONResponse(getStatusJSON());
}

void handleSet() {
  if (!server.hasArg("device") || !server.hasArg("state")) {
    sendJSONResponse("{\"status\":\"error\",\"message\":\"Missing device or state argument\"}");
    return;
  }

  String device = server.arg("device");
  String stateStr = server.arg("state");
  String stateLower = stateStr;
  stateLower.toLowerCase();
  bool newState = (stateStr == "1" || stateLower == "true");

  bool found = false;
  if (device == "switch1") {
    switch1.state = newState;
    digitalWrite(switch1.pin, newState ? HIGH : LOW);
    found = true;
  } else if (device == "switch2") {
    switch2.state = newState;
    digitalWrite(switch2.pin, newState ? HIGH : LOW);
    found = true;
  }

  if (found) {
    Serial.println("Set " + device + " to " + String(newState ? "ON" : "OFF"));
    sendJSONResponse(getStatusJSON());
  } else {
    sendJSONResponse("{\"status\":\"error\",\"message\":\"Unknown device: " + device + "\"}");
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
  digitalWrite(switch1.pin, newState ? HIGH : LOW);
  switch2.state = newState;
  digitalWrite(switch2.pin, newState ? HIGH : LOW);

  Serial.println("Master switch triggered: turning both " + String(newState ? "ON" : "OFF"));
  sendJSONResponse(getStatusJSON());
}

void handleNotFound() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(404, "text/plain", "Endpoint not found");
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

  server.on("/status", HTTP_OPTIONS, handleOptions);
  server.on("/set", HTTP_OPTIONS, handleOptions);
  server.on("/master", HTTP_OPTIONS, handleOptions);

  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTP Web Server started on port 80.");
}

// BLE Callbacks class
class BLECallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) {
    std::string value = pCharacteristic->getValue();
    if (value.length() > 0) {
      String data = String(value.c_str());
      int newlineIdx = data.indexOf('\n');
      if (newlineIdx == -1) {
        Serial.println("BLE Write: Invalid format. Expected SSID\\nPASSWORD");
        pStatusCharacteristic->setValue("FAILED");
        pStatusCharacteristic->notify();
        return;
      }
      pendingSSID = data.substring(0, newlineIdx);
      pendingPass = data.substring(newlineIdx + 1);
      wifiConnectionPending = true;
    }
  }
};

void startBLE() {
  Serial.println("Starting BLE Advertising for provisioning...");
  BLEDevice::init("NEXUS_Controller");

  pServer = BLEDevice::createServer();
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
  Serial.begin(115200);
  delay(10);

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  pinMode(PIN_SWITCH1, OUTPUT);
  pinMode(PIN_SWITCH2, OUTPUT);

  digitalWrite(PIN_SWITCH1, LOW);
  digitalWrite(PIN_SWITCH2, LOW);

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
        digitalWrite(PIN_SWITCH1, HIGH);
        delay(100);
        digitalWrite(PIN_SWITCH1, LOW);
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

    Serial.print("Connecting to Wi-Fi via BLE: ");
    Serial.println(pendingSSID);
    pStatusCharacteristic->setValue("CONNECTING");
    pStatusCharacteristic->notify();

    WiFi.disconnect();
    WiFi.begin(pendingSSID.c_str(), pendingPass.c_str());

    int retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 30) {
      delay(500);
      Serial.print(".");
      retries++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\nWi-Fi Connected successfully!");

      // Save credentials in Prefs
      preferences.begin("wifi-creds", false);
      preferences.putString("ssid", pendingSSID);
      preferences.putString("pass", pendingPass);
      preferences.end();

      // Notify App of connection & local URL
      String ipAddr = WiFi.localIP().toString();
      String notifyVal = "CONNECTED:http://" + ipAddr;
      pStatusCharacteristic->setValue(notifyVal.c_str());
      pStatusCharacteristic->notify();

      delay(2000);  // Wait for transmission before deinit

      // Shutdown BLE
      BLEDevice::deinit(true);
      isBleActive = false;
      isWifiConnected = true;

      startWebServer();
    } else {
      Serial.println("\nWi-Fi connection failed.");
      pStatusCharacteristic->setValue("FAILED");
      pStatusCharacteristic->notify();
    }
  }

  // Handle server clients
  if (isWifiConnected) {
    server.handleClient();
  }

  delay(5);
}
