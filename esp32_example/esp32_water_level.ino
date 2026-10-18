/*
  ESP32 Water Level Monitoring System (Analog Water Sensor)
  ---------------------------------------------------------
  Hardware Components:
  1. ESP32 Development Board
  2. Water Sensor:
      S → GPIO34
      + → 3.3V
      - → GND
  3. L293D:
EN1 → GPIO25
IN1 → GPIO26
IN2 → GPIO27
  4. Buzzer:
  → GPIO14
  5. DC Water Pump Motor (Connected to L293D Output 1 & 2)

  Sends HTTP REST Telemetry JSON to Dashboard Server (/api/telemetry)
  Fetches Target Pump Control Commands & Mode Settings
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h> // Ensure ArduinoJson library is installed in Arduino IDE

// Wi-Fi Credentials
const char* ssid = "Sanmil";
const char* password = "sanmil123";

// Backend Dashboard Server URL
const char* serverUrl = "http://10.18.169.252:5000/api/telemetry";

// Pin Definitions
#define WATER_SENSOR_PIN 34 // ESP32 ADC Pin (GPIO 34) connected to Water Sensor Signal Output
#define BUZZER_PIN 14

// L293D Motor Driver Pins
#define L293D_ENABLE 25
#define L293D_IN1 26
#define L293D_IN2 27

// Sensor Calibration (Adjust these values based on Serial Monitor output when dry vs submerged)
const int SENSOR_MIN_RAW = 0;    // Raw reading when sensor is completely dry (Empty Tank)
const int SENSOR_MAX_RAW = 2500; // Raw reading when sensor is submerged in water (Full Tank)

// System State
String pumpMode = "AUTO";
String targetPumpStatus = "OFF";
bool buzzerAlarmActive = false;

void setPumpMotorState(bool turnOn) {
  if (turnOn) {
    digitalWrite(L293D_ENABLE, HIGH);
    digitalWrite(L293D_IN1, HIGH);
    digitalWrite(L293D_IN2, LOW);
  } else {
    digitalWrite(L293D_ENABLE, LOW);
    digitalWrite(L293D_IN1, LOW);
    digitalWrite(L293D_IN2, LOW);
  }
}

// Multi-sample averaged analog reading for smooth percentage calculation
int readAnalogWaterLevel() {
  long sum = 0;
  for (int i = 0; i < 10; i++) {
    sum += analogRead(WATER_SENSOR_PIN);
    delay(5);
  }
  return (int)(sum / 10);
}

int calculateWaterPercent(int rawAnalogValue) {
  if (rawAnalogValue <= SENSOR_MIN_RAW) return 0;
  if (rawAnalogValue >= SENSOR_MAX_RAW) return 100;

  float percent = ((float)(rawAnalogValue - SENSOR_MIN_RAW) / (float)(SENSOR_MAX_RAW - SENSOR_MIN_RAW)) * 100.0;
  if (percent > 100.0) percent = 100.0;
  if (percent < 0.0) percent = 0.0;
  return (int)percent;
}

void setup() {
  Serial.begin(115200);

  // Configure Analog Pin
  pinMode(WATER_SENSOR_PIN, INPUT);
  analogReadResolution(12); // 12-bit resolution (0 - 4095)

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  pinMode(L293D_ENABLE, OUTPUT);
  pinMode(L293D_IN1, OUTPUT);
  pinMode(L293D_IN2, OUTPUT);
  setPumpMotorState(false);

  Serial.println("\n-------------------------------------------");
  Serial.println("💧 ESP32 Water Level Monitoring System (Analog Sensor)");
  Serial.println("-------------------------------------------");
  Serial.printf("Connecting to Wi-Fi: %s\n", ssid);
  
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ Wi-Fi Connected!");
    Serial.print("ESP32 IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n⚠️ Wi-Fi Connection failed. Will retry in main loop.");
  }
}

void loop() {
  // Auto-reconnect if Wi-Fi drops
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("⚠️ Wi-Fi disconnected. Reconnecting...");
    WiFi.disconnect();
    WiFi.reconnect();
    delay(2000);
    return;
  }

  int rawAnalog = readAnalogWaterLevel();
  int waterPercent = calculateWaterPercent(rawAnalog);
  int rssi = WiFi.RSSI();

  Serial.printf("📊 Sensor Raw ADC: %d | Water Level: %d%% | RSSI: %d dBm\n", rawAnalog, waterPercent, rssi);

  // Prepare JSON Telemetry Payload
  HTTPClient http;
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<384> doc;
  doc["type"] = "TELEMETRY";
  doc["deviceId"] = "ESP32-001";
  doc["waterLevelPercent"] = waterPercent;
  doc["sensorValue"] = rawAnalog;
  doc["pumpStatus"] = targetPumpStatus;
  doc["pumpMode"] = pumpMode;
  doc["buzzerStatus"] = buzzerAlarmActive ? "ALARM" : "QUIET";
  doc["lowThreshold"] = 20;
  doc["fullThreshold"] = 85;
  doc["emergencyThreshold"] = 95;
  doc["wifiRssi"] = rssi;
  doc["uptime"] = millis() / 1000;
  doc["firmware"] = "SmartWater-ESP32-1.0.2";

  String requestBody;
  serializeJson(doc, requestBody);

  int httpResponseCode = http.POST(requestBody);

  if (httpResponseCode > 0) {
    String response = http.getString();
    StaticJsonDocument<512> respDoc;
    DeserializationError error = deserializeJson(respDoc, response);

    if (!error) {
      if (respDoc.containsKey("targetPumpStatus")) {
        targetPumpStatus = respDoc["targetPumpStatus"].as<String>();
        pumpMode = respDoc["pumpMode"].as<String>();
        buzzerAlarmActive = respDoc["buzzerActive"].as<bool>();

        // Actuate L293D Pump Motor based on server command
        if (targetPumpStatus == "ON") {
          setPumpMotorState(true);
        } else {
          setPumpMotorState(false);
        }

        // Actuate Buzzer Alarm
        if (buzzerAlarmActive) {
          digitalWrite(BUZZER_PIN, HIGH);
        } else {
          digitalWrite(BUZZER_PIN, LOW);
        }
      }
      Serial.printf("📡 Telemetry Sent OK (HTTP %d) | Pump: %s (%s)\n", httpResponseCode, targetPumpStatus.c_str(), pumpMode.c_str());
    }
  } else {
    Serial.printf("❌ HTTP Error sending telemetry: %d (%s)\n", httpResponseCode, http.errorToString(httpResponseCode).c_str());
  }
  http.end();

  delay(1000); // Send telemetry loop every 1 second
}


