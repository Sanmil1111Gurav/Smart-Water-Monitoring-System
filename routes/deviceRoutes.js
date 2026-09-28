const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const telemetryService = require('../services/telemetryService');

// Get Device Status List
router.get('/devices', async (req, res) => {
  try {
    const db = getDb();
    const state = telemetryService.getState();
    const deviceRecord = await db.get("SELECT * FROM devices WHERE device_id = 'ESP32-001'");

    if (deviceRecord) {
      state.esp32.ipAddress = deviceRecord.ip_address || state.esp32.ipAddress;
      state.esp32.macAddress = deviceRecord.mac_address || state.esp32.macAddress;
      state.esp32.wifiRssi = deviceRecord.wifi_rssi || state.esp32.wifiRssi;
      state.esp32.firmware = deviceRecord.firmware_version || state.esp32.firmware;
    }

    res.json({ esp32: state.esp32, sensor: state.sensor, pump: state.pump, buzzer: state.buzzer });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error fetching device information.' });
  }
});

// ESP32 Command Polling Endpoint
router.get('/esp32/command', (req, res) => {
  const state = telemetryService.getState();
  state.esp32.lastSeen = Date.now();
  state.esp32.connected = true;

  res.json({
    pumpMode: state.pump.mode,
    targetPumpStatus: state.pump.status,
    buzzerActive: state.buzzer.active,
    thresholds: state.thresholds
  });
});

module.exports = router;
