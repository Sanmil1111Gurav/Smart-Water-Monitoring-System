const { getDb } = require('../database');
const { broadcastState } = require('./telemetryService');

/**
 * Get Notification Preferences for Logged-In User
 */
async function getUserPreferences(userId) {
  const db = getDb();
  const user = await db.get(
    'SELECT email, email_notifications, emergency_alerts, daily_digest, telegram_enabled, sms_enabled FROM users WHERE id = ?',
    [userId]
  );

  if (!user) throw { status: 404, message: 'User not found.' };

  const emailNotifications = Boolean(user.email_notifications ?? 1);
  const emergencyAlerts = Boolean(user.emergency_alerts ?? 1);
  const dailyDigest = Boolean(user.daily_digest ?? 1);

  return {
    email: user.email,
    emailNotifications,
    emergencyAlerts,
    dailyDigest,
    email_notifications: emailNotifications,
    emergency_alerts: emergencyAlerts,
    daily_digest: dailyDigest,
    telegramEnabled: Boolean(user.telegram_enabled ?? 0),
    smsEnabled: Boolean(user.sms_enabled ?? 0)
  };
}

/**
 * Update Notification Preferences for Logged-In User
 */
async function updateUserPreferences(userId, body) {
  const emailNotifications = body.emailNotifications !== undefined ? body.emailNotifications : body.email_notifications;
  const emergencyAlerts = body.emergencyAlerts !== undefined ? body.emergencyAlerts : body.emergency_alerts;
  const dailyDigest = body.dailyDigest !== undefined ? body.dailyDigest : body.daily_digest;

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
      userId
    ]
  );

  return {
    success: true,
    message: 'Notification preferences updated successfully!',
    preferences: {
      emailNotifications: Boolean(emailNotifications),
      emergencyAlerts: Boolean(emergencyAlerts),
      dailyDigest: Boolean(dailyDigest)
    }
  };
}

/**
 * Get User Notifications (Unread Count, Latest Unread, Full List)
 */
async function getUserNotifications(userId, currentState) {
  const db = getDb();
  const rows = await db.all(
    'SELECT * FROM notifications WHERE user_id = ? OR user_id IS NULL ORDER BY timestamp DESC, id DESC LIMIT 100',
    [userId]
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
    emailStatus: n.status
  }));

  const unreadNotifications = list.filter(n => !n.read);
  const latestUnread = unreadNotifications.length > 0 ? unreadNotifications[0] : null;

  return {
    notifications: list,
    unreadNotifications,
    latestUnread,
    unreadCount: unreadNotifications.length,
    settings: currentState ? currentState.notificationSettings : {}
  };
}

/**
 * Mark Notification(s) as Read
 */
async function markNotificationRead(userId, notificationId) {
  const db = getDb();
  const nowIso = new Date().toISOString();

  if (notificationId === 'all') {
    await db.run(
      'UPDATE notifications SET acknowledged = 1, acknowledged_at = ? WHERE user_id = ? OR user_id IS NULL',
      [nowIso, userId]
    );
  } else {
    await db.run(
      'UPDATE notifications SET acknowledged = 1, acknowledged_at = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL)',
      [nowIso, notificationId, userId]
    );
  }

  await broadcastState();
  return { success: true };
}

/**
 * Clear User Notifications History
 */
async function clearUserNotifications(userId) {
  const db = getDb();
  await db.run('DELETE FROM notifications WHERE user_id = ? OR user_id IS NULL', [userId]);
  await broadcastState();
  return { success: true };
}

module.exports = {
  getUserPreferences,
  updateUserPreferences,
  getUserNotifications,
  markNotificationRead,
  clearUserNotifications
};
