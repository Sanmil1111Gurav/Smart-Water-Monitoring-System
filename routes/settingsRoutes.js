const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const telemetryService = require('../services/telemetryService');
const { requireAuth } = require('../middleware/auth');
const { validateThresholdValues, isValidEmail } = require('../middleware/validation');

// Save Threshold Configuration Endpoint
router.post('/thresholds', requireAuth, async (req, res) => {
  const lowPercent = parseInt(req.body.lowPercent);
  const fullPercent = parseInt(req.body.fullPercent);
  const overflowPercent = parseInt(req.body.overflowPercent);

  const valResult = validateThresholdValues(lowPercent, fullPercent, overflowPercent);
  if (!valResult.valid) {
    return res.status(400).json({ success: false, error: valResult.message });
  }

  const db = getDb();
  const state = telemetryService.getState();
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

  await telemetryService.logActivity('Threshold Configuration Updated', `Low: ${lowPercent}%, Full: ${fullPercent}%, Emergency Overflow: ${overflowPercent}%`, 'warning', 'settings');
  await telemetryService.evaluateWaterLogic();
  await telemetryService.broadcastState();

  res.json({ success: true, thresholds: state.thresholds });
});

// Full System Settings Endpoint
router.post('/settings', requireAuth, async (req, res) => {
  const { thresholds, pump, buzzer, systemHealth } = req.body;
  const db = getDb();
  const state = telemetryService.getState();
  const nowIso = new Date().toISOString();

  if (thresholds) {
    const low = parseInt(thresholds.lowPercent !== undefined ? thresholds.lowPercent : state.thresholds.lowPercent);
    const full = parseInt(thresholds.fullPercent !== undefined ? thresholds.fullPercent : state.thresholds.fullPercent);
    const overflow = parseInt(thresholds.overflowPercent !== undefined ? thresholds.overflowPercent : state.thresholds.overflowPercent);

    const valResult = validateThresholdValues(low, full, overflow);
    if (!valResult.valid) {
      return res.status(400).json({ success: false, error: valResult.message });
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

  if (pump) {
    const { mode, ...pumpUpdates } = pump;
    Object.assign(state.pump, pumpUpdates);
  }
  if (buzzer) {
    state.buzzer = { ...state.buzzer, ...buzzer };
    await db.run('UPDATE configuration SET buzzer_enabled = ?, updated_at = ? WHERE id = 1', [state.buzzer.enabled ? 1 : 0, nowIso]);
  }
  if (systemHealth) state.systemHealth = { ...state.systemHealth, ...systemHealth };

  await telemetryService.logActivity('System Settings Saved', 'Dashboard configuration updated successfully', 'success', 'settings');
  await telemetryService.evaluateWaterLogic();
  await telemetryService.broadcastState();

  res.json({ success: true, state });
});

// Reset Factory Settings Endpoint
router.post('/settings/reset', requireAuth, async (req, res) => {
  const db = getDb();
  const state = telemetryService.getState();
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

  await telemetryService.logActivity('Settings Reset', 'Configuration restored to factory defaults (Low 20%, Full 85%, Overflow 95%)', 'warning', 'refresh');
  await telemetryService.evaluateWaterLogic();
  await telemetryService.broadcastState();

  res.json({ success: true, state });
});

// User Profile Update Endpoint
router.post('/user/profile', requireAuth, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Please enter your name.' });
  if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });

  try {
    const db = getDb();
    const existing = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email.trim(), req.user.userId]);
    if (existing) return res.status(400).json({ success: false, error: 'An account with this email address already exists.' });

    await db.run('UPDATE users SET name = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [name.trim(), email.trim(), req.user.userId]);
    res.json({ success: true, message: 'Profile updated successfully! Future notifications will be sent to ' + email.trim() });
  } catch (err) {
    console.error('Error updating user profile:', err);
    res.status(500).json({ success: false, error: 'Server error updating profile.' });
  }
});

module.exports = router;
