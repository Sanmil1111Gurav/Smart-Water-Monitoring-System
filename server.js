require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { initDatabase, getDb } = require('./database');
const { sendUserEmail, triggerEmergencyAlert, sendEventNotification, sendDailyDigest, getPreviousCompletedDateString } = require('./services/emailService');

const JWT_SECRET = process.env.JWT_SECRET || 'smartwater_jwt_secret_key_2026';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Real-Time State Cache
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
  }
};

// Centralized Event-to-Category Mapper Function
function determineCategory(eventName, rawCategory) {
  if (rawCategory === 'Sensor Readings' || rawCategory === 'Pump Events' || rawCategory === 'Alarm Events' || rawCategory === 'System Events') {
    return rawCategory;
  }
  const evt = (eventName || '').toLowerCase();
  const cat = (rawCategory || '').toLowerCase();

  if (
    cat === 'alarm' || cat === 'alarm events' ||
    evt.includes('alarm') || evt.includes('low water') || evt.includes('tank full') ||
    evt.includes('emergency') || evt.includes('overflow') || evt.includes('threshold exceeded')
  ) {
    return 'Alarm Events';
  }

  if (
    cat === 'pump' || cat === 'pump events' ||
    evt.includes('pump') || evt.includes('motor') || evt.includes('auto-fill')
  ) {
    return 'Pump Events';
  }

  if (
    cat === 'system' || cat === 'system events' ||
    evt.includes('esp32') || evt.includes('connected') || evt.includes('disconnected') ||
    evt.includes('wifi') || evt.includes('reboot') || evt.includes('config') || evt.includes('setting') || evt.includes('mode changed')
  ) {
    return 'System Events';
  }

  return 'Sensor Readings';
}

// Load Persisted Configuration from DB into State Cache
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

// Log Event to DB & Notify Clients
async function logActivity(title, desc, type = 'info', icon = 'info', deviceId = 'ESP32-001') {
  const category = determineCategory(title);
  const timeStr = new Date().toLocaleTimeString();
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

    // Create persistent Notification for Alarm Events or Disconnected events
    if (category === 'Alarm Events' || title.includes('Disconnected') || title.includes('Safety')) {
      const severity = category === 'Alarm Events' ? (title.includes('Overflow') ? 'critical' : 'warning') : 'info';
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

// Broadcast real-time state to connected WebSocket clients
async function broadcastState() {
  try {
    const db = getDb();

    // Fetch latest 50 events for history preview
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

    // Fetch activity logs (latest 5 real events)
    const activityLogs = dbEvents.slice(0, 5).map(e => ({
      id: e.id,
      time: new Date(e.timestamp).toLocaleTimeString(),
      title: e.event,
      desc: e.details,
      type: e.status || 'info',
      icon: e.category === 'Alarm Events' ? 'alert' : (e.category === 'Pump Events' ? 'play' : 'info')
    }));

    // Fetch active notifications
    const dbNotifications = await db.all('SELECT * FROM notifications ORDER BY id DESC LIMIT 20');
    const notifications = dbNotifications.map(n => ({
      id: n.id,
      title: n.title,
      message: n.message,
      severity: n.severity,
      timestamp: new Date(n.timestamp).getTime(),
      dateStr: new Date(n.timestamp).toLocaleString(),
      read: Boolean(n.acknowledged),
      active: !n.acknowledged
    }));

    const payload = JSON.stringify({
      type: 'TELEMETRY_UPDATE',
      data: {
        ...state,
        history,
        activityLogs,
        notifications
      }
    });

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  } catch (err) {
    console.error('Error building WebSocket state payload:', err);
  }
}

// Evaluate Water Threshold Logic
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

  // Transition-based Emergency Overflow Safety Shutoff Alert
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

  // Automatic Pump Control
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

// Heartbeat & Connection Watchdog (10s Timeout)
setInterval(async () => {
  let db;
  try {
    db = getDb();
  } catch (e) {
    return; // DB not initialized yet
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
      sendEventNotification('ESP32 Disconnected', 'No heartbeat received from hardware sensor node for >10 seconds', 'warning', 'System Events').catch(console.error);
      await broadcastState();
    }
  }
}, 3000);

// Strict Threshold Validation Helper
function validateThresholdValues(low, full, overflow) {
  if (isNaN(low) || isNaN(full) || isNaN(overflow)) {
    return { valid: false, message: 'All threshold values must be numeric numbers.' };
  }
  if (low < 0 || low > 100 || full < 0 || full > 100 || overflow < 0 || overflow > 100) {
    return { valid: false, message: 'Value must be between 0 and 100%.' };
  }
  if (low >= full || full > overflow) {
    return { valid: false, message: 'Thresholds must follow: Low < Full ≤ Emergency.' };
  }
  return { valid: true };
}

// Authentication Middleware for Protected Admin Endpoints
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Authentication token required.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized. Invalid or expired authentication token.' });
  }
}

// Password Complexity Validation Helper
function validatePasswordComplexity(password) {
  if (!password || password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long.' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter.' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter.' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number.' };
  }
  return { valid: true };
}

// RFC 5322 Standard Email Validation Helper
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[a-zA-Z0-9._%+-]+@([a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}$/;
  return emailRegex.test(email.trim());
}

const IS_DEV_MODE = process.env.NODE_ENV !== 'production' && process.env.DEVELOPMENT !== 'false';

// --- AUTHENTICATION ENDPOINTS ---

// Get Authentication & Development Mode Configuration
app.get('/api/auth/config', (req, res) => {
  res.json({
    isDevMode: IS_DEV_MODE,
    devCredentials: null
  });
});

// Check Setup Status (Initial setup vs active system)
app.get('/api/auth/setup-status', async (req, res) => {
  try {
    const db = getDb();
    const countRow = await db.get('SELECT COUNT(*) as count FROM users');
    res.json({
      isInitialSetup: countRow.count === 0,
      initialSetupRequired: countRow.count === 0,
      userCount: countRow.count,
      isDevMode: IS_DEV_MODE
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error checking setup status.' });
  }
});

// User Registration Endpoint
app.post('/api/auth/register', async (req, res) => {
  const { name, username, email, password, confirmPassword } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'Please enter a username.' });
  }
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Please enter a password.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const passVal = validatePasswordComplexity(password);
  if (!passVal.valid) {
    return res.status(400).json({ error: 'Password does not meet the required security requirements.' });
  }

  try {
    const db = getDb();

    // Check if username is already taken
    const existingUsername = await db.get('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (existingUsername) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    // Check if email is already registered
    const existingEmail = await db.get('SELECT id FROM users WHERE email = ?', [email.trim()]);
    if (existingEmail) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    // Newly registered users receive standard 'user' role by default (not 'admin')
    const userRole = 'user';

    await db.run(
      'INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), email.trim(), username.trim(), passwordHash, userRole]
    );

    res.status(201).json({
      success: true,
      message: 'Account created successfully! You can now sign in with your credentials.'
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error during account registration.' });
  }
});

// Admin Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const db = getDb();
    const user = await db.get('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username, name: user.name || user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, name: user.name || user.username, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server authentication error.' });
  }
});

// Forgot Password Endpoint (Generates 6-digit OTP and dispatches reset email)
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    const db = getDb();
    const user = await db.get('SELECT id, username, email FROM users WHERE email = ?', [email.trim()]);

    if (user) {
      const crypto = require('crypto');
      // Generate cryptographically secure 6-digit OTP
      const randomBuf = crypto.randomBytes(4);
      const otpNum = (randomBuf.readUInt32BE(0) % 900000) + 100000;
      const otp = otpNum.toString();

      const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes expiration

      await db.run(
        'UPDATE users SET reset_otp_hash = ?, reset_otp_expires_at = ?, reset_otp_attempts = 0, reset_otp_verified = 0 WHERE id = ?',
        [otpHash, expiresAt, user.id]
      );

      const emailSubject = 'SmartWater System - Password Reset OTP';
      const emailText = `Hello ${user.username},\n\nWe received a request to reset your Smart Water Monitoring & Control System account.\n\nYour password reset OTP is:\n${otp}\n\nThis OTP expires in 10 minutes.\n\nIf you did not request this password reset, you can ignore this email.`;
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff;">
          <h2 style="color: #0284c7; margin-bottom: 16px;">Password Reset OTP</h2>
          <p style="color: #334155; font-size: 15px; line-height: 1.5;">Hello <strong>${user.username}</strong>,</p>
          <p style="color: #334155; font-size: 15px; line-height: 1.5;">We received a request to reset your Smart Water Monitoring & Control System account password.</p>
          <div style="margin: 24px 0; text-align: center; background-color: #f1f5f9; padding: 16px; border-radius: 8px; letter-spacing: 6px;">
            <span style="font-size: 32px; font-weight: bold; color: #0284c7;">${otp}</span>
          </div>
          <p style="color: #64748b; font-size: 14px; line-height: 1.5;">This OTP is valid for <strong>10 minutes</strong>. Do not share this code with anyone.</p>
          <p style="color: #94a3b8; font-size: 12px; margin-top: 24px; border-top: 1px solid #f1f5f9; padding-top: 12px;">If you did not request this password reset, you can safely ignore this email.</p>
        </div>
      `;

      const emailResult = await sendUserEmail({
        userId: user.id,
        userEmail: user.email,
        subject: emailSubject,
        text: emailText,
        html: emailHtml,
        category: 'ACCOUNT',
        alertType: 'password_reset',
        severity: 'warning'
      });

      if (!emailResult.success) {
        console.error(`❌ Forgot password OTP email delivery failed for ${email}`);
        return res.status(500).json({
          error: "We couldn't send the reset instructions right now. Please try again later."
        });
      }
    }

    // Return generic success message to prevent user enumeration
    res.json({
      success: true,
      message: 'If an account exists for this email, a 6-digit OTP has been sent.'
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: "We couldn't send the reset instructions right now. Please try again later." });
  }
});

// Verify OTP Endpoint
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!otp || typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
    return res.status(400).json({ error: 'Please enter a valid 6-digit OTP.' });
  }

  try {
    const crypto = require('crypto');
    const otpHash = crypto.createHash('sha256').update(otp.trim()).digest('hex');

    const db = getDb();
    const user = await db.get(
      'SELECT id, reset_otp_hash, reset_otp_expires_at, reset_otp_attempts, reset_otp_verified FROM users WHERE email = ?',
      [email.trim()]
    );

    if (!user || !user.reset_otp_hash) {
      return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new code.' });
    }

    // Rate limiting: Maximum 5 attempts
    if (user.reset_otp_attempts >= 5) {
      await db.run('UPDATE users SET reset_otp_hash = NULL WHERE id = ?', [user.id]);
      return res.status(400).json({ error: 'Maximum verification attempts exceeded. Please request a new OTP.' });
    }

    // Check expiration
    if (!user.reset_otp_expires_at || new Date(user.reset_otp_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new code.' });
    }

    // Check hash match
    if (user.reset_otp_hash !== otpHash) {
      await db.run('UPDATE users SET reset_otp_attempts = reset_otp_attempts + 1 WHERE id = ?', [user.id]);
      const remaining = 5 - (user.reset_otp_attempts + 1);
      return res.status(400).json({ error: `Invalid OTP code. ${remaining > 0 ? `${remaining} attempt(s) remaining.` : 'Please request a new code.'}` });
    }

    // Mark as verified
    await db.run('UPDATE users SET reset_otp_verified = 1 WHERE id = ?', [user.id]);

    res.json({ success: true, message: 'OTP verified successfully! You can now set your new password.' });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Server error verifying OTP.' });
  }
});

// Reset Password Endpoint (via Verified OTP or legacy Token)
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, otp, token, newPassword, confirmPassword } = req.body;

  if (!newPassword) {
    return res.status(400).json({ error: 'Please enter a new password.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const passVal = validatePasswordComplexity(newPassword);
  if (!passVal.valid) {
    return res.status(400).json({ error: passVal.message });
  }

  try {
    const crypto = require('crypto');
    const db = getDb();
    let targetUserId = null;

    if (email && otp) {
      const otpHash = crypto.createHash('sha256').update(otp.trim()).digest('hex');
      const user = await db.get(
        'SELECT id, reset_otp_hash, reset_otp_expires_at, reset_otp_verified FROM users WHERE email = ?',
        [email.trim()]
      );

      if (!user || !user.reset_otp_hash || user.reset_otp_hash !== otpHash || !user.reset_otp_verified) {
        return res.status(400).json({ error: 'Invalid, unverified, or expired OTP session. Please request a new code.' });
      }

      if (new Date(user.reset_otp_expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: 'OTP has expired. Please request a new code.' });
      }

      targetUserId = user.id;
    } else if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const user = await db.get(
        'SELECT id, reset_token_expires_at, reset_token_used FROM users WHERE reset_token_hash = ?',
        [tokenHash]
      );

      if (!user || user.reset_token_used) {
        return res.status(400).json({ error: 'Invalid or expired password reset token.' });
      }

      if (new Date(user.reset_token_expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: 'Password reset token has expired. Please request a new link.' });
      }

      targetUserId = user.id;
    } else {
      return res.status(400).json({ error: 'OTP or reset token is required.' });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    const nowIso = new Date().toISOString();

    // Invalidate OTP and token upon successful password update
    await db.run(
      `UPDATE users 
       SET password_hash = ?, 
           reset_token_used = 1, 
           reset_otp_hash = NULL, 
           reset_otp_expires_at = NULL, 
           reset_otp_verified = 0, 
           updated_at = ? 
       WHERE id = ?`,
      [newPasswordHash, nowIso, targetUserId]
    );

    res.json({ success: true, message: 'Password reset successfully! You can now sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error resetting password.' });
  }
});

app.get('/api/auth/verify', requireAuth, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Change Password Endpoint (Protected for logged in user with admin/developer authorization)
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'developer')) {
    return res.status(403).json({ error: 'Forbidden. Admin authorization required to change password.' });
  }

  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'All password fields are required.' });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'New passwords do not match.' });
  }

  const passVal = validatePasswordComplexity(newPassword);
  if (!passVal.valid) {
    return res.status(400).json({ error: 'Password does not meet the required security requirements.' });
  }

  try {
    const db = getDb();
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.userId]);
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    if (user.role !== 'admin' && user.role !== 'developer') {
      return res.status(403).json({ error: 'Forbidden. Admin authorization required to change password.' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Incorrect current password.' });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    const nowIso = new Date().toISOString();

    await db.run(
      'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
      [newPasswordHash, nowIso, user.id]
    );

    res.json({ success: true, message: 'Password updated successfully!' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error updating password.' });
  }
});

// --- NOTIFICATION & USER PROFILE ENDPOINTS ---

// Get User Notification Preferences Endpoint
app.get('/api/notifications/preferences', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const user = await db.get('SELECT email, email_notifications, emergency_alerts, daily_digest, telegram_enabled, sms_enabled FROM users WHERE id = ?', [req.user.userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const emailNotifications = Boolean(user.email_notifications ?? 1);
    const emergencyAlerts = Boolean(user.emergency_alerts ?? 1);
    const dailyDigest = Boolean(user.daily_digest ?? 1);

    res.json({
      email: user.email,
      emailNotifications,
      emergencyAlerts,
      dailyDigest,
      email_notifications: emailNotifications,
      emergency_alerts: emergencyAlerts,
      daily_digest: dailyDigest,
      telegramEnabled: Boolean(user.telegram_enabled ?? 0),
      smsEnabled: Boolean(user.sms_enabled ?? 0)
    });
  } catch (err) {
    console.error('Error fetching notification preferences:', err);
    res.status(500).json({ error: 'Server error fetching preferences.' });
  }
});

// Update User Notification Preferences Endpoint
app.post('/api/notifications/preferences', requireAuth, async (req, res) => {
  const emailNotifications = req.body.emailNotifications !== undefined ? req.body.emailNotifications : req.body.email_notifications;
  const emergencyAlerts = req.body.emergencyAlerts !== undefined ? req.body.emergencyAlerts : req.body.emergency_alerts;
  const dailyDigest = req.body.dailyDigest !== undefined ? req.body.dailyDigest : req.body.daily_digest;

  try {
    const db = getDb();
    await db.run(
      `UPDATE users SET
        email_notifications = ?,
        emergency_alerts = ?,
        daily_digest = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        emailNotifications ? 1 : 0,
        emergencyAlerts ? 1 : 0,
        dailyDigest ? 1 : 0,
        req.user.userId
      ]
    );

    res.json({
      success: true,
      message: 'Notification preferences updated successfully!',
      preferences: {
        emailNotifications: Boolean(emailNotifications),
        emergencyAlerts: Boolean(emergencyAlerts),
        dailyDigest: Boolean(dailyDigest)
      }
    });
  } catch (err) {
    console.error('Error saving notification preferences:', err);
    res.status(500).json({ error: 'Server error updating preferences.' });
  }
});

// Send Test Email to Authenticated User's Registered Email Endpoint
app.post('/api/notifications/test-email', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.userId]);
    if (!user) return res.status(404).json({ error: 'Authenticated user profile not found.' });

    const subject = 'Water Monitoring System - Test Email';
    const serverTime = new Date().toLocaleString();
    const text = `This is a test email from the Water Monitoring System.

Email notification service is configured successfully.

Recipient:
${user.email}

Time:
${serverTime}`;

    const html = `
      <div style="font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 12px; border: 1px solid #38bdf8;">
        <h2 style="color: #38bdf8; margin-top: 0;">Water Monitoring System - Test Email</h2>
        <p>This is a test email from the Water Monitoring System.</p>
        <p>Email notification service is configured successfully.</p>
        <div style="background: rgba(56, 189, 248, 0.15); border: 1px solid #38bdf8; padding: 12px 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>Recipient:</strong> ${user.email}</p>
          <p style="margin: 4px 0;"><strong>Time:</strong> ${serverTime}</p>
        </div>
      </div>
    `;

    const result = await sendUserEmail({
      userId: user.id,
      userEmail: user.email,
      subject,
      text,
      html,
      category: 'System Events',
      alertType: 'test_email',
      severity: 'info',
      eventType: 'test_dispatch'
    });

    res.json({
      success: result.success,
      message: result.success
        ? `Test email sent to registered recipient: ${user.email}`
        : `Failed to send test email: ${result.errorMessage || 'SMTP delivery failed'}`,
      recipientEmail: user.email,
      status: result.status,
      errorMessage: result.errorMessage || null,
      skipped: result.skipped || false
    });
  } catch (err) {
    console.error('Error dispatching test email:', err);
    res.status(500).json({ error: 'Server error sending test email.' });
  }
});

// Trigger Daily Digest Endpoint (Manual Trigger)
app.post('/api/notifications/digest', requireAuth, async (req, res) => {
  try {
    const result = await sendDailyDigest(req.user.userId, null, true);
    if (!result.success) {
      if (result.skipped) {
        return res.status(400).json({
          success: false,
          skipped: true,
          error: result.reason || result.message || 'Daily digest is disabled in your notification preferences.',
          status: 'SKIPPED'
        });
      }
      return res.status(500).json({
        success: false,
        status: 'FAILED',
        error: result.errorMessage || result.message || 'Failed to send daily digest via SMTP.'
      });
    }

    const firstRes = (result.results && result.results[0]) ? result.results[0] : result;
    if (firstRes.status === 'SENT') {
      return res.json({
        success: true,
        status: 'SENT',
        message: 'Daily digest sent successfully.',
        recipientEmail: firstRes.recipientEmail,
        digestDate: result.digestDate
      });
    } else {
      return res.status(500).json({
        success: false,
        status: 'FAILED',
        error: `Failed to send daily digest: ${firstRes.errorMessage || 'SMTP send operation failed'}`,
        recipientEmail: firstRes.recipientEmail,
        digestDate: result.digestDate
      });
    }
  } catch (err) {
    console.error('Error generating daily digest:', err);
    res.status(500).json({ success: false, status: 'FAILED', error: err.message || 'Server error generating daily digest.' });
  }
});

// Update User Profile (Name & Email Change)
app.post('/api/user/profile', requireAuth, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  try {
    const db = getDb();
    const existing = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email.trim(), req.user.userId]);
    if (existing) return res.status(400).json({ error: 'An account with this email address already exists.' });

    await db.run('UPDATE users SET name = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [name.trim(), email.trim(), req.user.userId]);
    res.json({ success: true, message: 'Profile updated successfully! Future notifications will be sent to ' + email.trim() });
  } catch (err) {
    console.error('Error updating user profile:', err);
    res.status(500).json({ error: 'Server error updating profile.' });
  }
});

// --- REST API ENDPOINTS ---

app.get('/api/status', async (req, res) => {
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
      icon: e.category === 'Alarm Events' ? 'alert' : (e.category === 'Pump Events' ? 'play' : 'info')
    }));

    const dbNotifications = await db.all('SELECT * FROM notifications ORDER BY id DESC LIMIT 20');
    const notifications = dbNotifications.map(n => ({
      id: n.id,
      title: n.title,
      message: n.message,
      severity: n.severity,
      timestamp: new Date(n.timestamp).getTime(),
      dateStr: new Date(n.timestamp).toLocaleString(),
      read: Boolean(n.acknowledged),
      active: !n.acknowledged
    }));

    res.json({ state, history, activityLogs, notifications });
  } catch (err) {
    console.error('Error fetching /api/status:', err);
    res.status(500).json({ error: 'Database fetch error.' });
  }
});

app.post('/api/telemetry', async (req, res) => {
  const { deviceId = 'ESP32-001', waterLevelPercent, distanceCm, wifiRssi, temp, humidity, pumpStatus, ipAddress, macAddress, uptime, firmware } = req.body;

  // Telemetry Validation
  if (waterLevelPercent !== undefined && (isNaN(waterLevelPercent) || waterLevelPercent < 0 || waterLevelPercent > 100)) {
    return res.status(400).json({ error: 'Invalid telemetry: waterLevelPercent must be between 0 and 100.' });
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

  // Update Device Persistence
  await db.run(
    `UPDATE devices SET connection_status = 'Connected', last_seen = ?, ip_address = COALESCE(?, ip_address), mac_address = COALESCE(?, mac_address), wifi_rssi = COALESCE(?, wifi_rssi), uptime = COALESCE(?, uptime), firmware_version = COALESCE(?, firmware_version), updated_at = ? WHERE device_id = ?`,
    [nowIso, ipAddress || null, macAddress || null, wifiRssi || null, uptime || null, firmware || null, nowIso, deviceId]
  );

  if (!wasConnected) {
    await logActivity('ESP32 Connected', 'Hardware telemetry link established with ESP32 node', 'success', 'wifi', deviceId);
  }

  // Persist Raw Hardware Telemetry
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

  res.json({
    success: true,
    connected: true,
    pumpMode: state.pump.mode,
    targetPumpStatus: state.pump.status,
    buzzerActive: state.buzzer.active,
    thresholds: state.thresholds
  });
});

app.get('/api/devices', async (req, res) => {
  try {
    const db = getDb();
    const deviceRecord = await db.get("SELECT * FROM devices WHERE device_id = 'ESP32-001'");
    if (deviceRecord) {
      state.esp32.ipAddress = deviceRecord.ip_address || state.esp32.ipAddress;
      state.esp32.macAddress = deviceRecord.mac_address || state.esp32.macAddress;
      state.esp32.wifiRssi = deviceRecord.wifi_rssi || state.esp32.wifiRssi;
      state.esp32.firmware = deviceRecord.firmware_version || state.esp32.firmware;
    }
    res.json({ esp32: state.esp32, sensor: state.sensor, pump: state.pump, buzzer: state.buzzer });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching device information.' });
  }
});

app.get('/api/analytics', async (req, res) => {
  const range = req.query.range || 'today';
  const now = new Date();

  try {
    const db = getDb();
    let startTimeIso = new Date(0).toISOString();

    if (range === 'today') {
      startTimeIso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
    } else if (range === '7d') {
      startTimeIso = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0).toISOString();
    } else if (range === 'month') {
      startTimeIso = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0).toISOString();
    } else if (range === 'year') {
      startTimeIso = new Date(now.getFullYear(), 0, 1, 0, 0, 0).toISOString();
    }

    const rows = await db.all(
      'SELECT * FROM telemetry WHERE timestamp >= ? ORDER BY timestamp ASC',
      [startTimeIso]
    );

    let waterChartLabels = [];
    let waterChartData = [];
    let usageChartLabels = [];
    let usageChartData = [];
    let rangeSubtitle = '';

    if (range === 'today') {
      rangeSubtitle = `${now.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}`;
      if (rows.length > 0) {
        waterChartLabels = rows.map(r => new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        waterChartData = rows.map(r => r.water_level_percentage);

        const hourBlocks = [0, 3, 6, 9, 12, 15, 18, 21];
        const currentHour = now.getHours();
        hourBlocks.forEach(h => {
          if (h <= currentHour) {
            const labelStr = `${String(h).padStart(2, '0')}:00`;
            usageChartLabels.push(labelStr);
            const blockStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0).getTime();
            const blockEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h + 3, 0, 0).getTime();
            const blockItems = rows.filter(r => {
              const t = new Date(r.timestamp).getTime();
              return t >= blockStart && t < blockEnd;
            });
            usageChartData.push(blockItems.length * 10);
          }
        });
      }
    } else if (range === '7d') {
      const startOf7d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0);
      rangeSubtitle = `${startOf7d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })} – ${now.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}`;

      for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 0, 0, 0);
        const dStart = d.getTime();
        const dEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 23, 59, 59).getTime();

        const dayLabel = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        waterChartLabels.push(dayLabel);
        usageChartLabels.push(dayLabel);

        const dayItems = rows.filter(r => {
          const t = new Date(r.timestamp).getTime();
          return t >= dStart && t <= dEnd;
        });

        if (dayItems.length > 0) {
          const avgLvl = Math.round(dayItems.reduce((acc, c) => acc + c.water_level_percentage, 0) / dayItems.length);
          waterChartData.push(avgLvl);
          usageChartData.push(dayItems.length * 15);
        } else {
          waterChartData.push(null);
          usageChartData.push(null);
        }
      }
    } else if (range === 'month') {
      const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      rangeSubtitle = `1–${now.getDate()} ${monthName}`;
      const totalDaysToday = now.getDate();

      for (let d = 1; d <= totalDaysToday; d++) {
        const dateObj = new Date(now.getFullYear(), now.getMonth(), d, 0, 0, 0);
        const dStart = dateObj.getTime();
        const dEnd = new Date(now.getFullYear(), now.getMonth(), d, 23, 59, 59).getTime();

        const dayLabel = `${d} ${now.toLocaleDateString('en-US', { month: 'short' })}`;
        waterChartLabels.push(dayLabel);
        usageChartLabels.push(dayLabel);

        const dayItems = rows.filter(r => {
          const t = new Date(r.timestamp).getTime();
          return t >= dStart && t <= dEnd;
        });

        if (dayItems.length > 0) {
          const avgLvl = Math.round(dayItems.reduce((acc, c) => acc + c.water_level_percentage, 0) / dayItems.length);
          waterChartData.push(avgLvl);
          usageChartData.push(dayItems.length * 20);
        } else {
          waterChartData.push(null);
          usageChartData.push(null);
        }
      }
    } else if (range === 'year') {
      rangeSubtitle = `Year ${now.getFullYear()} (Jan–${now.toLocaleDateString('en-US', { month: 'short' })})`;
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const currentMonthIdx = now.getMonth();

      for (let m = 0; m <= 11; m++) {
        waterChartLabels.push(monthNames[m]);
        usageChartLabels.push(monthNames[m]);

        if (m <= currentMonthIdx) {
          const mStart = new Date(now.getFullYear(), m, 1, 0, 0, 0).getTime();
          const mEnd = new Date(now.getFullYear(), m + 1, 0, 23, 59, 59).getTime();

          const monthItems = rows.filter(r => {
            const t = new Date(r.timestamp).getTime();
            return t >= mStart && t <= mEnd;
          });

          if (monthItems.length > 0) {
            const avgLvl = Math.round(monthItems.reduce((acc, c) => acc + c.water_level_percentage, 0) / monthItems.length);
            waterChartData.push(avgLvl);
            usageChartData.push(monthItems.length * 25);
          } else {
            waterChartData.push(null);
            usageChartData.push(null);
          }
        } else {
          waterChartData.push(null);
          usageChartData.push(null);
        }
      }
    }

    const levelValues = rows.map(r => r.water_level_percentage).filter(v => v !== undefined && v !== null);
    const minLvl = levelValues.length > 0 ? Math.min(...levelValues) : 0;
    const maxLvl = levelValues.length > 0 ? Math.max(...levelValues) : 0;
    const avgLvl = levelValues.length > 0 ? Math.round(levelValues.reduce((a, b) => a + b, 0) / levelValues.length) : 0;

    let totalUsageLiters = 0;
    if (usageChartData.length > 0) {
      totalUsageLiters = usageChartData.reduce((acc, val) => acc + (val || 0), 0);
    }

    const activationsCount = rows.filter(r => r.pump_status === 'ON').length;
    const totalRuntimeMinutes = Math.round(activationsCount * 8.5);
    const hasData = waterChartData.some(val => val !== null && val !== undefined) && waterChartLabels.length > 0;

    res.json({
      range,
      rangeSubtitle,
      hasData,
      waterLevelStats: { min: minLvl, max: maxLvl, avg: avgLvl, current: state.sensor.waterLevelPercent },
      usageStats: { totalLiters: totalUsageLiters },
      pumpAnalytics: {
        totalRuntimeMinutes,
        activationsCount
      },
      waterChart: {
        labels: waterChartLabels,
        data: waterChartData
      },
      usageChart: {
        labels: usageChartLabels,
        data: usageChartData
      }
    });
  } catch (err) {
    console.error('Analytics query error:', err);
    res.status(500).json({ error: 'Error processing analytics query.' });
  }
});

app.get('/api/history/full', async (req, res) => {
  const { category, search } = req.query;
  try {
    const db = getDb();
    let query = 'SELECT * FROM events';
    let params = [];
    let conditions = [];

    if (category && category !== 'all') {
      const qCat = category.toLowerCase().trim();
      let matchedCat = 'Sensor Readings';
      if (qCat === 'sensor' || qCat === 'sensor readings') matchedCat = 'Sensor Readings';
      else if (qCat === 'pump' || qCat === 'pump events') matchedCat = 'Pump Events';
      else if (qCat === 'alarm' || qCat === 'alarm events') matchedCat = 'Alarm Events';
      else if (qCat === 'system' || qCat === 'system events') matchedCat = 'System Events';

      conditions.push('category = ?');
      params.push(matchedCat);
    }

    if (search) {
      conditions.push('(event LIKE ? OR details LIKE ? OR category LIKE ?)');
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY id DESC LIMIT 100';

    const events = await db.all(query, params);
    const mapped = events.map(e => ({
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

    res.json({ total: mapped.length, data: mapped });
  } catch (err) {
    console.error('History query error:', err);
    res.status(500).json({ error: 'Error fetching history.' });
  }
});

app.post('/api/pump/control', requireAuth, async (req, res) => {
  const { mode, status } = req.body;
  const db = getDb();
  const nowIso = new Date().toISOString();

  if (mode !== undefined && (mode === 'AUTO' || mode === 'MANUAL')) {
    state.pump.mode = mode;
    await db.run('UPDATE configuration SET pump_mode = ?, updated_at = ? WHERE id = 1', [mode, nowIso]);
    await logActivity('Pump Mode Changed', `Switched pump control mode to ${mode}`, 'warning', 'sliders');
  }

  if (status !== undefined && (status === 'ON' || status === 'OFF')) {
    if (state.pump.mode === 'MANUAL') {
      state.pump.status = status;
      state.pump.lastStateChange = Date.now();
      state.pump.lastActivationTime = new Date().toLocaleTimeString();
      if (status === 'ON') state.pump.activationsToday++;
      await logActivity(`Manual Pump ${status}`, `Pump manually requested ${status} via dashboard`, status === 'ON' ? 'success' : 'info', status === 'ON' ? 'play' : 'stop');
    } else {
      return res.status(400).json({ error: 'Cannot manually override pump while in AUTO mode. Switch to MANUAL first.' });
    }
  }

  await evaluateWaterLogic();
  await broadcastState();
  res.json({ success: true, pump: state.pump });
});

app.post('/api/thresholds', requireAuth, async (req, res) => {
  const lowPercent = parseInt(req.body.lowPercent);
  const fullPercent = parseInt(req.body.fullPercent);
  const overflowPercent = parseInt(req.body.overflowPercent);

  const valResult = validateThresholdValues(lowPercent, fullPercent, overflowPercent);
  if (!valResult.valid) {
    return res.status(400).json({ error: valResult.message });
  }

  const db = getDb();
  const nowIso = new Date().toISOString();

  state.thresholds.lowPercent = lowPercent;
  state.thresholds.fullPercent = fullPercent;
  state.thresholds.overflowPercent = overflowPercent;

  if (req.body.maxPumpTimeoutMinutes !== undefined) {
    state.thresholds.maxPumpTimeoutMinutes = parseInt(req.body.maxPumpTimeoutMinutes);
  }
  if (req.body.tankCapacityLiters !== undefined) {
    state.sensor.tankCapacityLiters = parseInt(req.body.tankCapacityLiters);
  }

  await db.run(
    `UPDATE configuration SET low_water_threshold = ?, full_water_threshold = ?, emergency_overflow_threshold = ?, max_pump_timeout_minutes = ?, tank_capacity_liters = ?, updated_at = ? WHERE id = 1`,
    [lowPercent, fullPercent, overflowPercent, state.thresholds.maxPumpTimeoutMinutes, state.sensor.tankCapacityLiters, nowIso]
  );

  await logActivity('Threshold Configuration Updated', `Low: ${lowPercent}%, Full: ${fullPercent}%, Emergency Overflow: ${overflowPercent}%`, 'warning', 'settings');
  await evaluateWaterLogic();
  await broadcastState();
  res.json({ success: true, thresholds: state.thresholds });
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const { thresholds, pump, buzzer, systemHealth } = req.body;
  const db = getDb();
  const nowIso = new Date().toISOString();

  if (thresholds) {
    const low = parseInt(thresholds.lowPercent !== undefined ? thresholds.lowPercent : state.thresholds.lowPercent);
    const full = parseInt(thresholds.fullPercent !== undefined ? thresholds.fullPercent : state.thresholds.fullPercent);
    const overflow = parseInt(thresholds.overflowPercent !== undefined ? thresholds.overflowPercent : state.thresholds.overflowPercent);

    const valResult = validateThresholdValues(low, full, overflow);
    if (!valResult.valid) {
      return res.status(400).json({ error: valResult.message });
    }

    state.thresholds.lowPercent = low;
    state.thresholds.fullPercent = full;
    state.thresholds.overflowPercent = overflow;
    if (thresholds.maxPumpTimeoutMinutes) state.thresholds.maxPumpTimeoutMinutes = parseInt(thresholds.maxPumpTimeoutMinutes);

    await db.run(
      `UPDATE configuration SET low_water_threshold = ?, full_water_threshold = ?, emergency_overflow_threshold = ?, max_pump_timeout_minutes = ?, updated_at = ? WHERE id = 1`,
      [low, full, overflow, state.thresholds.maxPumpTimeoutMinutes, nowIso]
    );
  }

  if (pump) state.pump = { ...state.pump, ...pump };
  if (buzzer) {
    state.buzzer = { ...state.buzzer, ...buzzer };
    await db.run('UPDATE configuration SET buzzer_enabled = ?, updated_at = ? WHERE id = 1', [state.buzzer.enabled ? 1 : 0, nowIso]);
  }
  if (systemHealth) state.systemHealth = { ...state.systemHealth, ...systemHealth };

  await logActivity('System Settings Saved', 'Dashboard configuration updated successfully', 'success', 'settings');
  await evaluateWaterLogic();
  await broadcastState();
  res.json({ success: true, state });
});

app.post('/api/settings/reset', requireAuth, async (req, res) => {
  const db = getDb();
  const nowIso = new Date().toISOString();

  state.thresholds = {
    lowPercent: 20,
    fullPercent: 85,
    overflowPercent: 95,
    maxPumpTimeoutMinutes: 30
  };

  await db.run(
    `UPDATE configuration SET low_water_threshold = 20, full_water_threshold = 85, emergency_overflow_threshold = 95, max_pump_timeout_minutes = 30, updated_at = ? WHERE id = 1`,
    [nowIso]
  );

  await logActivity('Settings Reset', 'Configuration restored to factory defaults (Low 20%, Full 85%, Overflow 95%)', 'warning', 'refresh');
  await evaluateWaterLogic();
  await broadcastState();
  res.json({ success: true, state });
});

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.all(
      'SELECT * FROM notifications WHERE user_id = ? OR user_id IS NULL ORDER BY timestamp DESC, id DESC LIMIT 100',
      [req.user.userId]
    );

    const list = rows.map(n => ({
      id: n.id,
      title: n.title,
      message: n.message,
      severity: n.severity,
      timestamp: new Date(n.timestamp).getTime(),
      dateStr: new Date(n.timestamp).toLocaleString(),
      read: Boolean(n.acknowledged),
      active: !n.acknowledged,
      recipientEmail: n.recipient_email,
      emailStatus: n.email_status
    }));

    const unreadNotifications = list.filter(n => !n.read);
    const latestUnread = unreadNotifications.length > 0 ? unreadNotifications[0] : null;

    res.json({
      notifications: list,
      unreadNotifications,
      latestUnread,
      unreadCount: unreadNotifications.length,
      settings: state.notificationSettings
    });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching notifications.' });
  }
});

app.post('/api/notifications/read', requireAuth, async (req, res) => {
  const { id } = req.body;
  const db = getDb();
  const nowIso = new Date().toISOString();

  if (id === 'all') {
    await db.run(
      'UPDATE notifications SET acknowledged = 1, acknowledged_at = ? WHERE user_id = ? OR user_id IS NULL',
      [nowIso, req.user.userId]
    );
  } else {
    await db.run(
      'UPDATE notifications SET acknowledged = 1, acknowledged_at = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL)',
      [nowIso, id, req.user.userId]
    );
  }

  await broadcastState();
  res.json({ success: true });
});

app.post('/api/notifications/clear', requireAuth, async (req, res) => {
  const db = getDb();
  await db.run('DELETE FROM notifications WHERE user_id = ? OR user_id IS NULL', [req.user.userId]);
  await broadcastState();
  res.json({ success: true });
});

app.post('/api/buzzer/mute', async (req, res) => {
  state.buzzer.muted = !state.buzzer.muted;
  await logActivity('Buzzer Sound', state.buzzer.muted ? 'Buzzer audio muted' : 'Buzzer audio unmuted', 'info', 'bell');
  await broadcastState();
  res.json({ success: true, buzzer: state.buzzer });
});

app.get('/api/esp32/command', (req, res) => {
  state.esp32.lastSeen = Date.now();
  state.esp32.connected = true;
  res.json({
    pumpMode: state.pump.mode,
    targetPumpStatus: state.pump.status,
    buzzerActive: state.buzzer.active,
    thresholds: state.thresholds
  });
});

// WebSocket Connection Setup
wss.on('connection', async (ws) => {
  await broadcastState();

  ws.on('message', async (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'PUMP_CONTROL') {
        const { mode, status } = parsed;
        if (mode) state.pump.mode = mode;
        if (status && state.pump.mode === 'MANUAL') state.pump.status = status;
        await evaluateWaterLogic();
        await broadcastState();
      }
    } catch (err) {
      console.error('Error parsing WS message:', err);
    }
  });
});

// Daily Digest Backend Scheduler
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
        const prevDateStr = getPreviousCompletedDateString(timezone);
        console.log(`⏰ Daily Digest Scheduler executing for completed date: ${prevDateStr}`);
        await sendDailyDigest(null, prevDateStr);
      }
    } catch (err) {
      console.error('Error in Daily Digest Scheduler tick:', err);
    }
  }, 60000);
}

// Server Initialization
const PORT = process.env.PORT || 5000;

async function startServer() {
  await initDatabase();
  await loadPersistedConfig();
  startDailyDigestScheduler();

  server.listen(PORT, () => {
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
