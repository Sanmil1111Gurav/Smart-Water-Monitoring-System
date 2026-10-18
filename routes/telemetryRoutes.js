const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const telemetryService = require('../services/telemetryService');
const { requireAuth } = require('../middleware/auth');

// Get System Status Endpoint
router.get('/status', async (req, res) => {
  try {
    const db = getDb();
    const configRow = await db.get('SELECT pump_mode FROM configuration WHERE id = 1');
    const modeBefore = telemetryService.getState().pump.mode;
    await telemetryService.calculateTodayUsageLiters();
    const state = telemetryService.getState();
    const modeAfter = state.pump.mode;

    console.log('[STATUS REQUEST]', {
      PID: process.pid,
      timestamp: new Date().toISOString(),
      statePumpModeBefore: modeBefore,
      sqlitePumpMode: configRow?.pump_mode,
      statePumpModeAfter: modeAfter,
      responsePumpMode: state.pump.mode
    });

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
      icon: e.category === 'Alarm Events' ? 'alert' : (e.category === 'Pump Events' ? 'play' : 'info')
    }));

    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const { JWT_SECRET } = require('../middleware/auth');
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
      } catch (e) {}
    }

    let notifications = [];
    if (userId) {
      const notificationService = require('../services/notificationService');
      const userNotifData = await notificationService.getUserNotifications(userId, state);
      notifications = userNotifData.notifications;
    }

    res.json({ state, history, activityLogs, notifications });
  } catch (err) {
    console.error('Error fetching /api/status:', err);
    res.status(500).json({ success: false, error: 'Database fetch error.' });
  }
});

// Hardware Telemetry Ingestion Endpoint
router.post('/telemetry', async (req, res) => {
  try {
    const result = await telemetryService.processTelemetry(req.body);
    res.json(result);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ success: false, error: err.message || 'Error processing telemetry.' });
  }
});

// Pump Control Endpoint
router.post('/pump/control', requireAuth, async (req, res) => {
  const { mode, status } = req.body;
  const db = getDb();
  const state = telemetryService.getState();
  const nowIso = new Date().toISOString();

  if (mode !== undefined && (mode === 'AUTO' || mode === 'MANUAL')) {
    telemetryService.setPumpMode(mode, '/api/pump/control HTTP POST');
    await db.run('UPDATE configuration SET pump_mode = ?, updated_at = ? WHERE id = 1', [mode, nowIso]);
    await telemetryService.logActivity('Pump Mode Changed', `Switched pump control mode to ${mode}`, 'warning', 'sliders');
  }

  if (status !== undefined && (status === 'ON' || status === 'OFF')) {
    if (state.pump.mode === 'MANUAL') {
      state.pump.status = status;
      state.pump.lastStateChange = Date.now();
      state.pump.lastActivationTime = new Date().toLocaleTimeString();
      if (status === 'ON') state.pump.activationsToday++;
      await telemetryService.logActivity(
        `Manual Pump ${status}`,
        `Pump manually requested ${status} via dashboard`,
        status === 'ON' ? 'success' : 'info',
        status === 'ON' ? 'play' : 'stop'
      );
    } else {
      return res.status(400).json({ success: false, error: 'Cannot manually override pump while in AUTO mode. Switch to MANUAL first.' });
    }
  }

  await telemetryService.evaluateWaterLogic();
  await telemetryService.broadcastState();

  res.json({ success: true, pump: state.pump });
});

// Mute/Unmute Buzzer Endpoint
router.post('/buzzer/mute', async (req, res) => {
  const state = telemetryService.getState();
  state.buzzer.muted = !state.buzzer.muted;
  await telemetryService.logActivity('Buzzer Sound', state.buzzer.muted ? 'Buzzer audio muted' : 'Buzzer audio unmuted', 'info', 'bell');
  await telemetryService.broadcastState();

  res.json({ success: true, buzzer: state.buzzer });
});

module.exports = router;
