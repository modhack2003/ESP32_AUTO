# NEXUS: 2-Channel ESP32 Automation System

A premium, modern home automation system featuring a high-fidelity glassmorphic Android app (built with React Native and Expo SDK 54) communicating over local Wi-Fi with an ESP32 microcontroller configured for a **2-channel relay module**.

---

## 📂 Project Structure

```text
ESP32_AUTO/
├── app/                  # Android Mobile Application (React Native / Expo SDK 54)
│   ├── App.js            # Dashboard UI with editable switch names & AsyncStorage
│   ├── package.json      # Mobile app dependencies
│   └── app.json          # Expo configuration
├── firmware/             # ESP32 Microcontroller Firmware
│   └── firmware.ino      # C++ code for Wi-Fi connection, REST API, & 2-channel GPIO control
└── README.md             # Project documentation (this file)
```

---

## ⚡ ESP32 Firmware Setup

### 1. Prerequisites
- Download and install the [Arduino IDE](https://www.arduino.cc/en/software).
- Install the ESP32 board package in Arduino IDE:
  1. Go to `File > Preferences`.
  2. Enter the following URL in **Additional Board Manager URLs**:
     `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
  3. Go to `Tools > Board > Boards Manager...`, search for `esp32` and install the package.

### 2. Configure & Flash
1. Open `firmware/firmware.ino` in Arduino IDE.
2. Edit the Wi-Fi credentials in the configuration section (lines 8-9):
   ```cpp
   const char* ssid = "YOUR_WIFI_SSID";
   const char* password = "YOUR_WIFI_PASSWORD";
   ```
3. Connect your ESP32 board to your computer.
4. Select your board under `Tools > Board` (e.g., `ESP32 Dev Module`) and select the correct port under `Tools > Port`.
5. Upload the sketch.
6. Open the **Serial Monitor** at **115200 baud** to see the IP address.

---

## 📱 Android App Setup

### 1. Run the Development Server
Navigate to the `app/` directory and start Expo:
```bash
cd app
npm run start
```

### 2. Load the App
- **On Phone**: Scan the QR code with the **Expo Go** app from the Google Play Store (ensure your phone is on the same Wi-Fi network as the ESP32).
- **On PC Browser**: Press **`w`** in your active terminal to load the interactive dashboard directly in your web browser.

---

## 🏷️ Customizing Switch Names
You can change the names of your switches directly in the app!
1. Tap the text label of the switch card (e.g., "Switch 1" or "Switch 2").
2. Type in a new name (e.g., "Living Room Light", "Water Pump", etc.).
3. The names are saved automatically to your device's memory (`AsyncStorage`) and will persist even when you restart the app.

---

## 🔌 Wiring Guide (2-Channel Relay)

| ESP32 GPIO Pin | Relay Input | Controlled Appliance (Example) |
| :--- | :--- | :--- |
| **GND** | GND | Ground reference |
| **VIN / 5V** | VCC | Relay board power |
| **GPIO 16** | IN1 | Appliance 1 (Switch 1) |
| **GPIO 17** | IN2 | Appliance 2 (Switch 2) |

---

## 🌐 ESP32 REST API Reference

### 1. Get System Status
- **URL**: `/status`
- **Method**: `GET`
- **Response**:
  ```json
  {
    "status": "ok",
    "devices": {
      "switch1": { "state": false },
      "switch2": { "state": false }
    }
  }
  ```

### 2. Control Device State
- **URL**: `/set`
- **Method**: `GET`
- **Parameters**:
  - `device`: `switch1` or `switch2`
  - `state`: `1` (ON) or `0` (OFF)
- **Example**: `http://esp32auto.local/set?device=switch1&state=1`

### 3. Master Switch (Toggle Both)
- **URL**: `/master`
- **Method**: `GET`
- **Parameters**:
  - `state`: `1` (ON) or `0` (OFF)
- **Example**: `http://esp32auto.local/master?state=0`