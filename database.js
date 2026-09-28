const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');

let db = null;

async function initDatabase() {
  const dbPath = path.join(__dirname, 'water_monitoring.db');
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enable WAL mode & foreign key constraints
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA foreign_keys = ON;');

  // 1. ADMINS / USERS
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Admin User',
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      reset_token_hash TEXT,
      reset_token_expires_at DATETIME,
      reset_token_used INTEGER DEFAULT 0,
      reset_otp_hash TEXT,
      reset_otp_expires_at DATETIME,
      reset_otp_attempts INTEGER DEFAULT 0,
      reset_otp_verified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration helper for existing users table if missing columns
  try { await db.exec("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT 'Admin User';"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN reset_token_hash TEXT;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN reset_token_expires_at DATETIME;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN reset_token_used INTEGER DEFAULT 0;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN reset_otp_hash TEXT;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN reset_otp_expires_at DATETIME;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN reset_otp_attempts INTEGER DEFAULT 0;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN reset_otp_verified INTEGER DEFAULT 0;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN email_notifications INTEGER DEFAULT 1;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN emergency_alerts INTEGER DEFAULT 1;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN daily_digest INTEGER DEFAULT 1;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN telegram_enabled INTEGER DEFAULT 0;"); } catch (e) {}
  try { await db.exec("ALTER TABLE users ADD COLUMN sms_enabled INTEGER DEFAULT 0;"); } catch (e) {}

  // Migration helper for existing notifications table if missing columns
  try { await db.exec("ALTER TABLE notifications ADD COLUMN user_id INTEGER;"); } catch (e) {}
  try { await db.exec("ALTER TABLE notifications ADD COLUMN notification_type TEXT DEFAULT 'email';"); } catch (e) {}
  try { await db.exec("ALTER TABLE notifications ADD COLUMN event_type TEXT;"); } catch (e) {}
  try { await db.exec("ALTER TABLE notifications ADD COLUMN recipient_email TEXT;"); } catch (e) {}
  try { await db.exec("ALTER TABLE notifications ADD COLUMN status TEXT DEFAULT 'SENT';"); } catch (e) {}
  try { await db.exec("ALTER TABLE notifications ADD COLUMN error_message TEXT;"); } catch (e) {}
  try { await db.exec("ALTER TABLE notifications ADD COLUMN sent_at DATETIME;"); } catch (e) {}

  // Default Admin User (admin / admin123) if no user exists
  const userCount = await db.get('SELECT COUNT(*) as count FROM users');
  if (userCount.count === 0) {
    const defaultPasswordHash = await bcrypt.hash('admin123', 10);
    await db.run(
      'INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      ['System Administrator', 'admin@smartwater.io', 'admin', defaultPasswordHash, 'admin']
    );
  }

  // 2. DEVICES
  await db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT UNIQUE NOT NULL,
      device_name TEXT NOT NULL,
      device_type TEXT DEFAULT 'ESP32',
      connection_status TEXT DEFAULT 'Disconnected',
      last_seen DATETIME,
      ip_address TEXT,
      mac_address TEXT,
      wifi_rssi INTEGER,
      uptime TEXT,
      firmware_version TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Default Device Record
  await db.run(`
    INSERT OR IGNORE INTO devices (device_id, device_name, connection_status)
    VALUES ('ESP32-001', 'ESP32 Node-01 (Main Tank Controller)', 'Disconnected')
  `);

  // 3. TELEMETRY
  await db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      sensor_value INTEGER,
      water_level_percentage INTEGER,
      pump_status TEXT,
      pump_mode TEXT,
      buzzer_status TEXT,
      temperature REAL,
      humidity REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices (device_id) ON DELETE CASCADE
    );
  `);

  // 4. EVENTS / HISTORY
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      category TEXT NOT NULL CHECK(category IN ('Sensor Readings', 'Pump Events', 'Alarm Events', 'System Events')),
      event_type TEXT NOT NULL,
      event TEXT NOT NULL,
      details TEXT,
      status TEXT,
      water_level_percentage INTEGER,
      distance_cm INTEGER,
      pump_status TEXT,
      pump_mode TEXT,
      buzzer_status TEXT
    );
  `);

  // 5. CONFIGURATION
  await db.exec(`
    CREATE TABLE IF NOT EXISTS configuration (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      low_water_threshold INTEGER NOT NULL DEFAULT 20,
      full_water_threshold INTEGER NOT NULL DEFAULT 85,
      emergency_overflow_threshold INTEGER NOT NULL DEFAULT 95,
      max_pump_timeout_minutes INTEGER NOT NULL DEFAULT 30,
      tank_capacity_liters INTEGER NOT NULL DEFAULT 1000,
      pump_mode TEXT NOT NULL DEFAULT 'AUTO',
      buzzer_enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Ensure Single Config Row Exists
  await db.run(`
    INSERT OR IGNORE INTO configuration (id, low_water_threshold, full_water_threshold, emergency_overflow_threshold, max_pump_timeout_minutes, tank_capacity_liters, pump_mode, buzzer_enabled)
    VALUES (1, 20, 85, 95, 30, 1000, 'AUTO', 1)
  `);

  // 6. NOTIFICATIONS / ALERTS
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      category TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('critical', 'warning', 'info')),
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      acknowledged INTEGER DEFAULT 0,
      acknowledged_at DATETIME
    );
  `);

  // 7. DAILY DIGEST LOGS (DUPLICATE PROTECTION)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS daily_digest_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      digest_date TEXT NOT NULL,
      status TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      error_message TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
  `);

  // 8. INDEXING
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry (device_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_device_cat_time ON events (device_id, category, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp);
    CREATE INDEX IF NOT EXISTS idx_notifications_ack ON notifications (acknowledged, timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_user_date ON daily_digest_logs (user_id, digest_date);
  `);

  return db;
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

module.exports = {
  initDatabase,
  getDb
};
