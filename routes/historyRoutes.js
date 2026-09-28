const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { EVENT_CATEGORIES } = require('../utils/constants');

// Get Historical Logs Endpoint
router.get('/full', async (req, res) => {
  const { category, search, startDate, endDate, format } = req.query;

  try {
    const db = getDb();
    let query = 'SELECT * FROM events';
    let params = [];
    let conditions = [];

    if (category && category !== 'all') {
      const qCat = category.toLowerCase().trim();
      let matchedCat = EVENT_CATEGORIES.SENSOR_READINGS;
      if (qCat === 'sensor' || qCat === 'sensor readings') matchedCat = EVENT_CATEGORIES.SENSOR_READINGS;
      else if (qCat === 'pump' || qCat === 'pump events') matchedCat = EVENT_CATEGORIES.PUMP_EVENTS;
      else if (qCat === 'alarm' || qCat === 'alarm events') matchedCat = EVENT_CATEGORIES.ALARM_EVENTS;
      else if (qCat === 'system' || qCat === 'system events') matchedCat = EVENT_CATEGORIES.SYSTEM_EVENTS;

      conditions.push('category = ?');
      params.push(matchedCat);
    }

    if (search) {
      conditions.push('(event LIKE ? OR details LIKE ? OR category LIKE ?)');
      const searchPattern = `%${search.trim()}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    if (startDate) {
      conditions.push('timestamp >= ?');
      params.push(new Date(startDate).toISOString());
    }

    if (endDate) {
      conditions.push('timestamp <= ?');
      params.push(new Date(endDate).toISOString());
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY id DESC LIMIT 500';

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
      details: e.details,
      category: e.category
    }));

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="water_system_history.csv"');

      let csv = 'ID,Date,Time,Category,Event,Details,Water Level (%),Distance (cm),Pump Status,Mode,Buzzer Status\n';
      mapped.forEach(item => {
        csv += `"${item.id}","${item.date}","${item.time}","${item.category}","${item.event.replace(/"/g, '""')}","${(item.details || '').replace(/"/g, '""')}","${item.waterLevelPercent !== null ? item.waterLevelPercent : ''}","${item.distanceCm !== null ? item.distanceCm : ''}","${item.pumpStatus || ''}","${item.mode || ''}","${item.buzzerStatus || ''}"\n`;
      });
      return res.send(csv);
    }

    res.json({ total: mapped.length, data: mapped });
  } catch (err) {
    console.error('History query error:', err);
    res.status(500).json({ success: false, error: 'Error fetching history.' });
  }
});

module.exports = router;
