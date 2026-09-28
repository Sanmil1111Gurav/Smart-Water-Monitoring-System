const { getDb } = require('../database');

/**
 * Analytics Query Service - DB Aggregations for Today, 7 Days, Month, Year
 */
async function getAnalytics(range = 'today', currentState) {
  const now = new Date();
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
