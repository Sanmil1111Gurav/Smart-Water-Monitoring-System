require('dotenv').config();
console.log('[SERVER INIT]', { PID: process.pid, timestamp: new Date().toISOString() });
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const { initDatabase, getDb } = require('./database');
const { sendDailyDigest, getPreviousCompletedDateString } = require('./services/emailService');
const telemetryService = require('./services/telemetryService');

const authRoutes = require('./routes/authRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
const telemetryRoutes = require('./routes/telemetryRoutes');
const historyRoutes = require('./routes/historyRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const settingsRoutes = require('./routes/settingsRoutes');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mount Modular API Routes
app.use('/api/auth', authRoutes);
app.use('/api', deviceRoutes);
app.use('/api', telemetryRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api', settingsRoutes);

// Connect WebSocket Server Instance to Telemetry Service
telemetryService.setWebSocketServer(wss);

wss.on('connection', async (ws) => {
  const stateObj = telemetryService.getState();
  console.log('[WS INITIAL STATE]', {
    PID: process.pid,
    timestamp: new Date().toISOString(),
    statePumpMode: stateObj.pump.mode,
    payloadPumpMode: stateObj.pump.mode
  });
  await telemetryService.broadcastState();

  ws.on('message', async (message) => {
    try {
      const parsed = JSON.parse(message);
      console.log('[WS RECEIVED]', parsed);
      if (parsed.type === 'PUMP_CONTROL') {
        const { mode, status } = parsed;
        const state = telemetryService.getState();
        const db = getDb();
        const nowIso = new Date().toISOString();

        if (mode && (mode === 'AUTO' || mode === 'MANUAL')) {
          telemetryService.setPumpMode(mode, 'WebSocket PUMP_CONTROL message');
          await db.run('UPDATE configuration SET pump_mode = ?, updated_at = ? WHERE id = 1', [mode, nowIso]);
        }
        if (status && state.pump.mode === 'MANUAL') {
          state.pump.status = status;
        }
        await telemetryService.evaluateWaterLogic();
        await telemetryService.broadcastState();
      }
    } catch (err) {
      console.error('Error parsing WS message:', err);
    }
  });
});

// Server-side Daily Digest Scheduler (Runs at 08:00 Asia/Kolkata for previous completed day)
function startDailyDigestScheduler() {
  const digestHour = parseInt(process.env.DAILY_DIGEST_HOUR || '8', 10);
  const digestMinute = parseInt(process.env.DAILY_DIGEST_MINUTE || '0', 10);
  const timezone = process.env.TIMEZONE || 'Asia/Kolkata';

  console.log(`⏰ Daily Digest Scheduler active. Configured target time: ${digestHour.toString().padStart(2, '0')}:${digestMinute.toString().padStart(2, '0')} (${timezone})`);

  let lastRunDateStr = null;

  setInterval(async () => {
    try {
      const now = new Date();
      const options = { timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit' };
      const timeParts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
      const curHour = parseInt(timeParts.find(p => p.type === 'hour').value, 10);
      const curMinute = parseInt(timeParts.find(p => p.type === 'minute').value, 10);

      const yOptions = { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' };
      const [{ value: month },,{ value: day },,{ value: year }] = new Intl.DateTimeFormat('en-US', yOptions).formatToParts(now);
      const currentDateStr = `${year}-${month}-${day}`;

      if (curHour === digestHour && curMinute === digestMinute && lastRunDateStr !== currentDateStr) {
        lastRunDateStr = currentDateStr;
        console.log(`⏰ Daily Digest Scheduler executing...`);
        await sendDailyDigest(null, null);
      }
    } catch (err) {
      console.error('Error in Daily Digest Scheduler tick:', err);
    }
  }, 60000);
}

const PORT = process.env.PORT || 5000;

async function startServer() {
  await initDatabase();
  await telemetryService.loadPersistedConfig();
  telemetryService.startHeartbeatWatchdog();
  startDailyDigestScheduler();

  server.listen(PORT, () => {
    console.log('[STARTUP] HTTP server ready');
    console.log('[STARTUP] WebSocket ready');
    console.log('[STARTUP] telemetry processing ready');
    console.log(`====================================================`);
    console.log(`💧 ESP32 Water Level & Pump Control Server Running `);
    console.log(`🗄️ Database Persistent Storage: SQLite (water_monitoring.db)`);
    console.log(`🌐 Dashboard UI: http://localhost:${PORT}`);
    console.log(`📡 WebSocket API: ws://localhost:${PORT}/ws`);
    console.log(`====================================================`);
  });
}

startServer().catch(err => {
  console.error('Failed starting server:', err);
});
