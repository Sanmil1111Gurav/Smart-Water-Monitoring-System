const { getDb } = require('../database');
const { triggerEmergencyAlert, sendEventNotification } = require('./emailService');
const { EVENT_CATEGORIES } = require('../utils/constants');

// In-Memory Real-Time System State Cache
let state = {
  esp32: {
    deviceName: 'ESP32 Node-01 (Main Tank Controller)',
    connected: false,
    lastSeen: null,
    wifiRssi: null,
    ipAddress: null,
    macAddress: null,
    uptime: null,
    firmware: null
  },
  sensor: {
    deviceName: 'HC-SR04 Ultrasonic Distance Sensor',
    waterLevelPercent: null,
    distanceCm: null,
    tankCapacityLiters: 1000,
    currentLiters: null,
    status: 'NOT_AVAILABLE',
    health: 'Not Available',
    lastReading: null
  },
  pump: {
    deviceName: '12V Submersible DC Water Pump (L293D Driver)',
    status: 'Not Available',
    mode: 'AUTO',
    lastStateChange: null,
    lastActivationTime: null,
    runtimeMinutesToday: 0,
    totalRuntimeHours: 0,
    activationsToday: 0,
    avgRuntimeMinutes: 0,
    longestRuntimeMinutes: 0
  },
  buzzer: {
    deviceName: '5V Active Piezoelectric Buzzer',
    active: false,
    reason: null,
    muted: false,
    enabled: true,
    alarmTriggerLevel: '95%',
    alarmDurationSeconds: 60,
    repeatAlarm: true
  },
  systemHealth: {
    temperature: null,
    humidity: null,
    refreshIntervalSeconds: 1,
    timezone: 'Asia/Kolkata (UTC+5:30)'
  },
  thresholds: {
    lowPercent: 20,
    fullPercent: 85,
    overflowPercent: 95,
    maxPumpTimeoutMinutes: 30
  },
  usageStats: {
    todayLiters: 0,
    weeklyLiters: 0,
    monthlyLiters: 0,
    avgDailyLiters: 0
  },
  notificationSettings: {
    lowLevelAlert: true,
    fullTankAlert: true,
    overflowAlert: true,
    pumpFailureAlert: true,
    sensorFailureAlert: true,
    deviceOfflineAlert: true,
    channels: {
      telegram: { enabled: false, botToken: '', chatId: '' },
      email: { enabled: false, recipient: '' },
      sms: { enabled: false, phoneNumber: '' },
      whatsapp: { enabled: false, phoneNumber: '' }
    }
  },
  inEmergencyCondition: false
};

let wss = null;

function setWebSocketServer(wssInstance) {
  wss = wssInstance;
}

/**
 * Centralized Event-to-Category Mapper Function
 */
function determineCategory(eventName, rawCategory) {
  if (
    rawCategory === EVENT_CATEGORIES.SENSOR_READINGS ||
    rawCategory === EVENT_CATEGORIES.PUMP_EVENTS ||
    rawCategory === EVENT_CATEGORIES.ALARM_EVENTS ||
    rawCategory === EVENT_CATEGORIES.SYSTEM_EVENTS
  ) {
    return rawCategory;
  }
  const evt = (eventName || '').toLowerCase();
  const cat = (rawCategory || '').toLowerCase();

  if (
    cat === 'alarm' || cat === 'alarm events' ||
    evt.includes('alarm') || evt.includes('low water') || evt.includes('tank full') ||
    evt.includes('emergency') || evt.includes('overflow') || evt.includes('threshold exceeded')
  ) {
    return EVENT_CATEGORIES.ALARM_EVENTS;
  }

  if (
    cat === 'pump' || cat === 'pump events' ||
    evt.includes('pump') || evt.includes('motor') || evt.includes('auto-fill')
  ) {
    return EVENT_CATEGORIES.PUMP_EVENTS;
  }

  if (
    cat === 'system' || cat === 'system events' ||
    evt.includes('esp32') || evt.includes('connected') || evt.includes('disconnected') ||
    evt.includes('wifi') || evt.includes('reboot') || evt.includes('config') || evt.includes('setting') || evt.includes('mode changed')
  ) {
    return EVENT_CATEGORIES.SYSTEM_EVENTS;
  }

  return EVENT_CATEGORIES.SENSOR_READINGS;
}

/**
 * Load Persisted Configuration from DB into State Cache
 */
async function loadPersistedConfig() {
  try {
    const db = getDb();
    const configRow = await db.get('SELECT * FROM configuration WHERE id = 1');
    if (configRow) {
      state.thresholds.lowPercent = configRow.low_water_threshold;
      state.thresholds.fullPercent = configRow.full_water_threshold;
      state.thresholds.overflowPercent = configRow.emergency_overflow_threshold;
      state.thresholds.maxPumpTimeoutMinutes = configRow.max_pump_timeout_minutes;
      state.sensor.tankCapacityLiters = configRow.tank_capacity_liters;
      state.pump.mode = configRow.pump_mode;
      state.buzzer.enabled = Boolean(configRow.buzzer_enabled);
    }
  } catch (err) {
    console.error('Error loading configuration from DB:', err);
  }
}

/**
 * Log Event to DB & Create Notification for Alarm/System Critical Events
 */
async function logActivity(title, desc, type = 'info', icon = 'info', deviceId = 'ESP32-001') {
  const category = determineCategory(title);
  const nowIso = new Date().toISOString();

  try {
    const db = getDb();
    await db.run(
      `INSERT INTO events (device_id, timestamp, category, event_type, event, details, status, water_level_percentage, distance_cm, pump_status, pump_mode, buzzer_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        deviceId,
        nowIso,
        category,
        title,
        title,
        desc,
        type,
        state.sensor.waterLevelPercent,
        state.sensor.distanceCm,
        state.pump.status,
        state.pump.mode,
        state.buzzer.active ? 'ALARM' : 'QUIET'
      ]
    );

    if (category === EVENT_CATEGORIES.ALARM_EVENTS || title.includes('Disconnected') || title.includes('Safety')) {
      const severity = category === EVENT_CATEGORIES.ALARM_EVENTS ? (title.includes('Overflow') ? 'critical' : 'warning') : 'info';
      await db.run(
        `INSERT INTO notifications (device_id, category, alert_type, title, message, severity, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [deviceId, category, title, title, desc, severity, nowIso]
      );
    }
  } catch (err) {
    console.error('Error persisting activity log to DB:', err);
  }
}

/**
 * Broadcast Real-Time State to WebSocket Clients
 */
async function broadcastState() {
  if (!wss) return;
  try {
    const db = getDb();

    const dbEvents = await db.all('SELECT * FROM events ORDER BY id DESC LIMIT 50');
    const history = dbEvents.map(e => ({
      id: e.id,
      timestamp: new Date(e.timestamp).getTime(),
      date: new Date(e.timestamp).toLocaleDateString(),
      time: new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      waterLevelPercent: e.water_level_percentage,
      distanceCm: e.distance_cm,
      usageLiters: 0,
      pumpStatus: e.pump_status,
      mode: e.pump_mode,
      buzzerStatus: e.buzzer_status,
      event: e.event,
      category: e.category
    }));

    const activityLogs = dbEvents.slice(0, 5).map(e => ({
      id: e.id,
      time: new Date(e.timestamp).toLocaleTimeString(),
      title: e.event,
      desc: e.details,
      type: e.status || 'info',
      icon: e.category === EVENT_CATEGORIES.ALARM_EVENTS ? 'alert' : (e.category === EVENT_CATEGORIES.PUMP_EVENTS ? 'play' : 'info')
    }));

    const payload = JSON.stringify({
      type: 'TELEMETRY_UPDATE',
      data: {
        ...state,
        history,
        activityLogs
      }
    });

    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(payload);
      }
    });
  } catch (err) {
    console.error('Error building WebSocket state payload:', err);
  }
}

/**
 * Evaluate Water Threshold & Automatic Pump Logic
 */
async function evaluateWaterLogic() {
  const level = state.sensor.waterLevelPercent;

  if (level === null || level === undefined) {
    state.sensor.status = 'NOT_AVAILABLE';
    state.sensor.currentLiters = null;
    return;
  }

  state.sensor.currentLiters = Math.round((level / 100) * state.sensor.tankCapacityLiters);

  if (level >= state.thresholds.overflowPercent) {
    state.sensor.status = 'OVERFLOW';
  } else if (level >= state.thresholds.fullPercent) {
    state.sensor.status = 'FULL';
  } else if (level <= state.thresholds.lowPercent) {
    state.sensor.status = 'LOW';
  } else {
    state.sensor.status = 'NORMAL';
  }

  if (level >= state.thresholds.overflowPercent) {
    state.buzzer.active = true;
    state.buzzer.reason = 'EMERGENCY OVERFLOW RISK';
    if (state.pump.status !== 'OFF') {
      state.pump.status = 'OFF';
      state.pump.lastStateChange = Date.now();
      await logActivity('Emergency Safety Shutoff', `Pump forced OFF due to overflow condition (${level}% >= ${state.thresholds.overflowPercent}%)`, 'danger', 'alert');
    }
    if (!state.inEmergencyCondition) {
      state.inEmergencyCondition = true;
      triggerEmergencyAlert(state, `Water level breached emergency threshold (${level}% >= ${state.thresholds.overflowPercent}%). Emergency safety pump shutoff executed.`).catch(console.error);
    }
  } else {
    state.inEmergencyCondition = false;
    if (level <= state.thresholds.lowPercent && !state.buzzer.muted) {
      state.buzzer.active = true;
      state.buzzer.reason = 'LOW WATER ALARM';
    } else {
      state.buzzer.active = false;
      state.buzzer.reason = null;
    }
  }

  if (state.pump.mode === 'AUTO') {
    if (level <= state.thresholds.lowPercent && state.pump.status !== 'ON') {
      state.pump.status = 'ON';
      state.pump.lastStateChange = Date.now();
      state.pump.lastActivationTime = new Date().toLocaleTimeString();
      state.pump.activationsToday++;
      await logActivity('Pump Started', `Auto-fill triggered: Water level ${level}% <= Low threshold (${state.thresholds.lowPercent}%)`, 'success', 'play');
    } else if (level >= state.thresholds.fullPercent && state.pump.status !== 'OFF') {
      state.pump.status = 'OFF';
      state.pump.lastStateChange = Date.now();
      await logActivity('Pump Stopped', `Auto-fill complete: Water level ${level}% >= Full threshold (${state.thresholds.fullPercent}%)`, 'info', 'stop');
    }
  }
}

/**
 * Process Incoming Real Telemetry Data Packet
 */
async function processTelemetry(data) {
  const { deviceId = 'ESP32-001', waterLevelPercent, distanceCm, wifiRssi, temp, humidity, pumpStatus, ipAddress, macAddress, uptime, firmware } = data;

  if (waterLevelPercent !== undefined && (isNaN(waterLevelPercent) || waterLevelPercent < 0 || waterLevelPercent > 100)) {
    throw { status: 400, message: 'Invalid telemetry: waterLevelPercent must be between 0 and 100.' };
  }

  const db = getDb();
  const wasConnected = state.esp32.connected;
  const nowIso = new Date().toISOString();

  state.esp32.connected = true;
  state.esp32.lastSeen = Date.now();

  if (wifiRssi !== undefined) state.esp32.wifiRssi = wifiRssi;
  if (ipAddress !== undefined) state.esp32.ipAddress = ipAddress;
  if (macAddress !== undefined) state.esp32.macAddress = macAddress;
  if (uptime !== undefined) state.esp32.uptime = uptime;
  if (firmware !== undefined) state.esp32.firmware = firmware;

  if (waterLevelPercent !== undefined) {
    state.sensor.waterLevelPercent = Math.min(100, Math.max(0, Math.round(waterLevelPercent)));
    state.sensor.currentLiters = Math.round((state.sensor.waterLevelPercent / 100) * state.sensor.tankCapacityLiters);
  }
  if (distanceCm !== undefined) state.sensor.distanceCm = distanceCm;
  if (temp !== undefined) state.systemHealth.temperature = temp;
  if (humidity !== undefined) state.systemHealth.humidity = humidity;

  state.sensor.lastReading = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (pumpStatus !== undefined) {
    state.pump.status = pumpStatus;
  }

  await db.run(
    `UPDATE devices SET connection_status = 'Connected', last_seen = ?, ip_address = COALESCE(?, ip_address), mac_address = COALESCE(?, mac_address), wifi_rssi = COALESCE(?, wifi_rssi), uptime = COALESCE(?, uptime), firmware_version = COALESCE(?, firmware_version), updated_at = ? WHERE device_id = ?`,
    [nowIso, ipAddress || null, macAddress || null, wifiRssi || null, uptime || null, firmware || null, nowIso, deviceId]
  );

  if (!wasConnected) {
    await logActivity('ESP32 Connected', 'Hardware telemetry link established with ESP32 node', 'success', 'wifi', deviceId);
  }

  await db.run(
    `INSERT INTO telemetry (device_id, sensor_value, water_level_percentage, pump_status, pump_mode, buzzer_status, temperature, humidity, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      deviceId,
      distanceCm !== undefined ? distanceCm : null,
      state.sensor.waterLevelPercent,
      state.pump.status,
      state.pump.mode,
      state.buzzer.active ? 'ALARM' : 'QUIET',
      state.systemHealth.temperature,
      state.systemHealth.humidity,
      nowIso
    ]
  );

  await evaluateWaterLogic();
  await broadcastState();

  return {
    success: true,
    connected: true,
    pumpMode: state.pump.mode,
    targetPumpStatus: state.pump.status,
    buzzerActive: state.buzzer.active,
    thresholds: state.thresholds
  };
}

/**
 * Start 10-Second Hardware Heartbeat Watchdog
 */
function startHeartbeatWatchdog() {
  setInterval(async () => {
    let db;
    try {
      db = getDb();
    } catch (e) {
      return;
    }
    if (!state.esp32.lastSeen) {
      if (state.esp32.connected) {
        state.esp32.connected = false;
        state.sensor.status = 'NOT_AVAILABLE';
        state.pump.status = 'Not Available';
        await db.run("UPDATE devices SET connection_status = 'Disconnected' WHERE device_id = 'ESP32-001'");
        await broadcastState();
      }
      return;
    }

    const elapsed = Date.now() - state.esp32.lastSeen;
    const previousConnection = state.esp32.connected;

    if (elapsed > 10000) {
      state.esp32.connected = false;
      state.sensor.status = 'NOT_AVAILABLE';
      state.pump.status = 'Not Available';

      if (previousConnection) {
        await db.run("UPDATE devices SET connection_status = 'Disconnected' WHERE device_id = 'ESP32-001'");
        await logActivity('ESP32 Disconnected', 'No heartbeat received from hardware sensor node for >10s', 'danger', 'wifi-off');
        sendEventNotification('ESP32 Disconnected', 'No heartbeat received from hardware sensor node for >10 seconds', 'warning', EVENT_CATEGORIES.SYSTEM_EVENTS).catch(console.error);
        await broadcastState();
      }
    }
  }, 3000);
}

function getState() {
  return state;
}

module.exports = {
  state,
  getState,
  setWebSocketServer,
  loadPersistedConfig,
  logActivity,
  broadcastState,
  evaluateWaterLogic,
  processTelemetry,
  startHeartbeatWatchdog,
  determineCategory
};
