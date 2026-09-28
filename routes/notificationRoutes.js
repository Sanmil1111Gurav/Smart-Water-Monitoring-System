const express = require('express');
const router = express.Router();
const notificationService = require('../services/notificationService');
const telemetryService = require('../services/telemetryService');
const { sendDailyDigest } = require('../services/emailService');
const { requireAuth } = require('../middleware/auth');

// Get User Notifications List
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await notificationService.getUserNotifications(req.user.userId, telemetryService.getState());
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error fetching notifications.' });
  }
});

// Mark Notification(s) Read
router.post('/read', requireAuth, async (req, res) => {
  try {
    const result = await notificationService.markNotificationRead(req.user.userId, req.body.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error updating notification status.' });
  }
});

// Clear Notifications History
router.post('/clear', requireAuth, async (req, res) => {
  try {
    const result = await notificationService.clearUserNotifications(req.user.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error clearing notifications.' });
  }
});

// Get User Notification Preferences
router.get('/preferences', requireAuth, async (req, res) => {
  try {
    const preferences = await notificationService.getUserPreferences(req.user.userId);
    res.json(preferences);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message || 'Server error fetching preferences.' });
  }
});

// Update User Notification Preferences
router.post('/preferences', requireAuth, async (req, res) => {
  try {
    const result = await notificationService.updateUserPreferences(req.user.userId, req.body);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ success: false, error: err.message || 'Server error updating preferences.' });
  }
});

// Manual Daily Digest Trigger
router.post('/digest', requireAuth, async (req, res) => {
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

module.exports = router;
