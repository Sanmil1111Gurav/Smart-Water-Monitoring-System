const { getDb } = require('../database');
const { triggerEmergencyAlert, sendEventNotification } = require('./emailService');
const { EVENT_CATEGORIES } = require('../utils/constants');

console.log('[STARTUP] telemetryService state initialized', { PID: process.pid, timestamp: new Date().toISOString() });


let isConfigLoaded = false;

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
    deviceName: 'Water Level Sensor',
    waterLevelPercent: null,
    sensorValue: null,
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
 * Helper to get start and end ISO strings for a calendar date in a specific timezone
 */
function getTimezoneDayBoundaries(dateStr, timeZone = 'Asia/Kolkata') {
  const [year, month, day] = dateStr.split('-').map(Number);
  const estimateUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const getOffsetMs = (date) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(date);
    const p = {};
    parts.forEach(pt => { p[pt.type] = pt.value; });
    const hour = +p.hour === 24 ? 0 : +p.hour;
    const localDate = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second));
    return localDate.getTime() - date.getTime();
  };
  const offsetMs = getOffsetMs(estimateUtc);
  const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMs;
  const endUtcMs = Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offsetMs;
  return {
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(endUtcMs).toISOString(),
    startMs: startUtcMs,
    endMs: endUtcMs
  };
}

/**
 * Calculate Today's Water Usage in Liters from Telemetry
 */
let lastCalcTime = 0;
let cachedCalcResult = null;

async function calculateTodayUsageLiters(timezone = 'Asia/Kolkata') {
  if (Date.now() - lastCalcTime < 5000) {
    return cachedCalcResult;
  }
  
  try {
    const db = getDb();
    const now = new Date();
    const options = { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' };
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
    const p = {};
    parts.forEach(pt => { p[pt.type] = pt.value; });
    const todayStr = `${p.year}-${p.month}-${p.day}`;

    const bounds = getTimezoneDayBoundaries(todayStr, timezone);
    const rawRows = await db.all(
      'SELECT pump_status, timestamp FROM telemetry WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC',
      [bounds.startIso, bounds.endIso]
    );

    const rows = rawRows.filter(r => {
      const tsMs = new Date(r.timestamp).getTime();
      return !isNaN(tsMs) && tsMs >= bounds.startMs && tsMs <= bounds.endMs;
    });

    if (rows.length === 0) {
      console.log("Today's Usage Calculation");
      console.log(`Date: ${todayStr}`);
      console.log(`Timezone: ${timezone}`);
      console.log("Telemetry readings found: 0");
      state.usageStats.todayLiters = null;
      return null;
    }

    let totalRuntimeMs = 0;
    let activations = 0;
    let lastOnTimestamp = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ts = new Date(row.timestamp).getTime();
      if (isNaN(ts)) continue; // skip malformed timestamps

      if (row.pump_status === 'ON') {
        if (lastOnTimestamp === null) {
          // pump just turned ON
          lastOnTimestamp = ts;
          activations++;
        } else {
          const delta = ts - lastOnTimestamp;
          if (delta > 0 && delta <= 5 * 60 * 1000) {
            totalRuntimeMs += delta;
          }
          lastOnTimestamp = ts; // update to current ON timestamp
        }
      } else { // pump OFF
        if (lastOnTimestamp !== null) {
          const delta = ts - lastOnTimestamp;
          if (delta > 0 && delta <= 5 * 60 * 1000) {
            totalRuntimeMs += delta;
          }
          lastOnTimestamp = null;
        }
      }
    }

    const { WATER_FLOW_RATE_LPM } = require('../utils/config');
    const runtimeMinutes = totalRuntimeMs / 60000;
    const calculatedLiters = Math.round(runtimeMinutes * WATER_FLOW_RATE_LPM);

    console.log("Today's Usage Calculation (Runtime-Based)");
    console.log(`Date: ${todayStr}`);
    console.log(`Timezone: ${timezone}`);
    console.log(`Telemetry readings found: ${rows.length}`);
    console.log(`Activations: ${activations}`);
    console.log(`Runtime Minutes: ${Math.round(runtimeMinutes * 10) / 10}`);
    console.log(`Estimated consumption: ${calculatedLiters} L`);

    state.usageStats.todayLiters = calculatedLiters;
    state.pump.runtimeMinutesToday = Math.round(runtimeMinutes * 10) / 10;
    state.pump.activationsToday = activations;

    lastCalcTime = Date.now();
    cachedCalcResult = calculatedLiters;
    
    return calculatedLiters;
  } catch (err) {
    console.error("Error calculating today's usage liters:", err);
    return state.usageStats.todayLiters;
  }
}

/**
 * Centralized Authoritative Pump Mode Modifier with Global Trace
 */
function setPumpMode(newMode, source) {
  if (newMode !== 'AUTO' && newMode !== 'MANUAL') return;
  const prevMode = state.pump.mode;
  state.pump.mode = newMode;
  console.log(`[PUMP MODE CHANGE] ${prevMode} -> ${newMode} | SOURCE: ${source}`);
}

/**
 * Load Persisted Configuration from DB into State Cache
 */
async function loadPersistedConfig() {
  console.log('[STARTUP] loading persisted configuration');
  try {
    const db = getDb();
    const configRow = await db.get('SELECT * FROM configuration WHERE id = 1');
    if (configRow) {
      console.log(`[STARTUP] SQLite pump_mode = ${configRow.pump_mode}`);
      state.thresholds.lowPercent = configRow.low_water_threshold;
      state.thresholds.fullPercent = configRow.full_water_threshold;
      state.thresholds.overflowPercent = configRow.emergency_overflow_threshold;
      state.thresholds.maxPumpTimeoutMinutes = configRow.max_pump_timeout_minutes;
      state.sensor.tankCapacityLiters = configRow.tank_capacity_liters;
      setPumpMode(configRow.pump_mode, 'loadPersistedConfig() startup — SQLite authoritative');
      state.buzzer.enabled = Boolean(configRow.buzzer_enabled);
      console.log(`[STARTUP] runtime pump mode = ${state.pump.mode}`);
    }
    await calculateTodayUsageLiters();
    isConfigLoaded = true;
    console.log('[STARTUP] configuration loaded');
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
        state.sensor.sensorValue,
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
      sensorValue: e.distance_cm !== undefined ? e.distance_cm : null,
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

    await calculateTodayUsageLiters();

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
    state.buzzer.active = false;
    state.buzzer.reason = null;
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
  const { deviceId = 'ESP32-001', waterLevelPercent, sensorValue, distanceCm, wifiRssi, temp, humidity, pumpStatus, pumpMode, buzzerStatus, lowThreshold, fullThreshold, emergencyThreshold, ipAddress, macAddress, uptime, firmware } = data;

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
  
  const rawVal = sensorValue !== undefined ? sensorValue : distanceCm;
  if (rawVal !== undefined) state.sensor.sensorValue = rawVal;

  if (temp !== undefined) state.systemHealth.temperature = temp;
  if (humidity !== undefined) state.systemHealth.humidity = humidity;

  state.sensor.lastReading = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (pumpMode !== undefined) {
    console.log(`[TELEMETRY] ESP32 reported pumpMode: ${pumpMode}`);
    console.log(`[TELEMETRY] Backend authoritative pump mode: ${state.pump.mode}`);
    console.log(`[TELEMETRY] Ignoring telemetry pumpMode for mode selection`);
  }

  if (pumpStatus !== undefined) {
    if (state.pump.mode === 'AUTO') {
      state.pump.status = pumpStatus;
    } else {
      console.log(`[TELEMETRY] Ignoring telemetry pumpStatus (${pumpStatus}) because backend is in MANUAL mode. Keeping backend status: ${state.pump.status}`);
    }
  }
  if (buzzerStatus !== undefined) {
    state.buzzer.active = (buzzerStatus === 'ALARM');
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
      state.sensor.sensorValue !== null ? state.sensor.sensorValue : null,
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
  setPumpMode,
  calculateTodayUsageLiters,
  setWebSocketServer,
  loadPersistedConfig,
  logActivity,
  broadcastState,
  evaluateWaterLogic,
  processTelemetry,
  startHeartbeatWatchdog,
  determineCategory
};
