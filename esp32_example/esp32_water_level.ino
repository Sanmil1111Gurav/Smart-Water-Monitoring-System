/*
  ESP32 Water Level Monitoring & L293D Pump Driver System
  -------------------------------------------------------
  Hardware Components:
  1. ESP32 Development Board
  2. Ultrasonic Sensor HC-SR04 (Trig = GPIO 5, Echo = GPIO 18)
  3. L293D Motor Driver (Enable1 = GPIO 14, IN1 = GPIO 27, IN2 = GPIO 26)
  4. Piezo Buzzer (GPIO 19)
  5. DC Water Pump Motor (Connected to L293D Output 1 & 2)

  Sends HTTP REST Telemetry JSON to Dashboard Server (/api/telemetry)
  Fetches Target Pump Control Commands & Mode Settings
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h> // Ensure ArduinoJson library is installed in Arduino IDE

// Wi-Fi Credentials
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// Backend Dashboard Server URL (Replace IP with your computer's IP address)
const char* serverUrl = "http://192.168.1.100:5000/api/telemetry";

// Pin Definitions
#define TRIG_PIN 5
#define ECHO_PIN 18
#define BUZZER_PIN 19

// L293D Motor Driver Pins
#define L293D_ENABLE 14
#define L293D_IN1 27
#define L293D_IN2 26

// Tank Geometry Constants
const float TANK_TOTAL_DEPTH_CM = 100.0; // Distance from sensor to bottom of empty tank (cm)
const float SENSOR_OFFSET_CM = 5.0;       // Minimum sensor blind distance at 100% full (cm)

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

float measureDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000); // 30ms timeout
  if (duration == 0) return TANK_TOTAL_DEPTH_CM;  // Fallback if no echo

  float distanceCm = (duration * 0.0343) / 2.0;
  return distanceCm;
}

int calculateWaterPercent(float distanceCm) {
  float waterHeightCm = TANK_TOTAL_DEPTH_CM - distanceCm;
  float maxWaterHeightCm = TANK_TOTAL_DEPTH_CM - SENSOR_OFFSET_CM;
  
  float percent = (waterHeightCm / maxWaterHeightCm) * 100.0;
  if (percent > 100.0) percent = 100.0;
  if (percent < 0.0) percent = 0.0;
  return (int)percent;
}

void setup() {
  Serial.begin(115200);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  pinMode(L293D_ENABLE, OUTPUT);
  pinMode(L293D_IN1, OUTPUT);
  pinMode(L293D_IN2, OUTPUT);
  setPumpMotorState(false);

  Serial.println("\nConnecting to Wi-Fi...");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWi-Fi Connected!");
  Serial.print("ESP32 IP Address: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    float distanceCm = measureDistanceCm();
    int waterPercent = calculateWaterPercent(distanceCm);
    int rssi = WiFi.RSSI();

    Serial.printf("Distance: %.1f cm | Water Level: %d%% | RSSI: %d dBm\n", distanceCm, waterPercent, rssi);

    // Prepare JSON Telemetry Payload
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

    StaticJsonDocument<256> doc;
    doc["waterLevelPercent"] = waterPercent;
    doc["distanceCm"] = (int)distanceCm;
    doc["wifiRssi"] = rssi;
    doc["temp"] = 31.5; // Optional DHT sensor value
    doc["humidity"] = 60;

    String requestBody;
    serializeJson(doc, requestBody);

    int httpResponseCode = http.POST(requestBody);

    if (httpResponseCode > 0) {
      String response = http.getString();
      StaticJsonDocument<512> respDoc;
      deserializeJson(respDoc, response);

      // Parse Command Response from Dashboard Server
      if (respDoc.containsKey("targetPumpStatus")) {
        targetPumpStatus = respDoc["targetPumpStatus"].as<String>();
        pumpMode = respDoc["pumpMode"].as<String>();
        buzzerAlarmActive = respDoc["buzzerActive"].as<bool>();

        // Actuate L293D Pump Motor based on server state
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
    } else {
      Serial.printf("HTTP Error sending telemetry: %d\n", httpResponseCode);
    }
    http.end();
  }

  delay(1000); // 1-second telemetry loop
}
