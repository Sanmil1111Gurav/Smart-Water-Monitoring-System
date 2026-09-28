require('dotenv').config();
const nodemailer = require('nodemailer');
const { getDb } = require('../database');

/**
 * Utility function to mask email address for safe logging
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return email;
  const [local, domain] = email.split('@');
  const maskedLocal = local.length > 2 ? local[0] + '***' + local[local.length - 1] : local[0] + '***';
  return `${maskedLocal}@${domain}`;
}

/**
 * Get configured Nodemailer Transporter using Gmail SMTP credentials from environment
 */
function getTransporter() {
  const host = (process.env.EMAIL_HOST || process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = parseInt((process.env.EMAIL_PORT || process.env.SMTP_PORT || '587').toString().trim(), 10);
  const user = (process.env.EMAIL_USERNAME || process.env.EMAIL_USER || process.env.SMTP_USER || process.env.SMTP_USERNAME || '').trim();
  const pass = (process.env.EMAIL_PASSWORD || process.env.EMAIL_PASS || process.env.SMTP_PASS || process.env.SMTP_PASSWORD || '').trim();

  if (!host || !user || !pass) {
    throw new Error('SMTP credentials missing. Please set EMAIL_HOST, EMAIL_USERNAME, and EMAIL_PASSWORD in .env file.');
  }

  return {
    transporter: nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      tls: {
        rejectUnauthorized: false
      }
    }),
    host,
    port,
    user
  };
}

/**
 * Dispatch Email to User's Registered Email Address
 */
async function sendUserEmail({ userId, userEmail, subject, text, html, category = 'System Events', alertType = 'notification', severity = 'info', eventType = 'email_dispatch' }) {
  const db = getDb();
  let targetUser = null;

  if (userId) {
    targetUser = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  } else if (userEmail) {
    targetUser = await db.get('SELECT * FROM users WHERE email = ?', [userEmail]);
  }

  if (!targetUser && !userEmail) {
    throw new Error('No target recipient email or user ID provided');
  }

  const recipientEmail = targetUser ? targetUser.email : userEmail;
  const targetUserId = targetUser ? targetUser.id : null;

  // Check User Notification Preferences for optional/alert categories
  // Note: Transactional emails (category === 'ACCOUNT' or alertType === 'password_reset') are system-critical and bypass marketing notification toggles
  if (targetUser && category !== 'ACCOUNT' && alertType !== 'password_reset') {
    if (targetUser.email_notifications === 0) {
      console.log(`ℹ️ Email notification skipped: User ${targetUser.username} (${maskEmail(recipientEmail)}) has email notifications disabled.`);
      return { success: false, skipped: true, reason: 'Email notifications disabled by user', recipientEmail };
    }

    if (category === 'EMERGENCY' && targetUser.emergency_alerts === 0) {
      console.log(`ℹ️ Emergency alert skipped: User ${targetUser.username} (${maskEmail(recipientEmail)}) has emergency alerts disabled.`);
      return { success: false, skipped: true, reason: 'Emergency alerts disabled by user', recipientEmail };
    }

    if (category === 'DIGEST' && targetUser.daily_digest === 0) {
      console.log(`ℹ️ Daily digest skipped: User ${targetUser.username} (${maskEmail(recipientEmail)}) has daily digest disabled.`);
      return { success: false, skipped: true, reason: 'Daily digest disabled by user', recipientEmail };
    }
  }

  console.log('--------------------------------------------------');
  console.log('📧 Email notification requested');
  console.log(`Recipient: ${maskEmail(recipientEmail)}`);
  console.log(`Notification type: ${category}`);

  let status = 'FAILED';
  let errorMessage = null;

  try {
    const { transporter, host, port, user } = getTransporter();
    const from = (process.env.EMAIL_FROM || user || 'Smart Water Monitoring <system-notifications@smartwater.io>').trim();

    const mailOptions = {
      from,
      to: recipientEmail,
      subject,
      text,
      html
    };

    console.log(`📡 Connecting to SMTP host: ${host}:${port}`);
    const info = await transporter.sendMail(mailOptions);
    console.log('SMTP connection: successful');
    console.log(`SMTP send: successful (Message ID: ${info.messageId || 'SENT'})`);
    status = 'SENT';
    console.log('Notification status: SENT');
  } catch (err) {
    status = 'FAILED';
    errorMessage = err.message || 'SMTP delivery failed';
    console.error(`❌ SMTP send: failed for ${maskEmail(recipientEmail)}`);
    console.error(`Error details: ${errorMessage}`);
    console.log('Notification status: FAILED');
  }
  console.log('--------------------------------------------------');

  // Persist record in notifications table ONLY after send result is known
  await db.run(
    `INSERT INTO notifications (user_id, device_id, category, alert_type, title, message, severity, recipient_email, notification_type, status, error_message, sent_at, acknowledged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'email', ?, ?, CURRENT_TIMESTAMP, 0)`,
    [
      targetUserId,
      'ESP32-001',
      category,
      alertType,
      subject,
      text || subject,
      severity,
      recipientEmail,
      status,
      errorMessage
    ]
  );

  return {
    success: status === 'SENT',
    status,
    recipientEmail,
    errorMessage
  };
}

/**
 * Trigger Emergency Overflow / Low Water Email Alert
 */
async function triggerEmergencyAlert(state, eventDetails) {
  const db = getDb();
  const usersToNotify = await db.all(
    'SELECT * FROM users WHERE email_notifications = 1 AND emergency_alerts = 1'
  );

  if (usersToNotify.length === 0) {
    console.log('ℹ️ No active users with emergency email alerts enabled.');
    return;
  }

  const level = state.sensor.waterLevelPercent;
  const status = state.sensor.status;
  const deviceName = state.esp32.deviceName || 'ESP32 Node-01 (Main Tank Controller)';

  const subject = `🚨 EMERGENCY ALERT: Water Monitoring System [${status}]`;
  const text = `EMERGENCY ALERT REPORT
Date/Time: ${new Date().toLocaleString()}
Device: ${deviceName} (ESP32-001)
Status: ${status}
Water Level: ${level !== null ? level + '%' : 'Not available'} (${state.sensor.currentLiters || 0} / ${state.sensor.tankCapacityLiters} Liters)
Emergency Threshold: ${state.thresholds.overflowPercent}%
Sensor Depth: ${state.sensor.distanceCm !== null ? state.sensor.distanceCm + ' cm' : 'Not available'}
Pump Status: ${state.pump.status} (Mode: ${state.pump.mode})
Buzzer Status: ${state.buzzer.active ? 'ALARM ACTIVE' : 'QUIET'}
Details: ${eventDetails}

RECOMMENDED ACTION: Please inspect the water storage tank immediately.`;

  const html = `
    <div style="font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 12px;">
      <div style="border-bottom: 2px solid #f43f5e; padding-bottom: 12px; margin-bottom: 20px;">
        <h2 style="color: #f43f5e; margin: 0;">🚨 EMERGENCY ALERT REPORT</h2>
        <p style="color: #94a3b8; font-size: 13px; margin: 4px 0 0 0;">Smart Water Monitoring System — Real-Time Hardware Event</p>
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px;">
        <tr><td style="padding: 8px 0; color: #94a3b8;">Timestamp:</td><td style="font-weight: bold; color: #fff;">${new Date().toLocaleString()}</td></tr>
        <tr><td style="padding: 8px 0; color: #94a3b8;">Device:</td><td style="font-weight: bold; color: #38bdf8;">${deviceName}</td></tr>
        <tr><td style="padding: 8px 0; color: #94a3b8;">Condition:</td><td style="font-weight: bold; color: #f43f5e;">${status} (${level !== null ? level + '%' : 'N/A'})</td></tr>
        <tr><td style="padding: 8px 0; color: #94a3b8;">Emergency Threshold:</td><td style="font-weight: bold; color: #f43f5e;">${state.thresholds.overflowPercent}%</td></tr>
        <tr><td style="padding: 8px 0; color: #94a3b8;">Tank Volume:</td><td style="font-weight: bold; color: #fff;">${state.sensor.currentLiters || 0} / ${state.sensor.tankCapacityLiters} Liters</td></tr>
        <tr><td style="padding: 8px 0; color: #94a3b8;">Pump State:</td><td style="font-weight: bold; color: #10b981;">${state.pump.status} (${state.pump.mode} mode)</td></tr>
        <tr><td style="padding: 8px 0; color: #94a3b8;">Buzzer Sounder:</td><td style="font-weight: bold; color: #f59e0b;">${state.buzzer.active ? 'ACTIVE ALARM' : 'MUTED'}</td></tr>
      </table>
      <div style="background: rgba(244, 63, 94, 0.15); border: 1px solid #f43f5e; padding: 14px; border-radius: 8px; font-size: 13px; color: #fecdd3;">
        <strong>Details:</strong> ${eventDetails}
      </div>
    </div>
  `;

  for (const user of usersToNotify) {
    await sendUserEmail({
      userId: user.id,
      userEmail: user.email,
      subject,
      text,
      html,
      category: 'EMERGENCY',
      alertType: 'emergency_overflow',
      severity: 'critical',
      eventType: 'emergency_alert'
    });
  }
}

/**
 * Dispatch Critical Event Notification (Pump Failure, Sensor Failure, ESP32 Offline, Reconnected)
 */
async function sendEventNotification(title, details, severity = 'warning', category = 'System Events') {
  const db = getDb();
  const usersToNotify = await db.all('SELECT * FROM users WHERE email_notifications = 1');

  if (usersToNotify.length === 0) return;

  const subject = `⚠️ CRITICAL EVENT ALERT: ${title}`;
  const text = `CRITICAL SYSTEM EVENT REPORT
Date/Time: ${new Date().toLocaleString()}
Event: ${title}
Severity: ${severity.toUpperCase()}
Category: ${category}
Details: ${details}`;

  const html = `
    <div style="font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 12px;">
      <h3 style="color: #f59e0b; margin-top: 0;">⚠️ ${title}</h3>
      <p style="color: #94a3b8; font-size: 13px;">Timestamp: ${new Date().toLocaleString()}</p>
      <div style="background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; padding: 12px 16px; border-radius: 8px; margin-top: 12px;">
        <strong>Details:</strong> ${details}
      </div>
    </div>
  `;

  for (const user of usersToNotify) {
    await sendUserEmail({
      userId: user.id,
      userEmail: user.email,
      subject,
      text,
      html,
      category,
      alertType: 'event_alert',
      severity,
      eventType: 'system_event'
    });
  }
}

/**
 * Helper to get date string YYYY-MM-DD for yesterday in specified timezone
 */
function getPreviousCompletedDateString(timezone = 'Asia/Kolkata') {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const options = { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' };
  const [{ value: month },,{ value: day },,{ value: year }] = new Intl.DateTimeFormat('en-US', options).formatToParts(yesterday);
  return `${year}-${month}-${day}`;
}

/**
 * Generate Daily Digest Email for Previous Completed Day with Duplicate Protection
 */
async function sendDailyDigest(userId = null, targetDateStr = null, isManualTrigger = false) {
  const db = getDb();
  const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
  const digestDate = targetDateStr || getPreviousCompletedDateString(timezone);

  let query = 'SELECT * FROM users WHERE email_notifications = 1 AND daily_digest = 1';
  let params = [];

  if (userId) {
    query = 'SELECT * FROM users WHERE id = ?';
    params = [userId];
  }

  const usersToNotify = await db.all(query, params);
  if (usersToNotify.length === 0) {
    return {
      success: false,
      skipped: true,
      reason: 'Daily digest is disabled in your notification preferences.',
      message: 'Daily digest is disabled in your notification preferences.'
    };
  }

  // If specific user was provided (e.g. manual trigger), verify user's preference
  if (userId) {
    const user = usersToNotify[0];
    if (user.email_notifications === 0 || user.daily_digest === 0) {
      return {
        success: false,
        skipped: true,
        reason: 'Daily digest is disabled in your notification preferences.',
        message: 'Daily digest is disabled in your notification preferences.'
      };
    }
  }

  const startDateIso = `${digestDate}T00:00:00.000Z`;
  const endDateIso = `${digestDate}T23:59:59.999Z`;

  // Query actual telemetry data for target date
  const telemetry = await db.all(
    'SELECT water_level_percentage FROM telemetry WHERE timestamp >= ? AND timestamp <= ?',
    [startDateIso, endDateIso]
  );

  let minLevel = 'Not available';
  let maxLevel = 'Not available';
  let avgLevel = 'Not available';
  let telemetryCount = telemetry.length;

  if (telemetryCount > 0) {
    const levels = telemetry.map(t => t.water_level_percentage).filter(l => l !== null);
    if (levels.length > 0) {
      minLevel = `${Math.min(...levels)}%`;
      maxLevel = `${Math.max(...levels)}%`;
      avgLevel = `${Math.round(levels.reduce((a, b) => a + b, 0) / levels.length)}%`;
    }
  }

  // Query actual event data for target date
  const events = await db.all(
    'SELECT category, event_type, event FROM events WHERE timestamp >= ? AND timestamp <= ?',
    [startDateIso, endDateIso]
  );

  const lowCount = events.filter(e => e.category === 'Alarm Events').length;
  const pumpCount = events.filter(e => e.category === 'Pump Events').length;
  const systemCount = events.filter(e => e.category === 'System Events').length;

  const subject = `📊 Daily Water Tank Report — ${digestDate}`;
  const text = `DAILY WATER TANK REPORT
Date: ${digestDate}
Timezone: ${timezone}

TELEMETRY METRICS:
- Minimum Water Level: ${minLevel}
- Maximum Water Level: ${maxLevel}
- Average Water Level: ${avgLevel}
- Total Sensor Readings: ${telemetryCount > 0 ? telemetryCount : 'Not available'}

EVENT METRICS:
- Pump Activations: ${pumpCount} events
- Alarm & Emergency Alerts: ${lowCount} alerts
- System & Device Events: ${systemCount} events`;

  const html = `
    <div style="font-family: Arial, sans-serif; background: #0b0f19; color: #f8fafc; padding: 24px; border-radius: 12px; border: 1px solid #38bdf8;">
      <h2 style="color: #38bdf8; margin-top: 0;">📊 Daily Water Tank Report</h2>
      <p style="color: #94a3b8; font-size: 13px;">Aggregated metrics for completed date: <strong>${digestDate}</strong> (${timezone})</p>
      <hr style="border-color: rgba(255,255,255,0.1); margin: 16px 0;" />
      
      <h4 style="color: #7dd3fc; margin-bottom: 8px;">Telemetry Metrics</h4>
      <ul style="line-height: 1.6;">
        <li><strong>Minimum Level:</strong> ${minLevel}</li>
        <li><strong>Maximum Level:</strong> ${maxLevel}</li>
        <li><strong>Average Level:</strong> ${avgLevel}</li>
        <li><strong>Total Sensor Readings:</strong> ${telemetryCount > 0 ? telemetryCount : 'Not available'}</li>
      </ul>

      <h4 style="color: #7dd3fc; margin-bottom: 8px;">Event Summaries</h4>
      <ul style="line-height: 1.6;">
        <li><strong>Pump Activations Today:</strong> ${pumpCount}</li>
        <li><strong>Total Alarm Events:</strong> ${lowCount}</li>
        <li><strong>System & Device Events:</strong> ${systemCount}</li>
      </ul>
    </div>
  `;

  const results = [];
  for (const user of usersToNotify) {
    if (!isManualTrigger) {
      // Check Duplicate Log for automatic scheduler runs
      const existingLog = await db.get(
        'SELECT status FROM daily_digest_logs WHERE user_id = ? AND digest_date = ?',
        [user.id, digestDate]
      );

      if (existingLog && existingLog.status === 'SENT') {
        console.log(`ℹ️ Daily digest skipped for user ${user.username} (${user.email}): already SENT for date ${digestDate}.`);
        results.push({ user_id: user.id, skipped: true, reason: 'Already sent for date', digestDate });
        continue;
      }
    }

    const res = await sendUserEmail({
      userId: user.id,
      userEmail: user.email,
      subject,
      text,
      html,
      category: 'DIGEST',
      alertType: 'daily_digest',
      severity: 'info',
      eventType: 'daily_digest'
    });

    // Record digest execution in daily_digest_logs table
    await db.run(
      `INSERT INTO daily_digest_logs (user_id, digest_date, status, recipient_email, error_message)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, digest_date) DO UPDATE SET
         status = excluded.status,
         error_message = excluded.error_message,
         sent_at = CURRENT_TIMESTAMP`,
      [user.id, digestDate, res.status, user.email, res.errorMessage || null]
    );

    results.push(res);
  }

  const overallSuccess = results.some(r => r.status === 'SENT');
  return { success: overallSuccess, count: results.length, digestDate, results };
}

/**
 * Send Password Reset OTP Email
 */
async function sendPasswordResetOTP({ userId, userEmail, username, otp }) {
  const emailSubject = 'SmartWater System - Password Reset OTP';
  const emailText = `Hello ${username || 'User'},\n\nWe received a request to reset your Smart Water Monitoring System password.\n\nYour password reset OTP is:\n${otp}\n\nThis OTP expires in 10 minutes.\n\nIf you did not request this, you can safely ignore this email.`;
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff;">
      <h2 style="color: #0284c7; margin-bottom: 16px;">Password Reset OTP</h2>
      <p style="color: #334155; font-size: 15px;">Hello <strong>${username || 'User'}</strong>,</p>
      <p style="color: #334155; font-size: 15px;">We received a request to reset your Smart Water Monitoring System password.</p>
      <div style="margin: 24px 0; text-align: center; background-color: #f1f5f9; padding: 16px; border-radius: 8px; letter-spacing: 6px;">
        <span style="font-size: 32px; font-weight: bold; color: #0284c7;">${otp}</span>
      </div>
      <p style="color: #64748b; font-size: 14px;">This OTP is valid for <strong>10 minutes</strong>. Do not share this code with anyone.</p>
    </div>
  `;

  return sendUserEmail({
    userId,
    userEmail,
    subject: emailSubject,
    text: emailText,
    html: emailHtml,
    category: 'ACCOUNT',
    alertType: 'password_reset',
    severity: 'warning'
  });
}

module.exports = {
  sendUserEmail,
  sendPasswordResetOTP,
  triggerEmergencyAlert,
  sendEventNotification,
  sendDailyDigest,
  getPreviousCompletedDateString
};

