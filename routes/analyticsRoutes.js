const express = require('express');
const router = express.Router();
const analyticsService = require('../services/analyticsService');
const telemetryService = require('../services/telemetryService');

// Analytics Query Endpoint
router.get('/', async (req, res) => {
  const range = req.query.range || 'today';
  try {
    const result = await analyticsService.getAnalytics(range, telemetryService.getState());
    res.json(result);
  } catch (err) {
    console.error('Analytics query error:', err);
    res.status(500).json({ success: false, error: 'Error processing analytics query.' });
  }
});

module.exports = router;
