const { getDb } = require('../database');

const { WATER_FLOW_RATE_LPM } = require('../utils/config');

function calculateRuntimeAndUsage(rows) {
  let totalRuntimeMs = 0;
  let activations = 0;
  let lastOnTime = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ts = new Date(row.timestamp).getTime();
    
    if (row.pump_status === 'ON') {
      if (lastOnTime === null) {
        lastOnTime = ts;
        activations++;
      } else {
        const delta = ts - lastOnTime;
        if (delta > 0 && delta <= 5 * 60 * 1000) {
           totalRuntimeMs += delta;
        }
        lastOnTime = ts;
      }
    } else {
      if (lastOnTime !== null) {
        const delta = ts - lastOnTime;
        if (delta > 0 && delta <= 5 * 60 * 1000) {
           totalRuntimeMs += delta;
        }
        lastOnTime = null;
      }
    }
  }

  const runtimeMinutes = totalRuntimeMs / 60000;
  return {
    runtimeMinutes: Math.round(runtimeMinutes * 10) / 10,
    estimatedLiters: Math.round(runtimeMinutes * WATER_FLOW_RATE_LPM),
    activations
  };
}

function getTimezoneDayBoundaries(dateStr, timeZone = 'Asia/Kolkata') {
  const [year, month, day] = dateStr.split('-').map(Number);
  const estimateUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const getOffsetMs = (date) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(date);
    const p = {};
    parts.forEach(pt => { p[pt.type] = pt.value; });
    const hour = +p.hour === 24 ? 0 : +p.hour;
    const localDate = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second));
    return localDate.getTime() - date.getTime();
  };
  const offsetMs = getOffsetMs(estimateUtc);
  const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMs;
  return new Date(startUtcMs).toISOString();
}

/**
 * Analytics Query Service - DB Aggregations for Today, 7 Days, Month, Year
 */
async function getAnalytics(range = 'today', currentState) {
  const now = new Date();
  const db = getDb();
  let startTimeIso = new Date(0).toISOString();

  if (range === 'today') {
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    startTimeIso = getTimezoneDayBoundaries(todayStr);
  } else if (range === '7d') {
    const startOf7d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    const start7dStr = `${startOf7d.getFullYear()}-${String(startOf7d.getMonth() + 1).padStart(2, '0')}-${String(startOf7d.getDate()).padStart(2, '0')}`;
    startTimeIso = getTimezoneDayBoundaries(start7dStr);
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
          usageChartData.push(calculateRuntimeAndUsage(blockItems).estimatedLiters);
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
        usageChartData.push(calculateRuntimeAndUsage(dayItems).estimatedLiters);
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
        usageChartData.push(calculateRuntimeAndUsage(dayItems).estimatedLiters);
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
          usageChartData.push(calculateRuntimeAndUsage(monthItems).estimatedLiters);
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

  const totalStats = calculateRuntimeAndUsage(rows);
  const totalUsageLiters = totalStats.estimatedLiters;
  const activationsCount = totalStats.activations;
  const totalRuntimeMinutes = totalStats.runtimeMinutes;
  const hasData = waterChartData.some(val => val !== null && val !== undefined) && waterChartLabels.length > 0;

  return {
    range,
    rangeSubtitle,
    hasData,
    waterLevelStats: { min: minLvl, max: maxLvl, avg: avgLvl, current: currentState ? currentState.sensor.waterLevelPercent : null },
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
  };
}

module.exports = {
  getAnalytics
};
