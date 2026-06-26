# NEXUS: Ultimate ESP32 Smart Home System

A premium, modern home automation system featuring a high-fidelity glassmorphic mobile app (built with React Native and Expo) and deep integration with **Google Home & Gemini** via Sinric Pro. 

This project allows you to seamlessly provision your ESP32 headless via Bluetooth, control relays locally over Wi-Fi without internet, *and* control them globally via voice using Google Assistant/Gemini!

---

## ✨ Key Features
- **BLE Wi-Fi Provisioning**: No more hardcoding Wi-Fi credentials! Use the NEXUS app to securely send your Wi-Fi password to the ESP32 over Bluetooth.
- **Google Gemini & Google Home Ready**: Integrated with Sinric Pro, allowing you to say *"Hey Gemini, turn on the fan"* from anywhere in the world.
- **Dynamic GPIO Management**: Add any safe ESP32 GPIO pin as a custom switch directly from the mobile app.
- **Local Control**: The app speaks directly to the ESP32 via a local HTTP REST API (`http://esp32auto.local`), meaning almost zero latency.
- **Hardware Factory Reset**: Hold the physical `BOOT` button on the ESP32 for 3 seconds to wipe saved Wi-Fi credentials and return to setup mode.

---

## ⚡ ESP32 Firmware Setup

### 1. Prerequisites
- Download and install the [Arduino IDE](https://www.arduino.cc/en/software).
- Install the ESP32 board package (version `3.x.x` or newer recommended).
- Install the **SinricPro** library via the Arduino Library Manager.

### 2. Configure Credentials
1. Open `firmware/firmware.ino` in the Arduino IDE.
2. Edit the Sinric Pro credentials at the top of the file:
   ```cpp
   #define APP_KEY           "YOUR-SINRIC-PRO-APP-KEY"      
   #define APP_SECRET        "YOUR-SINRIC-PRO-APP-SECRET"   
   #define SWITCH1_ID        "YOUR-DEVICE-ID-FOR-SWITCH-1"  
   #define SWITCH2_ID        "YOUR-DEVICE-ID-FOR-SWITCH-2"  
   #define LED_ID            "YOUR-DEVICE-ID-FOR-LED"       
   ```

### 3. Flash to ESP32
1. Connect your ESP32 via USB.
2. Select your board under `Tools > Board`.
3. **CRITICAL**: Because of the heavy libraries (BLE + WiFi + SinricPro), go to `Tools > Partition Scheme` and select **Huge APP (3MB No OTA/1MB SPIFFS)**.
4. Click Upload!

---

## 📱 Android App Setup

### 1. Run the App
Navigate to the `app/` directory and compile the app:
```bash
cd app
npm install
npx expo run:android
```
*(Note: Because this app uses native BLE modules for provisioning, it must be compiled natively. The standard Expo Go app will not work for BLE).*

### 2. Provisioning the ESP32
1. Open the NEXUS app on your Android device.
2. Tap the **Bluetooth icon** in the top right to open the Setup Wizard.
3. The app will scan for your ESP32 (`NEXUS_Controller`).
4. Enter your Wi-Fi credentials. The app will securely beam them to the ESP32.
5. Once the ESP32 connects to your router, it will automatically save the IP address to your app.

---

## 🎙️ Google Home & Gemini Integration

To enable voice control from your phone's native Gemini app:
1. Create a free account at [portal.sinric.pro](https://portal.sinric.pro).
2. Create 3 devices (Type: *Smart Switch*) and copy their Device IDs into your `firmware.ino` as shown above.
3. On your phone, open the **Google Home** app.
4. Tap `+` > **Set up device** > **Works with Google**.
5. Search for **Sinric Pro**, log in, and link your account.
6. Trigger Gemini and say: *"Turn on Switch 1!"*

---

## 🌐 Local REST API Reference

The ESP32 runs a local mDNS server at `http://esp32auto.local` (and is accessible via its IP address).

### Get System Status
- **Method**: `GET /status`
- **Response**: JSON object containing states of all predefined devices and safe GPIO pins.

### Control Device State
- **Method**: `GET /set?device={name}&state={1|0}`
- **Method**: `GET /set?pin={gpio_number}&state={1|0}`
- **Example**: `http://esp32auto.local/set?pin=4&state=1`

### Factory Reset via API
- **Method**: `GET /reset-wifi`
- **Action**: Clears saved credentials and reboots ESP32 into BLE provisioning mode.