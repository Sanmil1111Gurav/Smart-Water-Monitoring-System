// Authentication Storage Helper
function getAuthToken() {
  return localStorage.getItem('smartwater_auth_token') || '';
}

function getAuthHeaders() {
  const token = getAuthToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };
}

// Data Architecture Services Layer
const sensorService = {
  getTelemetry: (state) => state.sensor,
  getHealth: (state) => state.systemHealth
};

const deviceService = {
  getDevices: async () => {
    const res = await fetch('/api/devices', { headers: getAuthHeaders() });
    return res.json();
  }
};

const analyticsService = {
  getAnalytics: async (range = 'today') => {
    const res = await fetch(`/api/analytics?range=${range}`, { headers: getAuthHeaders() });
    return res.json();
  }
};

const historyService = {
  getHistory: async (category = 'all', search = '') => {
    const res = await fetch(`/api/history/full?category=${category}&search=${encodeURIComponent(search)}`, { headers: getAuthHeaders() });
    return res.json();
  }
};

const notificationService = {
  getNotifications: async () => {
    const res = await fetch('/api/notifications', { headers: getAuthHeaders() });
    return res.json();
  },
  markRead: async (id = 'all') => {
    await fetch('/api/notifications/read', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ id })
    });
  },
  clear: async () => {
    await fetch('/api/notifications/clear', {
      method: 'POST',
      headers: getAuthHeaders()
    });
  }
};

const settingsService = {
  saveSettings: async (payload) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    return res.json();
  },
  saveThresholds: async (payload) => {
    const res = await fetch('/api/thresholds', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    return res.json();
  },
  resetDefaults: async () => {
    const res = await fetch('/api/settings/reset', {
      method: 'POST',
      headers: getAuthHeaders()
    });
    return res.json();
  }
};

// Strict Percentage & Relationship Validation Helper
function validateThresholdInputs(lowStr, fullStr, overflowStr) {
  if (
    lowStr === '' ||
    fullStr === '' ||
    overflowStr === '' ||
    lowStr === null ||
    fullStr === null ||
    overflowStr === null
  ) {
    return {
      valid: false,
      message: 'Please enter valid percentage values (0–100%) for all threshold fields.'
    };
  }

  const low = Number(lowStr);
  const full = Number(fullStr);
  const overflow = Number(overflowStr);

  if (
    isNaN(low) ||
    isNaN(full) ||
    isNaN(overflow) ||
    low < 0 ||
    low > 100 ||
    full < 0 ||
    full > 100 ||
    overflow < 0 ||
    overflow > 100
  ) {
    return {
      valid: false,
      message: 'Value must be between 0 and 100%.'
    };
  }

  if (low >= full || full > overflow) {
    return {
      valid: false,
      message: 'Thresholds must follow: Low < Full ≤ Emergency.'
    };
  }

  return {
    valid: true,
    low,
    full,
    overflow
  };
}

// Main Dashboard Controller
document.addEventListener('DOMContentLoaded', () => {
  function updateSidebarNotificationBadge(count) {
    const badge = document.getElementById('badgeAlertsCount');
    if (!badge) return;

    const num = Number(count) || 0;

    if (num > 0) {
      badge.innerText = num;
      badge.style.display = 'inline-block';
    } else {
      badge.innerText = '';
      badge.style.display = 'none';
    }
  }

  let state = null;
  let ws = null;
  let chart = null;
  let analyticsWaterChart = null;
  let analyticsUsageChart = null;
  let currentView = 'dashboard';
  let currentAnalyticsRange = 'today';
  let currentDashboardRange = 'live';

  // Navigation Links
  const navItems = document.querySelectorAll('.nav-item[data-target]');
  const pageViews = document.querySelectorAll('.page-view');
  const pageTitleText = document.getElementById('pageTitleText');
  const pageSubTitleText = document.getElementById('pageSubTitleText');

  // Clock
  const liveClockBadge = document.getElementById('currentTimeStr');
  const espStatusPill = document.getElementById('espStatusPill');
  const espStatusText = document.getElementById('espStatusText');
  const staleBanner = document.getElementById('staleBanner');

  // Top Dashboard Metrics
  const valWaterLevel = document.getElementById('valWaterLevel');
  const pillWaterState = document.getElementById('pillWaterState');
  const valPumpStatus = document.getElementById('valPumpStatus');
  const pillPumpMode = document.getElementById('pillPumpMode');
  const valTodayUsage = document.getElementById('valTodayUsage');

  // ============================================================
  // DASHBOARD TODAY USAGE FIX
  // ============================================================
  // Dashboard Today's Usage is synchronized with the same
  // Analytics "today" calculation instead of using the potentially
  // inconsistent state.usageStats.todayLiters value.
  let dashboardTodayUsage = null;
  let dashboardTodayUsageFetchInProgress = false;

  async function syncDashboardTodayUsage() {
    if (dashboardTodayUsageFetchInProgress) return;

    dashboardTodayUsageFetchInProgress = true;

    try {
      const data = await analyticsService.getAnalytics('today');

      if (
        data &&
        data.usageStats &&
        data.usageStats.totalLiters !== null &&
        data.usageStats.totalLiters !== undefined
      ) {
        const value = Number(data.usageStats.totalLiters);

        if (Number.isFinite(value) && value >= 0) {
          dashboardTodayUsage = value;

          if (valTodayUsage) {
            valTodayUsage.innerText =
              `${dashboardTodayUsage.toLocaleString()} L`;
          }
        }
      }
    } catch (err) {
      console.error('Failed to sync Dashboard Today Usage:', err);
    } finally {
      dashboardTodayUsageFetchInProgress = false;
    }
  }

  const valAlertsCount = document.getElementById('valAlertsCount');
  const badgeAlertsCount = document.getElementById('badgeAlertsCount');

  // Tank
  const tankWaterElem = document.getElementById('tankWaterElem');
  const tankOverlayPercent = document.getElementById('tankOverlayPercent');
  const tankOverlayState = document.getElementById('tankOverlayState');
  const tankVisualStatePill = document.getElementById('tankVisualStatePill');
  const statCapacity = document.getElementById('statCapacity');
  const statCurrentLiters = document.getElementById('statCurrentLiters');
  const statRawDistance = document.getElementById('statRawDistance');

  // Pump Controls
  const pumpLargeStatusText = document.getElementById('pumpLargeStatusText');
  const pumpModeDisplay = document.getElementById('pumpModeDisplay');
  const pumpVisualRing = document.getElementById('pumpVisualRing');
  const metricPumpIcon = document.getElementById('metricPumpIcon');
  const btnModeAuto = document.getElementById('btnModeAuto');
  const btnModeManual = document.getElementById('btnModeManual');
  const btnPumpOn = document.getElementById('btnPumpOn');
  const btnPumpOff = document.getElementById('btnPumpOff');

  // Device & System Health
  const valConnection = document.getElementById('valConnection');
  const valUptime = document.getElementById('valUptime');
  const valSignal = document.getElementById('valSignal');
  const devEspDetail = document.getElementById('devEspDetail');
  const devEspStatus = document.getElementById('devEspStatus');
  const devSensorDetail = document.getElementById('devSensorDetail');
  const devWifiDetail = document.getElementById('devWifiDetail');
  const devMotorDetail = document.getElementById('devMotorDetail');
  const devMotorStatus = document.getElementById('devMotorStatus');
  const devBuzzerDetail = document.getElementById('devBuzzerDetail');
  const devBuzzerPill = document.getElementById('devBuzzerPill');

  // Activity & Alerts
  const activityTimeline = document.getElementById('activityTimeline');
  const alertsFeed = document.getElementById('alertsFeed');

  // Modals
  const settingsModal = document.getElementById('settingsModal');
  const btnConfigThresholds = document.getElementById('btnConfigThresholds');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const thresholdsForm = document.getElementById('thresholdsForm');
  const modalValidationError = document.getElementById('modalValidationError');
  const modalValidationMsg = document.getElementById('modalValidationMsg');

  // Inputs
  const inputLowPercent = document.getElementById('inputLowPercent');
  const inputFullPercent = document.getElementById('inputFullPercent');
  const inputOverflowPercent = document.getElementById('inputOverflowPercent');
  const inputCapacity = document.getElementById('inputCapacity');

  // Settings View Inputs & Error Message
  const fullSettingsForm = document.getElementById('fullSettingsForm');
  const setLowPercent = document.getElementById('setLowPercent');
  const setFullPercent = document.getElementById('setFullPercent');
  const setOverflowPercent = document.getElementById('setOverflowPercent');
  const setMaxRuntime = document.getElementById('setMaxRuntime');
  const setBuzzerEnabled = document.getElementById('setBuzzerEnabled');
  const settingsValidationError = document.getElementById('settingsValidationError');
  const settingsValidationMsg = document.getElementById('settingsValidationMsg');

  // Input Sanitize Handler
  function enforcePercentageInputLimits(inputElem) {
    if (!inputElem) return;

    inputElem.addEventListener('input', () => {
      if (inputElem.value === '') return;

      const val = Number(inputElem.value);

      if (isNaN(val) || val < 0 || val > 100) {
        inputElem.value = '';
      }
    });
  }

  [
    inputLowPercent,
    inputFullPercent,
    inputOverflowPercent,
    setLowPercent,
    setFullPercent,
    setOverflowPercent
  ].forEach(enforcePercentageInputLimits);

  // View Switcher
  const viewTitles = {
    dashboard: {
      title: 'Dashboard',
      sub: 'Real-time overview of your water monitoring system'
    },
    devices: {
      title: 'Devices & Hardware',
      sub: 'Status and diagnostics for ESP32, sensors, L293D driver, and pump'
    },
    analytics: {
      title: 'Analytics & Consumption',
      sub: 'Water level trends, usage statistics, and pump runtime analytics'
    },
    history: {
      title: 'System History',
      sub: 'Searchable historical telemetry data and event logs'
    },
    notifications: {
      title: 'Notifications & Alerts',
      sub: 'Active warnings, alert log, and message dispatch settings'
    },
    settings: {
      title: 'System Settings',
      sub: 'Configure water thresholds, pump rules, buzzer sounder, and system parameters'
    },
    help: {
      title: 'Help & About',
      sub: 'Learn how the SmartWater monitoring and automation system works and troubleshoot common issues.'
    }
  };

  function switchView(targetView) {
    if (!viewTitles[targetView]) targetView = 'dashboard';

    currentView = targetView;

    if (window.location.hash !== `#${targetView}`) {
      window.location.hash = targetView;
    }

    navItems.forEach(item => {
      if (item.getAttribute('data-target') === targetView) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    const pageViews = document.querySelectorAll('.page-view');

    pageViews.forEach(view => {
      if (view.id === `view-${targetView}`) {
        view.classList.add('active');
      } else {
        view.classList.remove('active');
      }
    });

    if (viewTitles[targetView]) {
      pageTitleText.innerText = viewTitles[targetView].title;
      pageSubTitleText.innerText = viewTitles[targetView].sub;
    }

    if (targetView === 'devices') renderDevicesPage(state);
    if (targetView === 'analytics') renderAnalyticsPage(currentAnalyticsRange);
    if (targetView === 'history') renderHistoryPage();
    if (targetView === 'notifications') renderNotificationsPage();
    if (targetView === 'settings') renderSettingsPage();
  }

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.getAttribute('data-target');
      switchView(target);
    });
  });

  // Hash Navigation & Route Retention
  function restoreViewFromHash() {
    const hash = window.location.hash.substring(1);

    if (hash && viewTitles[hash]) {
      switchView(hash);
    }
  }

  window.addEventListener('hashchange', restoreViewFromHash);
  restoreViewFromHash();

  // Troubleshooting Accordion Event Listener
  document.addEventListener('click', (e) => {
    const header = e.target.closest('.accordion-header');

    if (header) {
      const item = header.closest('.accordion-item');

      if (item) {
        item.classList.toggle('active');
      }
    }
  });

  // Clock Update
  function updateClock() {
    const now = new Date();

    liveClockBadge.innerText = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  }

  setInterval(updateClock, 1000);
  updateClock();

  // Initialize Dashboard Chart
  function initChart() {
    const ctx = document.getElementById('waterChart').getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, 0, 260);
    gradient.addColorStop(0, 'rgba(56, 189, 248, 0.4)');
    gradient.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Water Level (%)',
          data: [],
          borderColor: '#38bdf8',
          borderWidth: 3,
          backgroundColor: gradient,
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: '#0284c7'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          x: {
            grid: {
              color: 'rgba(255, 255, 255, 0.05)'
            },
            ticks: {
              color: '#64748b'
            }
          },
          y: {
            min: 0,
            max: 100,
            grid: {
              color: 'rgba(255, 255, 255, 0.05)'
            },
            ticks: {
              color: '#64748b',
              callback: v => v + '%'
            }
          }
        }
      }
    });
  }

  // Main UI Renderer
  function renderUI(data) {
    console.log('[RENDER_UI_INPUT]', {
      timestamp: new Date().toISOString(),
      pumpMode: data?.pump?.mode,
      pumpStatus: data?.pump?.status,
      source: 'renderUI'
    });

    if (data?.pump?.mode === 'AUTO') {
      console.trace('[AUTO_RENDER_TRACE]');
    }

    state = data;

    const {
      esp32,
      sensor,
      pump,
      buzzer,
      systemHealth,
      thresholds,
      usageStats,
      history,
      activityLogs,
      notifications
    } = data;

    // ESP Status
    const espPill = document.getElementById('espStatusPill');
    const espText = document.getElementById('espStatusText');
    const lastUpd = document.getElementById('lastUpdatedText');

    if (esp32.connected) {
      if (espPill) espPill.className = 'esp-status-pill online';
      if (espText) espText.innerText = 'ESP32 Connected';

      staleBanner.classList.add('hidden');

      devEspStatus.className = 'status-pill normal';
      devEspStatus.innerText = 'CONNECTED';
    } else {
      if (espPill) espPill.className = 'esp-status-pill offline';
      if (espText) espText.innerText = 'ESP32 Disconnected';

      staleBanner.classList.remove('hidden');

      devEspStatus.className = 'status-pill overflow';
      devEspStatus.innerText = 'DISCONNECTED';
    }

    if (lastUpd) {
      if (esp32.connected && sensor.lastReading) {
        lastUpd.innerText = `Updated: ${sensor.lastReading}`;
      } else if (sensor.lastReading) {
        lastUpd.innerText = `Last Seen: ${sensor.lastReading}`;
      } else {
        lastUpd.innerText = `Last Updated: Never`;
      }
    }

    // Metrics & Water Level
    const lvl = sensor.waterLevelPercent;
    const isConnected = Boolean(esp32 && esp32.connected);
    const sRaw =
      (sensor.sensorValue !== null && sensor.sensorValue !== undefined)
        ? sensor.sensorValue
        : 0;

    const devSensorStatusPill =
      document.getElementById('devSensorStatusPill');

    if (isConnected && lvl !== null && lvl !== undefined) {
      valWaterLevel.innerText = `${lvl}%`;
      tankOverlayPercent.innerText = `${lvl}%`;
      tankWaterElem.style.height = `${lvl}%`;

      statCurrentLiters.innerText =
        `${sensor.currentLiters !== null ? sensor.currentLiters : '--'} L`;

      statRawDistance.innerText = `${sRaw}`;
      devSensorDetail.innerText = `Sensor Value: ${sRaw}`;

      if (devSensorStatusPill) {
        devSensorStatusPill.className = 'status-pill normal';
        devSensorStatusPill.innerText = 'ACTIVE';
      }
    } else {
      valWaterLevel.innerText = `--%`;
      tankOverlayPercent.innerText = `N/A`;
      tankWaterElem.style.height = `0%`;
      statCurrentLiters.innerText = `N/A`;
      statRawDistance.innerText = `N/A`;
      devSensorDetail.innerText = `Hardware Sensor Offline`;

      if (devSensorStatusPill) {
        devSensorStatusPill.className = 'status-pill overflow';
        devSensorStatusPill.innerText = 'DISCONNECTED';
      }
    }

    statCapacity.innerText = `${sensor.tankCapacityLiters} L`;

    // Dynamic Tank Status classification
    let statusText = 'NOT AVAILABLE';
    let stateClass = 'low';

    if (isConnected && lvl !== null && lvl !== undefined) {
      if (lvl <= thresholds.lowPercent) {
        statusText = 'LOW';
        stateClass = 'low';
      } else if (lvl >= thresholds.overflowPercent) {
        statusText = 'OVERFLOW';
        stateClass = 'overflow';
      } else if (lvl >= thresholds.fullPercent) {
        statusText = 'FULL';
        stateClass = 'full';
      } else {
        statusText = pump.status === 'ON' ? 'FILLING' : 'NORMAL';
        stateClass = 'normal';
      }
    }

    pillWaterState.className = `status-pill ${stateClass}`;
    pillWaterState.innerText =
      isConnected ? `Tank ${statusText}` : 'Not Available';

    tankOverlayState.className = `status-pill ${stateClass}`;
    tankOverlayState.innerText =
      isConnected ? statusText : 'Offline';

    tankVisualStatePill.className = `status-pill ${stateClass}`;
    tankVisualStatePill.innerText =
      isConnected ? statusText : 'Not Available';

    // Pump Status
    const displayPumpStatus =
      isConnected ? pump.status : 'Not Available';

    valPumpStatus.innerText = displayPumpStatus;
    pumpLargeStatusText.innerText = displayPumpStatus;

    valPumpStatus.style.color =
      (isConnected && pump.status === 'ON')
        ? 'var(--accent-emerald)'
        : 'var(--text-primary)';

    pumpLargeStatusText.style.color =
      (isConnected && pump.status === 'ON')
        ? 'var(--accent-emerald)'
        : 'var(--text-primary)';

    if (isConnected && pump.status === 'ON') {
      pumpVisualRing.classList.add('running');

      devMotorStatus.className = 'status-pill normal';
      devMotorStatus.innerText = 'PUMPING';

      metricPumpIcon.className = 'ri-restart-line';
    } else {
      pumpVisualRing.classList.remove('running');

      devMotorStatus.className =
        isConnected ? 'status-pill normal' : 'status-pill overflow';

      devMotorStatus.innerText =
        isConnected ? 'READY' : 'NOT AVAILABLE';

      metricPumpIcon.className = 'ri-shut-down-line';
    }

    devMotorDetail.innerText =
      isConnected
        ? `State: ${pump.status === 'ON' ? 'Active' : 'Standby'} | Activations Today: ${pump.activationsToday || 0}`
        : 'Motor Driver Offline';

    if (pump.mode === 'AUTO') {
      btnModeAuto.classList.add('active');
      btnModeManual.classList.remove('active');

      pillPumpMode.innerText = 'Automatic Mode';
      pumpModeDisplay.innerText = 'Automatic Mode';

      btnPumpOn.disabled = true;
      btnPumpOff.disabled = true;
    } else {
      btnModeManual.classList.add('active');
      btnModeAuto.classList.remove('active');

      pillPumpMode.innerText = 'Manual Mode';
      pumpModeDisplay.innerText = 'Manual Control Active';

      btnPumpOn.disabled = !isConnected;
      btnPumpOff.disabled = !isConnected;
    }

    // ============================================================
    // DASHBOARD TODAY USAGE DISPLAY
    // ============================================================
    if (dashboardTodayUsage !== null) {
      valTodayUsage.innerText =
        `${dashboardTodayUsage.toLocaleString()} L`;
    } else {
      valTodayUsage.innerText = 'Data unavailable';
    }

    // System Connection
    if (valConnection) {
      valConnection.innerText =
        isConnected ? 'Connected' : 'Disconnected';

      valConnection.style.color =
        isConnected
          ? 'var(--accent-emerald)'
          : 'var(--accent-rose)';
    }

    // Uptime
    if (
      isConnected &&
      esp32.uptime !== null &&
      esp32.uptime !== undefined
    ) {
      const seconds = Number(esp32.uptime);

      const d = Math.floor(seconds / (3600 * 24));
      const h = Math.floor((seconds % (3600 * 24)) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);

      const uptimeStr = [];

      if (d > 0) uptimeStr.push(`${d}d`);
      if (h > 0) uptimeStr.push(`${h}h`);
      if (m > 0) uptimeStr.push(`${m}m`);

      if (s > 0 || uptimeStr.length === 0) {
        uptimeStr.push(`${s}s`);
      }

      valUptime.innerText = uptimeStr.join(' ');
    } else {
      valUptime.innerText = 'Offline';
    }

    // Wi-Fi Status
    const devWifiStatusPill =
      document.getElementById('devWifiStatusPill');

    if (devWifiStatusPill) {
      devWifiStatusPill.className =
        isConnected
          ? 'status-pill normal'
          : 'status-pill overflow';

      devWifiStatusPill.innerText =
        isConnected ? 'ONLINE' : 'OFFLINE';
    }

    if (isConnected) {
      if (
        esp32.wifiRssi !== null &&
        esp32.wifiRssi !== undefined
      ) {
        valSignal.innerText = `${esp32.wifiRssi} dBm`;
        devWifiDetail.innerText =
          `Signal Strength: ${esp32.wifiRssi} dBm`;
      } else {
        valSignal.innerText = `Data unavailable`;
        devWifiDetail.innerText =
          `Wi-Fi Signal: Data unavailable`;
      }
    } else {
      valSignal.innerText = `Offline`;
      devWifiDetail.innerText = `Wi-Fi Signal: Offline`;
    }

    // Buzzer Status
    if (isConnected && buzzer.active) {
      devBuzzerPill.className = 'status-pill overflow';
      devBuzzerPill.innerText = 'ALARM ACTIVE';

      devBuzzerDetail.innerText =
        `Reason: ${buzzer.reason || 'Emergency Overflow Risk'}`;
    } else if (isConnected) {
      devBuzzerPill.className = 'status-pill normal';

      devBuzzerPill.innerText =
        buzzer.muted
          ? 'MUTED'
          : (buzzer.enabled ? 'ARMED' : 'DISABLED');

      devBuzzerDetail.innerText =
        buzzer.muted
          ? 'Sound Muted'
          : (buzzer.enabled
            ? 'State: Quiet | Armed'
            : 'Buzzer Disabled');
    } else {
      devBuzzerPill.className = 'status-pill overflow';
      devBuzzerPill.innerText = 'NOT AVAILABLE';
      devBuzzerDetail.innerText = 'Buzzer Hardware Offline';
    }

    // Dynamic Dashboard Water Chart Filtering
    if (chart && history) {
      let filteredHistory = history;
      const now = new Date();

      if (currentDashboardRange === 'live') {
        filteredHistory = history.slice(-20);

        chart.data.labels =
          filteredHistory.map(h => h.time);

        chart.data.datasets[0].data =
          filteredHistory.map(h => h.waterLevelPercent);

      } else if (currentDashboardRange === 'today') {
        const startOfDay =
          new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            0,
            0,
            0
          ).getTime();

        filteredHistory =
          history.filter(h => h.timestamp >= startOfDay);

        chart.data.labels =
          filteredHistory.map(h => h.time);

        chart.data.datasets[0].data =
          filteredHistory.map(h => h.waterLevelPercent);

      } else if (currentDashboardRange === 'week') {
        const startOf7d =
          new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() - 6,
            0,
            0,
            0
          ).getTime();

        filteredHistory =
          history.filter(h => h.timestamp >= startOf7d);

        const labels = [];
        const values = [];

        for (let i = 6; i >= 0; i--) {
          const d =
            new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate() - i,
              0,
              0,
              0
            );

          const dStart = d.getTime();

          const dEnd =
            new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate() - i,
              23,
              59,
              59
            ).getTime();

          labels.push(
            d.toLocaleDateString('en-US', {
              day: 'numeric',
              month: 'short'
            })
          );

          const dayItems =
            filteredHistory.filter(
              h =>
                h.timestamp >= dStart &&
                h.timestamp <= dEnd
            );

          if (dayItems.length > 0) {
            values.push(
              Math.round(
                dayItems.reduce(
                  (acc, c) => acc + c.waterLevelPercent,
                  0
                ) / dayItems.length
              )
            );
          } else {
            values.push(null);
          }
        }

        chart.data.labels = labels;
        chart.data.datasets[0].data = values;
      }

      chart.update('none');
    }

    // Recent Activity
    if (activityTimeline && activityLogs) {
      const recentFive =
        activityLogs.slice(0, 5);

      if (recentFive.length === 0) {
        activityTimeline.innerHTML =
          '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 16px;">No recent activity</div>';
      } else {
        activityTimeline.innerHTML =
          recentFive.map(log => `
            <div class="log-item">
              <div class="log-icon ${log.type}">
                <i class="ri-${log.icon || 'information'}-line"></i>
              </div>

              <div class="log-content">
                <div class="log-title">${log.title}</div>
                <div class="log-desc">${log.desc}</div>
              </div>

              <div class="log-time">${log.time}</div>
            </div>
          `).join('');
      }
    }

    async function updateUserNotificationState() {
      try {
        const token = getAuthToken();

        if (!token) {
          if (valAlertsCount) {
            valAlertsCount.innerText = '0';
          }

          updateSidebarNotificationBadge(0);
          return;
        }

        const data =
          await notificationService.getNotifications();

        if (
          data &&
          data.unreadCount !== undefined
        ) {
          const count =
            Number(data.unreadCount) || 0;

          if (valAlertsCount) {
            valAlertsCount.innerText = count;
          }

          updateSidebarNotificationBadge(count);
        }
      } catch (err) {
        console.error(
          'Error updating user notification state:',
          err
        );
      }
    }

    const alertsSubtext =
      document.getElementById('valAlertsSubtext');

    if (
      notifications &&
      Array.isArray(notifications)
    ) {
      const activeUnreadNotifs =
        notifications.filter(
          n => n.active || !n.read
        );

      const activeCount =
        activeUnreadNotifs.length;

      if (valAlertsCount) {
        valAlertsCount.innerText =
          activeCount;
      }

      if (alertsSubtext) {
        alertsSubtext.innerText =
          activeCount > 0
            ? 'Need Attention'
            : 'No Active Alerts';

        alertsSubtext.style.color =
          activeCount > 0
            ? 'var(--accent-amber)'
            : 'var(--accent-emerald)';
      }

      updateSidebarNotificationBadge(
        activeCount
      );

      const latestUnread =
        activeUnreadNotifs.length > 0
          ? activeUnreadNotifs[0]
          : null;

      if (alertsFeed) {
        if (latestUnread) {
          alertsFeed.innerHTML = `
            <div
              class="alert-card ${latestUnread.severity}"
              style="cursor: pointer; display: flex; justify-content: space-between; align-items: flex-start;"
              id="dashboardLatestAlertCard"
              data-id="${latestUnread.id}"
            >
              <div
                style="display: flex; gap: 12px; align-items: flex-start; flex: 1; min-width: 0;"
              >
                <i
                  class="ri-alert-fill"
                  style="font-size: 18px; margin-top: 2px; flex-shrink: 0;"
                ></i>

                <div
                  style="min-width: 0; flex: 1; overflow-wrap: anywhere; word-break: break-word;"
                >
                  <div class="alert-title">
                    ${latestUnread.title}
                  </div>

                  <div class="alert-msg">
                    ${latestUnread.message}
                  </div>

                  <div
                    style="font-size: 10px; color: var(--text-muted); margin-top: 4px;"
                  >
                    ${latestUnread.dateStr || ''}
                  </div>
                </div>
              </div>

              <button
                class="btn-tab btn-dash-mark-read"
                data-id="${latestUnread.id}"
                style="font-size: 11px; padding: 4px 8px; margin-left: 8px; white-space: nowrap; flex-shrink: 0; background: rgba(16, 185, 129, 0.15); color: var(--accent-emerald); border: 1px solid var(--accent-emerald);"
              >
                <i class="ri-check-line"></i> Read
              </button>
            </div>
          `;

          const card =
            document.getElementById(
              'dashboardLatestAlertCard'
            );

          if (card) {
            card.addEventListener(
              'click',
              async () => {
                const id =
                  latestUnread.id;

                await notificationService.markRead(
                  id
                );

                if (
                  currentView === 'notifications'
                ) {
                  renderNotificationsPage();
                } else {
                  fetchStatus();
                }
              }
            );
          }
        } else {
          alertsFeed.innerHTML =
            '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 16px;">No Active Alerts</div>';
        }
      }

      const notifPageFeed =
        document.getElementById(
          'notificationsActiveFeed'
        );

      if (notifPageFeed) {
        const sortedNotifs =
          [...notifications].sort(
            (a, b) =>
              (b.timestamp || 0) -
              (a.timestamp || 0)
          );

        const top5 =
          sortedNotifs.slice(0, 5);

        if (top5.length > 0) {
          notifPageFeed.innerHTML =
            top5.map(n => `
              <div
                class="alert-card ${n.severity}"
                style="cursor: pointer; display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;"
                data-active-notif-id="${n.id}"
              >
                <div
                  style="display: flex; gap: 12px; align-items: flex-start; flex: 1; min-width: 0;"
                >
                  <i
                    class="ri-alert-fill"
                    style="font-size: 20px; margin-top: 2px; flex-shrink: 0;"
                  ></i>

                  <div
                    style="min-width: 0; flex: 1; overflow-wrap: anywhere; word-break: break-word;"
                  >
                    <div class="alert-title">
                      ${n.title}
                      ${n.read
                ? ''
                : '<span class="status-pill overflow" style="font-size: 9px; padding: 1px 6px; margin-left: 6px;">UNREAD</span>'}
                    </div>

                    <div class="alert-msg">
                      ${n.message}
                    </div>

                    <div
                      style="font-size: 10px; color: var(--text-muted); margin-top: 4px;"
                    >
                      ${n.dateStr || ''}
                    </div>
                  </div>
                </div>

                ${!n.read
                ? `
                  <button
                    class="btn-tab btn-mark-read"
                    data-id="${n.id}"
                    style="font-size: 11px; padding: 4px 8px; margin-left: 8px; white-space: nowrap; flex-shrink: 0; background: rgba(16, 185, 129, 0.15); color: var(--accent-emerald); border: 1px solid var(--accent-emerald);"
                  >
                    <i class="ri-check-line"></i> Read
                  </button>
                `
                : ''}
              </div>
            `).join('');

          notifPageFeed
            .querySelectorAll(
              '.btn-mark-read'
            )
            .forEach(btn => {
              btn.addEventListener(
                'click',
                async e => {
                  e.stopPropagation();

                  const id =
                    btn.getAttribute('data-id');

                  await notificationService.markRead(
                    id
                  );

                  if (
                    currentView ===
                    'notifications'
                  ) {
                    renderNotificationsPage();
                  } else {
                    fetchStatus();
                  }
                }
              );
            });

          notifPageFeed
            .querySelectorAll(
              '.alert-card[data-active-notif-id]'
            )
            .forEach(card => {
              card.addEventListener(
                'click',
                async e => {
                  if (
                    e.target.closest(
                      '.btn-mark-read'
                    )
                  ) {
                    return;
                  }

                  const id =
                    card.getAttribute(
                      'data-active-notif-id'
                    );

                  const notif =
                    top5.find(
                      item =>
                        String(item.id) ===
                        String(id)
                    );

                  if (
                    notif &&
                    !notif.read
                  ) {
                    await notificationService.markRead(
                      id
                    );

                    if (
                      currentView ===
                      'notifications'
                    ) {
                      renderNotificationsPage();
                    } else {
                      fetchStatus();
                    }
                  }
                }
              );
            });
        } else {
          notifPageFeed.innerHTML =
            '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 16px;">No active alerts</div>';
        }
      }
    } else {
      if (alertsSubtext) {
        alertsSubtext.innerText =
          'No Active Alerts';

        alertsSubtext.style.color =
          'var(--accent-emerald)';
      }

      updateUserNotificationState();
    }

    if (
      document.activeElement !==
      setLowPercent
    ) {
      setLowPercent.value =
        thresholds.lowPercent;
    }

    if (
      document.activeElement !==
      setFullPercent
    ) {
      setFullPercent.value =
        thresholds.fullPercent;
    }

    if (
      document.activeElement !==
      setOverflowPercent
    ) {
      setOverflowPercent.value =
        thresholds.overflowPercent;
    }

    if (
      document.activeElement !==
      inputLowPercent
    ) {
      inputLowPercent.value =
        thresholds.lowPercent;
    }

    if (
      document.activeElement !==
      inputFullPercent
    ) {
      inputFullPercent.value =
        thresholds.fullPercent;
    }

    if (
      document.activeElement !==
      inputOverflowPercent
    ) {
      inputOverflowPercent.value =
        thresholds.overflowPercent;
    }

    inputCapacity.value =
      sensor.tankCapacityLiters;

    if (currentView === 'devices') {
      renderDevicesPage(data);
    }

    if (currentView === 'notifications') {
      renderNotificationsPage();
    }
  }

  // Devices Page Renderer
  function renderDevicesPage(deviceData) {
    const data =
      deviceData || state;

    if (!data || !data.esp32) {
      return;
    }

    const {
      esp32,
      sensor,
      pump,
      buzzer
    } = data;

    const isConnected =
      Boolean(
        esp32 &&
        esp32.connected
      );

    const devBanner =
      document.getElementById(
        'devDisconnectedBanner'
      );

    if (devBanner) {
      if (isConnected) {
        devBanner.classList.add('hidden');
      } else {
        devBanner.classList.remove('hidden');
      }
    }

    // ESP32 Microcontroller Card
    const espPill =
      document.getElementById(
        'devCardEspPill'
      );

    if (espPill) {
      espPill.className =
        isConnected
          ? 'status-pill normal'
          : 'status-pill overflow';

      espPill.innerText =
        isConnected
          ? 'CONNECTED'
          : 'DISCONNECTED';
    }

    document.getElementById(
      'dEspName'
    ).innerText =
      isConnected
        ? (esp32.deviceName ||
          'ESP32 Node-01')
        : 'ESP32 Node-01 (Offline)';

    document.getElementById(
      'dEspIp'
    ).innerText =
      isConnected
        ? (esp32.ipAddress ||
          'Not available')
        : 'Not available';

    document.getElementById(
      'dEspMac'
    ).innerText =
      isConnected
        ? (esp32.macAddress ||
          'Not available')
        : 'Not available';

    document.getElementById(
      'dEspRssi'
    ).innerText =
      isConnected
        ? (
          esp32.wifiRssi
            ? `${esp32.wifiRssi} dBm (Strong)`
            : 'Not available'
        )
        : 'Not available';

    document.getElementById(
      'dEspUptime'
    ).innerText =
      isConnected
        ? (esp32.uptime ||
          'Not available')
        : 'Not available';

    document.getElementById(
      'dEspFw'
    ).innerText =
      isConnected
        ? (esp32.firmware ||
          'Not reported by device')
        : 'Not reported by device';

    document.getElementById(
      'dEspLastPing'
    ).innerText =
      (sensor &&
        sensor.lastReading)
        ? sensor.lastReading
        : (
          isConnected
            ? 'Just Now'
            : 'Never'
        );

    // Water Level Sensor Card
    const sensorPill =
      document.getElementById(
        'devCardSensorPill'
      );

    const sensorHealthElem =
      document.getElementById(
        'dSensorHealth'
      );

    if (isConnected && sensor) {
      if (sensorPill) {
        sensorPill.className =
          'status-pill normal';

        sensorPill.innerText =
          'ACTIVE';
      }

      const rawVal =
        sensor.sensorValue !== null &&
          sensor.sensorValue !== undefined
          ? sensor.sensorValue
          : 0;

      document.getElementById(
        'dSensorRaw'
      ).innerText =
        `${rawVal}`;

      document.getElementById(
        'dSensorPercent'
      ).innerText =
        `${sensor.waterLevelPercent !== null
          ? sensor.waterLevelPercent + '%'
          : '0%'}`;

      if (sensorHealthElem) {
        sensorHealthElem.style.color =
          'var(--accent-emerald)';

        sensorHealthElem.innerText =
          'ACTIVE';
      }

      document.getElementById(
        'dSensorLastReading'
      ).innerText =
        sensor.lastReading ||
        'Just Now';
    } else {
      if (sensorPill) {
        sensorPill.className =
          'status-pill overflow';

        sensorPill.innerText =
          'DISCONNECTED';
      }

      document.getElementById(
        'dSensorRaw'
      ).innerText = '--';

      document.getElementById(
        'dSensorPercent'
      ).innerText = '--';

      if (sensorHealthElem) {
        sensorHealthElem.style.color =
          'var(--accent-red)';

        sensorHealthElem.innerText =
          'NOT AVAILABLE';
      }

      document.getElementById(
        'dSensorLastReading'
      ).innerText =
        (
          sensor &&
          sensor.lastReading
        )
          ? sensor.lastReading
          : 'Never';
    }

    // L293D Motor Driver & Pump Card
    const pumpPill =
      document.getElementById(
        'devCardPumpPill'
      );

    if (isConnected && pump) {
      if (pumpPill) {
        pumpPill.className =
          'status-pill normal';

        pumpPill.innerText =
          pump.status === 'ON'
            ? 'PUMPING'
            : 'READY';
      }

      document.getElementById(
        'dPumpStatus'
      ).innerText =
        pump.status || 'OFF';

      document.getElementById(
        'dPumpMode'
      ).innerText =
        pump.mode === 'AUTO'
          ? 'AUTOMATIC'
          : 'MANUAL';

      document.getElementById(
        'dPumpTotalRun'
      ).innerText =
        `${pump.totalRuntimeHours || 0} Hours`;

      document.getElementById(
        'dPumpActivations'
      ).innerText =
        `${pump.activationsToday || 0} Cycles`;

      document.getElementById(
        'dPumpLastAct'
      ).innerText =
        pump.lastActivationTime ||
        'Not available';

    } else {
      if (pumpPill) {
        pumpPill.className =
          'status-pill overflow';

        pumpPill.innerText =
          'NOT AVAILABLE';
      }

      document.getElementById(
        'dPumpStatus'
      ).innerText =
        'Not Available';

      document.getElementById(
        'dPumpMode'
      ).innerText =
        '--';

      document.getElementById(
        'dPumpTotalRun'
      ).innerText =
        '--';

      document.getElementById(
        'dPumpActivations'
      ).innerText =
        '--';

      document.getElementById(
        'dPumpLastAct'
      ).innerText =
        (
          pump &&
          pump.lastActivationTime
        )
          ? pump.lastActivationTime
          : 'Not available';
    }

    // Piezoelectric Buzzer Card
    const buzzerPill =
      document.getElementById(
        'devCardBuzzerPill'
      );

    if (isConnected && buzzer) {
      if (buzzerPill) {
        if (buzzer.active) {
          buzzerPill.className =
            'status-pill overflow';

          buzzerPill.innerText =
            'ALARM ACTIVE';
        } else {
          buzzerPill.className =
            'status-pill normal';

          buzzerPill.innerText =
            buzzer.muted
              ? 'MUTED'
              : (
                buzzer.enabled
                  ? 'ARMED'
                  : 'DISABLED'
              );
        }
      }

      document.getElementById(
        'dBuzzerStatus'
      ).innerText =
        buzzer.active
          ? 'ALARMING (Active)'
          : (
            buzzer.muted
              ? 'Quiet (Muted)'
              : 'Quiet (Standby)'
          );

      document.getElementById(
        'dBuzzerArmed'
      ).innerText =
        buzzer.enabled
          ? 'Enabled & Armed'
          : 'Disabled';

      document.getElementById(
        'dBuzzerCondition'
      ).innerText =
        buzzer.active
          ? (
            buzzer.reason ||
            'ALARM TRIGGERED'
          )
          : 'Normal Operating Range';

    } else {
      if (buzzerPill) {
        buzzerPill.className =
          'status-pill overflow';

        buzzerPill.innerText =
          'NOT AVAILABLE';
      }

      document.getElementById(
        'dBuzzerStatus'
      ).innerText =
        'Not Available';

      document.getElementById(
        'dBuzzerArmed'
      ).innerText =
        'Not Available';

      document.getElementById(
        'dBuzzerCondition'
      ).innerText =
        'Hardware Offline';
    }
  }

  // Analytics Page Renderer
  async function renderAnalyticsPage(
    range = currentAnalyticsRange
  ) {
    currentAnalyticsRange = range;

    const data =
      await analyticsService.getAnalytics(
        range
      );

    if (!data) {
      return;
    }

    // Update active tab buttons
    document
      .querySelectorAll(
        '[data-analytics-range]'
      )
      .forEach(btn => {
        if (
          btn.getAttribute(
            'data-analytics-range'
          ) === range
        ) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

    const avgElem =
      document.getElementById(
        'anAvgLevel'
      );

    const minMaxElem =
      document.getElementById(
        'anMinMax'
      );

    const usageElem =
      document.getElementById(
        'anTotalUsage'
      );

    const runtimeElem =
      document.getElementById(
        'anPumpRuntime'
      );

    const activationsElem =
      document.getElementById(
        'anPumpActivations'
      );

    const minMaxSub =
      document.getElementById(
        'anMinMaxSub'
      );

    const usageSub =
      document.getElementById(
        'anUsageSub'
      );

    const avgSub =
      document.getElementById(
        'anAvgSub'
      );

    if (data.hasData) {
      if (avgElem) {
        avgElem.innerText =
          `${data.waterLevelStats.avg}%`;
      }

      if (minMaxElem) {
        minMaxElem.innerText =
          `${data.waterLevelStats.min}% / ${data.waterLevelStats.max}%`;
      }

      if (usageElem) {
        usageElem.innerText =
          `${data.usageStats.totalLiters.toLocaleString()} L`;
      }
    } else {
      if (avgElem) {
        avgElem.innerText =
          `No data`;
      }

      if (minMaxElem) {
        minMaxElem.innerText =
          `No data available for this period`;
      }

      if (usageElem) {
        usageElem.innerText =
          `0 L`;
      }
    }

    const totalMins =
      data.pumpAnalytics.totalRuntimeMinutes ||
      0;

    let runtimeStr =
      `${totalMins} m`;

    if (totalMins >= 60) {
      runtimeStr =
        `${(totalMins / 60).toFixed(1)} h`;
    }

    if (runtimeElem) {
      runtimeElem.innerText =
        runtimeStr;
    }

    const acts =
      data.pumpAnalytics.activationsCount ||
      0;

    if (activationsElem) {
      if (range === 'today') {
        activationsElem.innerText =
          `${acts} Activations Today`;
      } else if (range === '7d') {
        activationsElem.innerText =
          `${acts} Activations in 7 Days`;
      } else if (range === 'month') {
        activationsElem.innerText =
          `${acts} Activations This Month`;
      } else if (range === 'year') {
        activationsElem.innerText =
          `${acts} Activations This Year`;
      }
    }

    if (minMaxSub) {
      if (!data.hasData) {
        minMaxSub.innerText =
          'No data available for this period.';
      } else if (data.rangeSubtitle) {
        minMaxSub.innerText =
          data.rangeSubtitle;
      } else {
        minMaxSub.innerText =
          range === 'today'
            ? 'Today'
            : (
              range === '7d'
                ? 'Past 7 Days'
                : (
                  range === 'month'
                    ? 'Current Month'
                    : 'Current Year'
                )
            );
      }
    }

    if (avgSub) {
      avgSub.innerText =
        `Target range 20% - 85%`;
    }

    // Chart 1
    const ctx1 =
      document.getElementById(
        'analyticsWaterChart'
      ).getContext('2d');

    if (analyticsWaterChart) {
      analyticsWaterChart.destroy();
    }

    analyticsWaterChart =
      new Chart(ctx1, {
        type: 'line',

        data: {
          labels:
            data.waterChart
              ? data.waterChart.labels
              : [],

          datasets: [{
            label: 'Water Level (%)',
            data:
              data.waterChart
                ? data.waterChart.data
                : [],

            borderColor: '#06b6d4',
            borderWidth: 3,
            backgroundColor:
              'rgba(6, 182, 212, 0.15)',

            fill: true,
            tension: 0.3,
            spanGaps: false
          }]
        },

        options: {
          responsive: true,
          maintainAspectRatio: false,

          plugins: {
            legend: {
              display: false
            },

            tooltip: {
              callbacks: {
                label: context =>
                  context.raw !== null
                    ? `Water Level: ${context.raw}%`
                    : 'No Data'
              }
            }
          },

          scales: {
            x: {
              grid: {
                color:
                  'rgba(255, 255, 255, 0.05)'
              },

              ticks: {
                color: '#64748b'
              }
            },

            y: {
              min: 0,
              max: 100,

              grid: {
                color:
                  'rgba(255, 255, 255, 0.05)'
              },

              ticks: {
                color: '#64748b',
                callback: v => v + '%'
              }
            }
          }
        }
      });

    // Chart 2
    const ctx2 =
      document.getElementById(
        'analyticsUsageChart'
      ).getContext('2d');

    if (analyticsUsageChart) {
      analyticsUsageChart.destroy();
    }

    analyticsUsageChart =
      new Chart(ctx2, {
        type: 'bar',

        data: {
          labels:
            data.usageChart
              ? data.usageChart.labels
              : [],

          datasets: [{
            label: 'Consumption (Liters)',
            data:
              data.usageChart
                ? data.usageChart.data
                : [],

            backgroundColor: '#38bdf8',
            borderRadius: 6,
            skipNull: true
          }]
        },

        options: {
          responsive: true,
          maintainAspectRatio: false,

          plugins: {
            legend: {
              display: false
            },

            tooltip: {
              callbacks: {
                label: context =>
                  context.raw !== null
                    ? `Usage: ${context.raw.toLocaleString()} L`
                    : 'No Data'
              }
            }
          },

          scales: {
            x: {
              grid: {
                color:
                  'rgba(255, 255, 255, 0.05)'
              },

              ticks: {
                color: '#64748b'
              }
            },

            y: {
              grid: {
                color:
                  'rgba(255, 255, 255, 0.05)'
              },

              ticks: {
                color: '#64748b',

                callback: v =>
                  v.toLocaleString() + 'L'
              }
            }
          }
        }
      });
  }

  // History Page Renderer
  async function renderHistoryPage() {
    const cat =
      document.getElementById(
        'historyCategorySelect'
      ).value;

    const search =
      document.getElementById(
        'historySearchInput'
      ).value;

    const res =
      await historyService.getHistory(
        cat,
        search
      );

    const tbody =
      document.getElementById(
        'historyTableBody'
      );

    if (!res || !res.data) {
      return;
    }

    if (res.data.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td
            colspan="8"
            style="text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px;"
          >
            No events found for this category.
          </td>
        </tr>
      `;

      return;
    }

    tbody.innerHTML =
      res.data.map(item => {
        let pillClass = 'normal';

        const categoryName =
          item.category ||
          'Sensor Readings';

        if (
          categoryName ===
          'Alarm Events'
        ) {
          pillClass = 'overflow';
        } else if (
          categoryName ===
          'Pump Events'
        ) {
          pillClass = 'low';
        } else if (
          categoryName ===
          'System Events'
        ) {
          pillClass = 'full';
        }

        const lvlStr =
          item.waterLevelPercent !== null &&
            item.waterLevelPercent !== undefined
            ? `${item.waterLevelPercent}%`
            : '--';

        const sensorValStr =
          item.sensorValue !== null &&
            item.sensorValue !== undefined
            ? `${item.sensorValue}`
            : '--';

        return `
          <tr>
            <td style="white-space: nowrap;">
              ${item.date} ${item.time}
            </td>

            <td>
              <span
                class="status-pill ${pillClass}"
                style="font-size: 11px; padding: 2px 8px;"
              >
                ${categoryName}
              </span>
            </td>

            <td>
              <strong style="color: var(--text-primary);">
                ${item.event || 'Periodic Reading'}
              </strong>
            </td>

            <td>
              <strong style="color: var(--accent-blue);">
                ${lvlStr}
              </strong>
            </td>

            <td>
              ${sensorValStr}
            </td>

            <td>
              <span
                class="status-pill ${item.pumpStatus === 'ON' ? 'normal' : 'low'}"
              >
                ${item.pumpStatus || 'OFF'}
              </span>
            </td>

            <td>
              ${item.mode || 'AUTO'}
            </td>

            <td>
              <span
                class="status-pill ${item.buzzerStatus === 'ALARM' ? 'overflow' : 'normal'}"
              >
                ${item.buzzerStatus || 'QUIET'}
              </span>
            </td>
          </tr>
        `;
      }).join('');
  }

  document
    .getElementById(
      'historyCategorySelect'
    )
    .addEventListener(
      'change',
      renderHistoryPage
    );

  document
    .getElementById(
      'historySearchInput'
    )
    .addEventListener(
      'input',
      renderHistoryPage
    );

  const btnExportCsv =
    document.getElementById(
      'btnExportCsv'
    );

  if (btnExportCsv) {
    btnExportCsv.addEventListener(
      'click',
      () => {
        const cat =
          document.getElementById(
            'historyCategorySelect'
          ).value;

        const search =
          document.getElementById(
            'historySearchInput'
          ).value;

        window.location.href =
          `/api/history/full?category=${cat}&search=${encodeURIComponent(search)}&format=csv`;
      }
    );
  }

  // Notifications Page Renderer & Email Settings Handlers
  const chkEmailNotifications =
    document.getElementById(
      'chkEmailNotifications'
    );

  const chkEmergencyAlerts =
    document.getElementById(
      'chkEmergencyAlerts'
    );

  const chkDailyDigest =
    document.getElementById(
      'chkDailyDigest'
    );

  const registeredEmailRecipientDisplay =
    document.getElementById(
      'registeredEmailRecipientDisplay'
    );

  const btnSendTestEmail =
    document.getElementById(
      'btnSendTestEmail'
    );

  const btnSaveIntegrations =
    document.getElementById(
      'btnSaveIntegrations'
    );

  const btnTriggerDigest =
    document.getElementById(
      'btnTriggerDigest'
    );

  const notifAlertErrorBox =
    document.getElementById(
      'notifAlertErrorBox'
    );

  const notifAlertErrorText =
    document.getElementById(
      'notifAlertErrorText'
    );

  const notifAlertSuccessBox =
    document.getElementById(
      'notifAlertSuccessBox'
    );

  const notifAlertSuccessText =
    document.getElementById(
      'notifAlertSuccessText'
    );

  function showNotifAlert(
    msg,
    isSuccess = true
  ) {
    if (isSuccess) {
      if (notifAlertErrorBox) {
        notifAlertErrorBox.classList.add(
          'hidden'
        );
      }

      if (notifAlertSuccessText) {
        notifAlertSuccessText.innerText =
          msg;
      }

      if (notifAlertSuccessBox) {
        notifAlertSuccessBox.classList.remove(
          'hidden'
        );
      }
    } else {
      if (notifAlertSuccessBox) {
        notifAlertSuccessBox.classList.add(
          'hidden'
        );
      }

      if (notifAlertErrorText) {
        notifAlertErrorText.innerText =
          msg;
      }

      if (notifAlertErrorBox) {
        notifAlertErrorBox.classList.remove(
          'hidden'
        );
      }
    }
  }

  async function loadNotificationPreferences() {
    try {
      const res =
        await fetch(
          '/api/notifications/preferences',
          {
            headers: getAuthHeaders()
          }
        );

      const data =
        await res.json();

      if (data && data.email) {
        if (
          registeredEmailRecipientDisplay
        ) {
          registeredEmailRecipientDisplay.innerText =
            data.email;
        }

        if (displayEmail) {
          displayEmail.innerText =
            data.email;
        }

        const emailNotifs =
          data.emailNotifications !== undefined
            ? data.emailNotifications
            : data.email_notifications;

        const emAlerts =
          data.emergencyAlerts !== undefined
            ? data.emergencyAlerts
            : data.emergency_alerts;

        const digest =
          data.dailyDigest !== undefined
            ? data.dailyDigest
            : data.daily_digest;

        if (chkEmailNotifications) {
          chkEmailNotifications.checked =
            Boolean(emailNotifs);
        }

        if (chkEmergencyAlerts) {
          chkEmergencyAlerts.checked =
            Boolean(emAlerts);
        }

        if (chkDailyDigest) {
          chkDailyDigest.checked =
            Boolean(digest);
        }
      } else {
        if (
          registeredEmailRecipientDisplay
        ) {
          registeredEmailRecipientDisplay.innerText =
            'Not available';
        }
      }
    } catch (err) {
      console.error(
        'Failed to load notification preferences:',
        err
      );
    }
  }

  if (btnSaveIntegrations) {
    btnSaveIntegrations.addEventListener(
      'click',
      async () => {
        try {
          const payload = {
            emailNotifications:
              chkEmailNotifications
                ? chkEmailNotifications.checked
                : true,

            emergencyAlerts:
              chkEmergencyAlerts
                ? chkEmergencyAlerts.checked
                : true,

            dailyDigest:
              chkDailyDigest
                ? chkDailyDigest.checked
                : true,

            email_notifications:
              chkEmailNotifications
                ? chkEmailNotifications.checked
                : true,

            emergency_alerts:
              chkEmergencyAlerts
                ? chkEmergencyAlerts.checked
                : true,

            daily_digest:
              chkDailyDigest
                ? chkDailyDigest.checked
                : true
          };

          const res =
            await fetch(
              '/api/notifications/preferences',
              {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(payload)
              }
            );

          const data =
            await res.json();

          if (
            res.ok &&
            data.success
          ) {
            showNotifAlert(
              'Notification preferences saved successfully!',
              true
            );

            await loadNotificationPreferences();

          } else {
            showNotifAlert(
              data.error ||
              'Failed to save notification preferences.',
              false
            );
          }

        } catch (err) {
          showNotifAlert(
            'Network error saving preferences.',
            false
          );
        }
      }
    );
  }

  if (btnTriggerDigest) {
    btnTriggerDigest.addEventListener(
      'click',
      async () => {
        btnTriggerDigest.disabled = true;

        const originalText =
          btnTriggerDigest.innerHTML;

        btnTriggerDigest.innerHTML =
          '<i class="ri-loader-4-line ri-spin"></i> Dispatching...';

        try {
          const res =
            await fetch(
              '/api/notifications/digest',
              {
                method: 'POST',
                headers: getAuthHeaders()
              }
            );

          const data =
            await res.json();

          if (
            res.ok &&
            data.success &&
            data.status === 'SENT'
          ) {
            showNotifAlert(
              data.message ||
              'Daily digest sent successfully.',
              true
            );

            renderNotificationsPage();

          } else if (data.skipped) {
            showNotifAlert(
              data.error ||
              data.reason ||
              'Daily digest is disabled in your notification preferences.',
              false
            );

          } else {
            showNotifAlert(
              data.error ||
              data.errorMessage ||
              'Failed to send daily digest.',
              false
            );
          }

        } catch (err) {
          showNotifAlert(
            'Network error sending daily digest.',
            false
          );
        } finally {
          btnTriggerDigest.disabled =
            false;

          btnTriggerDigest.innerHTML =
            originalText;
        }
      }
    );
  }

  // View All Modal Controls
  const viewAllModal =
    document.getElementById(
      'viewAllNotificationsModal'
    );

  const btnViewAll =
    document.getElementById(
      'btnViewAllNotifications'
    );

  const closeViewAllModalBtn =
    document.getElementById(
      'closeViewAllModalBtn'
    );

  const btnMarkAllReadModal =
    document.getElementById(
      'btnMarkAllReadModal'
    );

  function openViewAllModal() {
    if (viewAllModal) {
      viewAllModal.classList.add(
        'open'
      );

      renderViewAllModalList();
    }
  }

  function closeViewAllModal() {
    if (viewAllModal) {
      viewAllModal.classList.remove(
        'open'
      );
    }
  }

  const btnDashboardViewAll =
    document.getElementById(
      'btnDashboardViewAll'
    );

  const btnRecentActivityViewAll =
    document.getElementById(
      'btnRecentActivityViewAll'
    );

  if (btnViewAll) {
    btnViewAll.addEventListener(
      'click',
      openViewAllModal
    );
  }

  if (btnDashboardViewAll) {
    btnDashboardViewAll.addEventListener(
      'click',
      openViewAllModal
    );
  }

  if (btnRecentActivityViewAll) {
    btnRecentActivityViewAll.addEventListener(
      'click',
      () => switchView('history')
    );
  }

  if (closeViewAllModalBtn) {
    closeViewAllModalBtn.addEventListener(
      'click',
      closeViewAllModal
    );
  }

  if (btnMarkAllReadModal) {
    btnMarkAllReadModal.addEventListener(
      'click',
      async () => {
        await notificationService.markRead(
          'all'
        );

        if (
          currentView ===
          'notifications'
        ) {
          renderNotificationsPage();
        } else {
          fetchStatus();
        }
      }
    );
  }

  async function renderViewAllModalList() {
    const data =
      await notificationService.getNotifications();

    if (!data) {
      return;
    }

    const modalList =
      document.getElementById(
        'viewAllUnreadList'
      );

    const modalCountLabel =
      document.getElementById(
        'viewAllUnreadCountLabel'
      );

    const unreadNotifs =
      data.unreadNotifications ||
      [];

    if (modalCountLabel) {
      modalCountLabel.innerText =
        `${unreadNotifs.length} unread notification${unreadNotifs.length === 1 ? '' : 's'}`;
    }

    if (modalList) {
      if (
        unreadNotifs.length === 0
      ) {
        modalList.innerHTML =
          '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 24px;">No unread notifications</div>';

      } else {
        modalList.innerHTML =
          unreadNotifs.map(n => `
            <div
              class="alert-card ${n.severity}"
              style="display: flex; justify-content: space-between; align-items: flex-start; cursor: pointer;"
              data-notif-id="${n.id}"
            >
              <div
                style="display: flex; gap: 12px; align-items: flex-start; flex: 1; min-width: 0;"
              >
                <i
                  class="ri-alert-fill"
                  style="font-size: 20px; margin-top: 2px; flex-shrink: 0;"
                ></i>

                <div
                  style="min-width: 0; flex: 1; overflow-wrap: anywhere; word-break: break-word;"
                >
                  <div class="alert-title">
                    ${n.title}
                  </div>

                  <div class="alert-msg">
                    ${n.message}
                  </div>

                  <div
                    style="font-size: 10px; color: var(--text-muted); margin-top: 4px;"
                  >
                    ${n.dateStr}
                  </div>
                </div>
              </div>

              <button
                class="btn-tab btn-mark-read"
                data-id="${n.id}"
                style="font-size: 11px; padding: 4px 8px; margin-left: 8px; white-space: nowrap; flex-shrink: 0; background: rgba(16, 185, 129, 0.15); color: var(--accent-emerald); border: 1px solid var(--accent-emerald);"
              >
                <i class="ri-check-line"></i> Read
              </button>
            </div>
          `).join('');

        modalList
          .querySelectorAll(
            '.btn-mark-read'
          )
          .forEach(btn => {
            btn.addEventListener(
              'click',
              async e => {
                e.stopPropagation();

                const id =
                  btn.getAttribute(
                    'data-id'
                  );

                await notificationService.markRead(
                  id
                );

                if (
                  currentView ===
                  'notifications'
                ) {
                  renderNotificationsPage();
                } else {
                  fetchStatus();
                }
              }
            );
          });

        modalList
          .querySelectorAll(
            '.alert-card[data-notif-id]'
          )
          .forEach(card => {
            card.addEventListener(
              'click',
              async e => {
                if (
                  e.target.closest(
                    '.btn-mark-read'
                  )
                ) {
                  return;
                }

                const id =
                  card.getAttribute(
                    'data-notif-id'
                  );

                await notificationService.markRead(
                  id
                );

                if (
                  currentView ===
                  'notifications'
                ) {
                  renderNotificationsPage();
                } else {
                  fetchStatus();
                }
              }
            );
          });
      }
    }
  }

  async function renderNotificationsPage() {
    loadNotificationPreferences();

    const data =
      await notificationService.getNotifications();

    if (!data) {
      return;
    }

    const activeFeed =
      document.getElementById(
        'notificationsActiveFeed'
      );

    const historyList =
      document.getElementById(
        'notificationsHistoryList'
      );

    if (valAlertsCount) {
      valAlertsCount.innerText =
        data.unreadCount || 0;
    }

    updateSidebarNotificationBadge(
      data.unreadCount || 0
    );

    if (activeFeed) {
      const allNotifs =
        Array.isArray(
          data.notifications
        )
          ? data.notifications
          : [];

      const sortedNotifs =
        [...allNotifs].sort(
          (a, b) =>
            (b.timestamp || 0) -
            (a.timestamp || 0)
        );

      const top5 =
        sortedNotifs.slice(0, 5);

      if (top5.length > 0) {
        activeFeed.innerHTML =
          top5.map(n => `
            <div
              class="alert-card ${n.severity}"
              style="cursor: pointer; display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;"
              data-active-notif-id="${n.id}"
            >
              <div
                style="display: flex; gap: 12px; align-items: flex-start; flex: 1; min-width: 0;"
              >
                <i
                  class="ri-alert-fill"
                  style="font-size: 20px; margin-top: 2px; flex-shrink: 0;"
                ></i>

                <div
                  style="min-width: 0; flex: 1; overflow-wrap: anywhere; word-break: break-word;"
                >
                  <div class="alert-title">
                    ${n.title}
                    ${n.read
              ? ''
              : '<span class="status-pill overflow" style="font-size: 9px; padding: 1px 6px; margin-left: 6px;">UNREAD</span>'}
                  </div>

                  <div class="alert-msg">
                    ${n.message}
                  </div>

                  <div
                    style="font-size: 10px; color: var(--text-muted); margin-top: 4px;"
                  >
                    ${n.dateStr}
                  </div>
                </div>
              </div>

              ${!n.read
              ? `
                <button
                  class="btn-tab btn-mark-read"
                  data-id="${n.id}"
                  style="font-size: 11px; padding: 4px 8px; margin-left: 8px; white-space: nowrap; flex-shrink: 0; background: rgba(16, 185, 129, 0.15); color: var(--accent-emerald); border: 1px solid var(--accent-emerald);"
                >
                  <i class="ri-check-line"></i> Read
                </button>
              `
              : ''}
            </div>
          `).join('');

        activeFeed
          .querySelectorAll(
            '.btn-mark-read'
          )
          .forEach(btn => {
            btn.addEventListener(
              'click',
              async e => {
                e.stopPropagation();

                const id =
                  btn.getAttribute(
                    'data-id'
                  );

                await notificationService.markRead(
                  id
                );

                renderNotificationsPage();
              }
            );
          });

        activeFeed
          .querySelectorAll(
            '.alert-card[data-active-notif-id]'
          )
          .forEach(card => {
            card.addEventListener(
              'click',
              async e => {
                if (
                  e.target.closest(
                    '.btn-mark-read'
                  )
                ) {
                  return;
                }

                const id =
                  card.getAttribute(
                    'data-active-notif-id'
                  );

                const notif =
                  top5.find(
                    item =>
                      String(item.id) ===
                      String(id)
                  );

                if (
                  notif &&
                  !notif.read
                ) {
                  await notificationService.markRead(
                    id
                  );

                  renderNotificationsPage();
                }
              }
            );
          });

      } else {
        activeFeed.innerHTML =
          '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 16px;">No active alerts</div>';
      }
    }

    if (historyList) {
      historyList.innerHTML =
        data.notifications.map(
          n => `
            <div class="log-item">
              <div class="log-icon ${n.severity}">
                <i class="ri-notification-3-line"></i>
              </div>

              <div class="log-content">
                <div class="log-title">
                  ${n.title}
                  ${n.read
              ? ''
              : '<span class="status-pill overflow" style="font-size: 9px; padding: 1px 6px;">UNREAD</span>'
            }
                </div>

                <div class="log-desc">
                  ${n.message}
                </div>

                ${n.recipientEmail
              ? `
                    <div
                      style="font-size: 11px; color: var(--accent-blue); margin-top: 2px;"
                    >
                      <i class="ri-mail-send-line"></i>
                      Recipient:
                      <strong>${n.recipientEmail}</strong>
                      (${n.emailStatus || 'SENT'})
                    </div>
                  `
              : ''
            }
              </div>

              <div class="log-time">
                ${n.dateStr}
              </div>
            </div>
          `
        ).join('');
    }

    if (
      viewAllModal &&
      viewAllModal.classList.contains('open')
    ) {
      renderViewAllModalList();
    }
  }

  document
    .getElementById(
      'btnMarkAllRead'
    )
    .addEventListener(
      'click',
      async () => {
        await notificationService.markRead(
          'all'
        );

        renderNotificationsPage();
      }
    );

  document
    .getElementById(
      'btnClearNotifications'
    )
    .addEventListener(
      'click',
      async () => {
        await notificationService.clear();

        renderNotificationsPage();
      }
    );

  // Settings Page Renderer
  function renderSettingsPage() {
    updateAdminPasswordCardVisibility();

    if (!state) {
      return;
    }

    setLowPercent.value =
      state.thresholds.lowPercent;

    setFullPercent.value =
      state.thresholds.fullPercent;

    setOverflowPercent.value =
      state.thresholds.overflowPercent;

    setMaxRuntime.value =
      state.thresholds.maxPumpTimeoutMinutes;

    setBuzzerEnabled.checked =
      Boolean(state.buzzer.enabled);

    settingsValidationError.classList.add(
      'hidden'
    );
  }

  // Full Settings Form Handler
  fullSettingsForm.addEventListener(
    'submit',
    async e => {
      e.preventDefault();

      const lowStr =
        setLowPercent.value;

      const fullStr =
        setFullPercent.value;

      const overflowStr =
        setOverflowPercent.value;

      const valResult =
        validateThresholdInputs(
          lowStr,
          fullStr,
          overflowStr
        );

      if (!valResult.valid) {
        settingsValidationMsg.innerText =
          valResult.message;

        settingsValidationError.classList.remove(
          'hidden'
        );

        return;
      }

      settingsValidationError.classList.add(
        'hidden'
      );

      const payload = {
        thresholds: {
          lowPercent:
            valResult.low,

          fullPercent:
            valResult.full,

          overflowPercent:
            valResult.overflow,

          maxPumpTimeoutMinutes:
            parseInt(
              setMaxRuntime.value
            )
        },

        buzzer: {
          enabled:
            setBuzzerEnabled.checked
        }
      };

      try {
        const res =
          await settingsService.saveSettings(
            payload
          );

        if (res.error) {
          settingsValidationMsg.innerText =
            res.error;

          settingsValidationError.classList.remove(
            'hidden'
          );
        } else {
          alert(
            'Configuration settings saved successfully!'
          );
        }

      } catch (err) {
        console.error(
          'Save error:',
          err
        );
      }
    }
  );

  document
    .getElementById(
      'btnResetSettings'
    )
    .addEventListener(
      'click',
      async () => {
        if (
          confirm(
            'Are you sure you want to reset settings to factory defaults?'
          )
        ) {
          await settingsService.resetDefaults();

          renderSettingsPage();
        }
      }
    );

  // Quick Settings Modal Form Handler
  thresholdsForm.addEventListener(
    'submit',
    async e => {
      e.preventDefault();

      const lowStr =
        inputLowPercent.value;

      const fullStr =
        inputFullPercent.value;

      const overflowStr =
        inputOverflowPercent.value;

      const valResult =
        validateThresholdInputs(
          lowStr,
          fullStr,
          overflowStr
        );

      if (!valResult.valid) {
        modalValidationMsg.innerText =
          valResult.message;

        modalValidationError.classList.remove(
          'hidden'
        );

        return;
      }

      modalValidationError.classList.add(
        'hidden'
      );

      const payload = {
        lowPercent:
          valResult.low,

        fullPercent:
          valResult.full,

        overflowPercent:
          valResult.overflow,

        tankCapacityLiters:
          parseInt(
            inputCapacity.value
          )
      };

      try {
        const res =
          await settingsService.saveThresholds(
            payload
          );

        if (res.error) {
          modalValidationMsg.innerText =
            res.error;

          modalValidationError.classList.remove(
            'hidden'
          );
        } else {
          closeSettingsModal();
        }

      } catch (err) {
        console.error(
          'Save error:',
          err
        );
      }
    }
  );

  function openSettingsModal() {
    modalValidationError.classList.add(
      'hidden'
    );

    settingsModal.classList.add(
      'open'
    );
  }

  function closeSettingsModal() {
    modalValidationError.classList.add(
      'hidden'
    );

    settingsModal.classList.remove(
      'open'
    );
  }

  btnConfigThresholds.addEventListener(
    'click',
    openSettingsModal
  );

  closeSettingsBtn.addEventListener(
    'click',
    closeSettingsModal
  );

  // Time-period filter buttons for Analytics
  document
    .querySelectorAll(
      '[data-analytics-range]'
    )
    .forEach(btn => {
      btn.addEventListener(
        'click',
        e => {
          const range =
            e.target.getAttribute(
              'data-analytics-range'
            );

          document
            .querySelectorAll(
              '[data-analytics-range]'
            )
            .forEach(b => {
              if (
                b.getAttribute(
                  'data-analytics-range'
                ) === range
              ) {
                b.classList.add(
                  'active'
                );
              } else {
                b.classList.remove(
                  'active'
                );
              }
            });

          currentAnalyticsRange =
            range;

          renderAnalyticsPage(
            range
          );
        }
      );
    });

  document
    .querySelectorAll(
      '[data-range]'
    )
    .forEach(btn => {
      btn.addEventListener(
        'click',
        e => {
          const range =
            e.target.getAttribute(
              'data-range'
            );

          document
            .querySelectorAll(
              '[data-range]'
            )
            .forEach(b => {
              if (
                b.getAttribute(
                  'data-range'
                ) === range
              ) {
                b.classList.add(
                  'active'
                );
              } else {
                b.classList.remove(
                  'active'
                );
              }
            });

          currentDashboardRange =
            range;

          if (state) {
            renderUI(state);
          }
        }
      );
    });

  // WebSocket Setup
  function connectWebSocket() {
    const protocol =
      window.location.protocol === 'https:'
        ? 'wss:'
        : 'ws:';

    const wsUrl =
      `${protocol}//${window.location.host}/ws`;

    ws =
      new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(
        '⚡ Connected to ESP32 WebSocket Dashboard Stream'
      );
    };

    ws.onmessage = event => {
      try {
        const message =
          JSON.parse(
            event.data
          );

        if (
          message.type ===
          'TELEMETRY_UPDATE'
        ) {
          console.log(
            '[WS_RENDER_DATA]',
            {
              timestamp:
                new Date().toISOString(),

              type:
                message.type,

              pump:
                message.data?.pump
            }
          );

          if (
            message.data?.pump?.mode ===
            'AUTO'
          ) {
            console.trace(
              '[WS_AUTO_TRACE]'
            );
          }

          renderUI(
            message.data
          );

          if (
            currentView ===
            'notifications'
          ) {
            renderNotificationsPage();
          }
        }

      } catch (err) {
        console.error(
          'Failed parsing WS frame:',
          err
        );
      }
    };

    ws.onclose = () => {
      setTimeout(
        connectWebSocket,
        3000
      );
    };
  }

  // Initial HTTP Fetch
  async function fetchStatus() {
    try {
      const res =
        await fetch(
          '/api/status',
          {
            headers:
              getAuthHeaders()
          }
        );

      const data =
        await res.json();

      console.log(
        '[FETCH_STATUS_RESPONSE]',
        {
          timestamp:
            new Date().toISOString(),

          pump:
            data?.state?.pump
        }
      );

      console.trace(
        '[FETCH_STATUS_CALL_STACK]'
      );

      if (data.state) {
        renderUI({
          ...data.state,
          history:
            data.history,

          activityLogs:
            data.activityLogs,

          notifications:
            data.notifications || []
        });
      }

    } catch (e) {
      console.error(
        'Failed fetching initial status:',
        e
      );
    }
  }

  // Authentication UI & Multi-View Handlers
  const loginContainer =
    document.getElementById(
      'loginContainer'
    );

  const btnLogout =
    document.getElementById(
      'btnLogout'
    );

  const displayUsername =
    document.getElementById(
      'displayUsername'
    );

  const displayEmail =
    document.getElementById(
      'displayEmail'
    );

  const displayRole =
    document.getElementById(
      'displayRole'
    );

  let currentUser = null;

  function updateAdminPasswordCardVisibility() {
    const adminCard =
      document.getElementById(
        'adminPasswordChangeCard'
      );

    if (!adminCard) {
      return;
    }

    const isDeveloperOrAdmin =
      currentUser &&
      (
        currentUser.role === 'admin' ||
        currentUser.role === 'developer'
      );

    if (isDeveloperOrAdmin) {
      adminCard.classList.remove(
        'hidden'
      );

      adminCard.style.display =
        '';
    } else {
      adminCard.classList.add(
        'hidden'
      );

      adminCard.style.display =
        'none';
    }
  }

  function updateAuthUserUI(user) {
    currentUser =
      user || null;

    if (currentUser) {
      if (displayUsername) {
        displayUsername.innerText =
          currentUser.name ||
          currentUser.username;
      }

      if (displayEmail) {
        displayEmail.innerText =
          currentUser.email;
      }

      if (displayRole) {
        displayRole.innerText =
          (
            currentUser.role ||
            'user'
          ).toUpperCase();
      }
    } else {
      if (displayUsername) {
        displayUsername.innerText =
          'Admin';
      }

      if (displayEmail) {
        displayEmail.innerText =
          '';
      }

      if (displayRole) {
        displayRole.innerText =
          'ADMIN';
      }
    }

    updateAdminPasswordCardVisibility();
  }

  // Auth Views
  const authViews = {
    signIn:
      document.getElementById(
        'authViewSignIn'
      ),

    register:
      document.getElementById(
        'authViewRegister'
      ),

    forgot:
      document.getElementById(
        'authViewForgot'
      ),

    verifyOtp:
      document.getElementById(
        'authViewVerifyOtp'
      ),

    reset:
      document.getElementById(
        'authViewReset'
      )
  };

  // Switch Auth View Helper
  function switchAuthView(
    viewName
  ) {
    Object.keys(
      authViews
    ).forEach(key => {
      if (authViews[key]) {
        authViews[key].classList.add(
          'hidden'
        );
      }
    });

    if (authViews[viewName]) {
      authViews[viewName].classList.remove(
        'hidden'
      );
    }

    // Clear error & success boxes
    document
      .querySelectorAll(
        '.login-error, .login-success'
      )
      .forEach(
        el =>
          el.classList.add(
            'hidden'
          )
      );

    if (viewName === 'register') {
      checkSetupStatus();
    }
  }

  // Password Visibility Toggles
  document
    .querySelectorAll(
      '[data-toggle-pw]'
    )
    .forEach(btn => {
      btn.addEventListener(
        'click',
        () => {
          const targetId =
            btn.getAttribute(
              'data-toggle-pw'
            );

          const input =
            document.getElementById(
              targetId
            );

          const icon =
            btn.querySelector(
              'i'
            );

          if (
            input &&
            icon
          ) {
            if (
              input.type ===
              'password'
            ) {
              input.type =
                'text';

              icon.className =
                'ri-eye-off-line';
            } else {
              input.type =
                'password';

              icon.className =
                'ri-eye-line';
            }
          }
        }
      );
    });

  // Auth View Navigation Links
  document
    .querySelectorAll(
      '[data-show-auth]'
    )
    .forEach(link => {
      link.addEventListener(
        'click',
        e => {
          e.preventDefault();

          const target =
            link.getAttribute(
              'data-show-auth'
            );

          switchAuthView(
            target
          );
        }
      );
    });

  // Check Registration Setup Status
  async function checkSetupStatus() {
    const setupNotice =
      document.getElementById(
        'setupNotice'
      );

    const regCodeGroup =
      document.getElementById(
        'regCodeGroup'
      );

    try {
      const res =
        await fetch(
          '/api/auth/setup-status'
        );

      const data =
        await res.json();

      if (data.isInitialSetup) {
        if (setupNotice) {
          setupNotice.classList.remove(
            'hidden'
          );
        }

        if (regCodeGroup) {
          regCodeGroup.classList.add(
            'hidden'
          );
        }
      } else {
        if (setupNotice) {
          setupNotice.classList.add(
            'hidden'
          );
        }

        if (regCodeGroup) {
          regCodeGroup.classList.remove(
            'hidden'
          );
        }
      }

    } catch (err) {
      console.error(
        'Failed to fetch setup status:',
        err
      );
    }
  }

  // Check Authentication Status
  async function checkAuth() {
    const token =
      getAuthToken();

    if (!token) {
      updateAuthUserUI(
        null
      );

      if (valAlertsCount) {
        valAlertsCount.innerText =
          '0';
      }

      updateSidebarNotificationBadge(
        0
      );

      showLoginForm();

      return false;
    }

    try {
      const res =
        await fetch(
          '/api/auth/verify',
          {
            headers:
              getAuthHeaders()
          }
        );

      if (res.ok) {
        const data =
          await res.json();

        if (data.user) {
          updateAuthUserUI(
            data.user
          );
        } else {
          updateAuthUserUI(
            null
          );
        }

        hideLoginForm();

        return true;

      } else {
        localStorage.removeItem(
          'smartwater_auth_token'
        );

        updateAuthUserUI(
          null
        );

        if (valAlertsCount) {
          valAlertsCount.innerText =
            '0';
        }

        updateSidebarNotificationBadge(
          0
        );

        showLoginForm();

        return false;
      }

    } catch (err) {
      console.error(
        'Auth verification error:',
        err
      );

      updateAuthUserUI(
        null
      );

      if (valAlertsCount) {
        valAlertsCount.innerText =
          '0';
      }

      updateSidebarNotificationBadge(
        0
      );

      showLoginForm();

      return false;
    }
  }

  // Helper for Email Validation
  function isValidEmailFormat(email) {
    if (
      !email ||
      typeof email !==
      'string'
    ) {
      return false;
    }

    return /^[a-zA-Z0-9._%+-]+@([a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}$/.test(
      email.trim()
    );
  }

  async function showLoginForm() {
    loginContainer.classList.remove(
      'hidden'
    );

    if (loginUsernameInput) {
      loginUsernameInput.value =
        '';
    }

    if (loginPasswordInput) {
      loginPasswordInput.value =
        '';
    }

    const urlParams =
      new URLSearchParams(
        window.location.search
      );

    const tokenParam =
      urlParams.get(
        'token'
      );

    if (tokenParam) {
      switchAuthView(
        'reset'
      );
    } else {
      switchAuthView(
        'signIn'
      );
    }
  }

  function hideLoginForm() {
    loginContainer.classList.add(
      'hidden'
    );
  }

  // SIGN IN FORM HANDLER
  const loginForm =
    document.getElementById(
      'signInForm'
    ) ||
    document.getElementById(
      'loginForm'
    );

  const loginUsernameInput =
    document.getElementById(
      'loginUsername'
    );

  const loginPasswordInput =
    document.getElementById(
      'loginPassword'
    );

  const btnLoginSubmit =
    document.getElementById(
      'btnSignInSubmit'
    ) ||
    document.getElementById(
      'btnLoginSubmit'
    );

  const btnLoginText =
    document.getElementById(
      'btnSignInText'
    ) ||
    document.getElementById(
      'btnLoginText'
    );

  const loginErrorBox =
    document.getElementById(
      'signInErrorBox'
    ) ||
    document.getElementById(
      'loginErrorBox'
    );

  const loginErrorText =
    document.getElementById(
      'signInErrorText'
    ) ||
    document.getElementById(
      'loginErrorText'
    );

  if (loginForm) {
    loginForm.addEventListener(
      'submit',
      async e => {
        e.preventDefault();

        const username =
          loginUsernameInput
            ? loginUsernameInput.value.trim()
            : '';

        const password =
          loginPasswordInput
            ? loginPasswordInput.value
            : '';

        if (!username) {
          if (loginErrorText) {
            loginErrorText.innerText =
              'Please enter your username or email.';
          }

          if (loginErrorBox) {
            loginErrorBox.classList.remove(
              'hidden'
            );
          }

          return;
        }

        if (!password) {
          if (loginErrorText) {
            loginErrorText.innerText =
              'Please enter your password.';
          }

          if (loginErrorBox) {
            loginErrorBox.classList.remove(
              'hidden'
            );
          }

          return;
        }

        if (loginErrorBox) {
          loginErrorBox.classList.add(
            'hidden'
          );
        }

        if (btnLoginSubmit) {
          btnLoginSubmit.disabled =
            true;
        }

        if (btnLoginText) {
          btnLoginText.innerText =
            'Signing in...';
        }

        try {
          const res =
            await fetch(
              '/api/auth/login',
              {
                method: 'POST',
                headers: {
                  'Content-Type':
                    'application/json'
                },
                body: JSON.stringify({
                  username,
                  password
                })
              }
            );

          const data =
            await res.json();

          if (
            res.ok &&
            data.success &&
            data.token
          ) {
            localStorage.setItem(
              'smartwater_auth_token',
              data.token
            );

            if (data.user) {
              updateAuthUserUI(
                data.user
              );
            }

            hideLoginForm();

            fetchStatus();

            connectWebSocket();

            // DASHBOARD TODAY USAGE FIX
            syncDashboardTodayUsage();

          } else {
            if (loginErrorText) {
              loginErrorText.innerText =
                data.error ||
                'Invalid email or password.';
            }

            if (loginErrorBox) {
              loginErrorBox.classList.remove(
                'hidden'
              );
            }
          }

        } catch (err) {
          console.error(
            'Login network failure:',
            err
          );

          if (loginErrorText) {
            loginErrorText.innerText =
              'Unable to connect to the server. Please try again.';
          }

          if (loginErrorBox) {
            loginErrorBox.classList.remove(
              'hidden'
            );
          }

        } finally {
          if (btnLoginSubmit) {
            btnLoginSubmit.disabled =
              false;
          }

          if (btnLoginText) {
            btnLoginText.innerHTML =
              '<i class="ri-login-box-line"></i> Sign In to Dashboard';
          }
        }
      }
    );
  }

  // REGISTRATION FORM HANDLER
  const registerForm =
    document.getElementById(
      'registerForm'
    );

  const regNameInput =
    document.getElementById(
      'regFullName'
    ) ||
    document.getElementById(
      'regName'
    );

  const regUsernameInput =
    document.getElementById(
      'regUsername'
    );

  const regEmailInput =
    document.getElementById(
      'regEmail'
    );

  const regPasswordInput =
    document.getElementById(
      'regPassword'
    );

  const regConfirmPasswordInput =
    document.getElementById(
      'regConfirmPassword'
    );

  const btnRegisterSubmit =
    document.getElementById(
      'btnRegisterSubmit'
    );

  const btnRegisterText =
    document.getElementById(
      'btnRegisterText'
    );

  const registerErrorBox =
    document.getElementById(
      'registerErrorBox'
    );

  const registerErrorText =
    document.getElementById(
      'registerErrorText'
    );

  const registerSuccessBox =
    document.getElementById(
      'registerSuccessBox'
    );

  const registerSuccessText =
    document.getElementById(
      'registerSuccessText'
    );

  if (registerForm) {
    registerForm.addEventListener(
      'submit',
      async e => {
        e.preventDefault();

        const name =
          regNameInput
            ? regNameInput.value.trim()
            : '';

        const username =
          regUsernameInput
            ? regUsernameInput.value.trim()
            : '';

        const email =
          regEmailInput
            ? regEmailInput.value.trim()
            : '';

        const password =
          regPasswordInput
            ? regPasswordInput.value
            : '';

        const confirmPassword =
          regConfirmPasswordInput
            ? regConfirmPasswordInput.value
            : '';

        registerErrorBox.classList.add(
          'hidden'
        );

        registerSuccessBox.classList.add(
          'hidden'
        );

        if (!name) {
          registerErrorText.innerText =
            'Please enter your name.';

          registerErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        if (!username) {
          registerErrorText.innerText =
            'Please enter a username.';

          registerErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        if (
          !email ||
          !isValidEmailFormat(
            email
          )
        ) {
          registerErrorText.innerText =
            'Please enter a valid email address.';

          registerErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        if (!password) {
          registerErrorText.innerText =
            'Please enter a password.';

          registerErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        if (
          password !==
          confirmPassword
        ) {
          registerErrorText.innerText =
            'Passwords do not match.';

          registerErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        btnRegisterSubmit.disabled =
          true;

        btnRegisterText.innerText =
          'Creating Account...';

        try {
          const res =
            await fetch(
              '/api/auth/register',
              {
                method: 'POST',
                headers: {
                  'Content-Type':
                    'application/json'
                },
                body: JSON.stringify({
                  name,
                  username,
                  email,
                  password,
                  confirmPassword
                })
              }
            );

          const data =
            await res.json();

          if (
            res.ok &&
            data.success
          ) {
            registerSuccessText.innerText =
              data.message ||
              'Account created successfully! Redirecting to Sign In...';

            registerSuccessBox.classList.remove(
              'hidden'
            );

            registerForm.reset();

            setTimeout(
              () => {
                switchAuthView(
                  'signIn'
                );

                if (
                  loginUsernameInput
                ) {
                  loginUsernameInput.value =
                    username;
                }
              },
              1500
            );

          } else {
            registerErrorText.innerText =
              data.error ||
              'Failed to create account.';

            registerErrorBox.classList.remove(
              'hidden'
            );
          }

        } catch (err) {
          console.error(
            'Registration network error:',
            err
          );

          registerErrorText.innerText =
            'Network error during registration. Please try again.';

          registerErrorBox.classList.remove(
            'hidden'
          );

        } finally {
          btnRegisterSubmit.disabled =
            false;

          btnRegisterText.innerText =
            'Create Account';
        }
      }
    );
  }

  // FORGOT PASSWORD FORM HANDLER
  const forgotForm =
    document.getElementById(
      'forgotForm'
    );

  const forgotEmailInput =
    document.getElementById(
      'forgotEmail'
    );

  const btnForgotSubmit =
    document.getElementById(
      'btnForgotSubmit'
    );

  const btnForgotText =
    document.getElementById(
      'btnForgotText'
    );

  const forgotErrorBox =
    document.getElementById(
      'forgotErrorBox'
    );

  const forgotErrorText =
    document.getElementById(
      'forgotErrorText'
    );

  const forgotSuccessBox =
    document.getElementById(
      'forgotSuccessBox'
    );

  const forgotSuccessText =
    document.getElementById(
      'forgotSuccessText'
    );

  let activeResetEmail = '';
  let activeVerifiedOtp = '';

  if (forgotForm) {
    forgotForm.addEventListener(
      'submit',
      async e => {
        e.preventDefault();

        const email =
          forgotEmailInput.value.trim();

        forgotErrorBox.classList.add(
          'hidden'
        );

        forgotSuccessBox.classList.add(
          'hidden'
        );

        if (
          !email ||
          !isValidEmailFormat(
            email
          )
        ) {
          forgotErrorText.innerText =
            'Please enter a valid email address.';

          forgotErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        btnForgotSubmit.disabled =
          true;

        btnForgotText.innerText =
          'Sending OTP...';

        try {
          const res =
            await fetch(
              '/api/auth/forgot-password',
              {
                method: 'POST',
                headers: {
                  'Content-Type':
                    'application/json'
                },
                body: JSON.stringify({
                  email
                })
              }
            );

          const data =
            await res.json();

          if (
            res.ok &&
            data.success
          ) {
            activeResetEmail =
              email;

            forgotSuccessText.innerText =
              data.message ||
              'If an account exists for this email, a 6-digit OTP has been sent.';

            forgotSuccessBox.classList.remove(
              'hidden'
            );

            forgotForm.reset();

            setTimeout(
              () => {
                switchAuthView(
                  'verifyOtp'
                );
              },
              1000
            );

          } else {
            forgotErrorText.innerText =
              data.error ||
              "We couldn't send the reset instructions right now. Please try again later.";

            forgotErrorBox.classList.remove(
              'hidden'
            );
          }

        } catch (err) {
          console.error(
            'Forgot password network error:',
            err
          );

          forgotErrorText.innerText =
            'Network error. Please try again later.';

          forgotErrorBox.classList.remove(
            'hidden'
          );

        } finally {
          btnForgotSubmit.disabled =
            false;

          btnForgotText.innerHTML =
            '<i class="ri-send-plane-line"></i> Send OTP';
        }
      }
    );
  }

  // VERIFY OTP FORM HANDLER
  const verifyOtpForm =
    document.getElementById(
      'verifyOtpForm'
    );

  const inputOtpCode =
    document.getElementById(
      'inputOtpCode'
    );

  const btnVerifyOtpSubmit =
    document.getElementById(
      'btnVerifyOtpSubmit'
    );

  const btnVerifyOtpText =
    document.getElementById(
      'btnVerifyOtpText'
    );

  const otpErrorBox =
    document.getElementById(
      'otpErrorBox'
    );

  const otpErrorText =
    document.getElementById(
      'otpErrorText'
    );

  const otpSuccessBox =
    document.getElementById(
      'otpSuccessBox'
    );

  const otpSuccessText =
    document.getElementById(
      'otpSuccessText'
    );

  const btnResendOtp =
    document.getElementById(
      'btnResendOtp'
    );

  if (verifyOtpForm) {
    verifyOtpForm.addEventListener(
      'submit',
      async e => {
        e.preventDefault();

        const otp =
          inputOtpCode
            ? inputOtpCode.value.trim()
            : '';

        otpErrorBox.classList.add(
          'hidden'
        );

        otpSuccessBox.classList.add(
          'hidden'
        );

        if (!activeResetEmail) {
          otpErrorText.innerText =
            'Email session expired. Please start over from Forgot Password.';

          otpErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        if (
          !otp ||
          !/^\d{6}$/.test(otp)
        ) {
          otpErrorText.innerText =
            'Please enter a valid 6-digit OTP.';

          otpErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        btnVerifyOtpSubmit.disabled =
          true;

        btnVerifyOtpText.innerText =
          'Verifying...';

        try {
          const res =
            await fetch(
              '/api/auth/verify-otp',
              {
                method: 'POST',
                headers: {
                  'Content-Type':
                    'application/json'
                },
                body: JSON.stringify({
                  email:
                    activeResetEmail,

                  otp
                })
              }
            );

          const data =
            await res.json();

          if (
            res.ok &&
            data.success
          ) {
            activeVerifiedOtp =
              otp;

            otpSuccessText.innerText =
              data.message ||
              'OTP verified successfully!';

            otpSuccessBox.classList.remove(
              'hidden'
            );

            setTimeout(
              () => {
                switchAuthView(
                  'reset'
                );
              },
              1000
            );

          } else {
            otpErrorText.innerText =
              data.error ||
              'Invalid or expired OTP. Please try again.';

            otpErrorBox.classList.remove(
              'hidden'
            );
          }

        } catch (err) {
          console.error(
            'Verify OTP error:',
            err
          );

          otpErrorText.innerText =
            'Network error verifying OTP. Please try again.';

          otpErrorBox.classList.remove(
            'hidden'
          );

        } finally {
          btnVerifyOtpSubmit.disabled =
            false;

          btnVerifyOtpText.innerHTML =
            '<i class="ri-checkbox-circle-line"></i> Verify OTP';
        }
      }
    );
  }

  if (btnResendOtp) {
    btnResendOtp.addEventListener(
      'click',
      async e => {
        e.preventDefault();

        if (!activeResetEmail) {
          switchAuthView(
            'forgot'
          );

          return;
        }

        btnResendOtp.innerText =
          'Resending...';

        try {
          const res =
            await fetch(
              '/api/auth/forgot-password',
              {
                method: 'POST',
                headers: {
                  'Content-Type':
                    'application/json'
                },
                body: JSON.stringify({
                  email:
                    activeResetEmail
                })
              }
            );

          const data =
            await res.json();

          if (
            res.ok &&
            data.success
          ) {
            otpSuccessText.innerText =
              'New OTP sent to your email!';

            otpSuccessBox.classList.remove(
              'hidden'
            );

            otpErrorBox.classList.add(
              'hidden'
            );

          } else {
            otpErrorText.innerText =
              data.error ||
              'Failed to resend OTP.';

            otpErrorBox.classList.remove(
              'hidden'
            );
          }

        } catch (err) {
          otpErrorText.innerText =
            'Network error resending OTP.';

          otpErrorBox.classList.remove(
            'hidden'
          );

        } finally {
          btnResendOtp.innerHTML =
            '<i class="ri-refresh-line"></i> Resend OTP';
        }
      }
    );
  }

  // RESET PASSWORD FORM HANDLER
  const resetForm =
    document.getElementById(
      'resetForm'
    );

  const resetPasswordInput =
    document.getElementById(
      'resetNewPassword'
    ) ||
    document.getElementById(
      'resetPassword'
    );

  const resetConfirmPasswordInput =
    document.getElementById(
      'resetConfirmPassword'
    );

  const btnResetSubmit =
    document.getElementById(
      'btnResetSubmit'
    );

  const btnResetText =
    document.getElementById(
      'btnResetText'
    );

  const resetErrorBox =
    document.getElementById(
      'resetErrorBox'
    );

  const resetErrorText =
    document.getElementById(
      'resetErrorText'
    );

  const resetSuccessBox =
    document.getElementById(
      'resetSuccessBox'
    );

  const resetSuccessText =
    document.getElementById(
      'resetSuccessText'
    );

  if (resetForm) {
    resetForm.addEventListener(
      'submit',
      async e => {
        e.preventDefault();

        const newPassword =
          resetPasswordInput
            ? resetPasswordInput.value
            : '';

        const confirmPassword =
          resetConfirmPasswordInput
            ? resetConfirmPasswordInput.value
            : '';

        resetErrorBox.classList.add(
          'hidden'
        );

        resetSuccessBox.classList.add(
          'hidden'
        );

        if (
          !activeResetEmail ||
          !activeVerifiedOtp
        ) {
          resetErrorText.innerText =
            'Session expired. Please request a new OTP.';

          resetErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        if (!newPassword) {
          resetErrorText.innerText =
            'Please enter your new password.';

          resetErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        if (
          newPassword !==
          confirmPassword
        ) {
          resetErrorText.innerText =
            'Passwords do not match.';

          resetErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        btnResetSubmit.disabled =
          true;

        btnResetText.innerText =
          'Resetting Password...';

        try {
          const res =
            await fetch(
              '/api/auth/reset-password',
              {
                method: 'POST',
                headers: {
                  'Content-Type':
                    'application/json'
                },
                body: JSON.stringify({
                  email:
                    activeResetEmail,

                  otp:
                    activeVerifiedOtp,

                  newPassword,

                  confirmPassword
                })
              }
            );

          const data =
            await res.json();

          if (
            res.ok &&
            data.success
          ) {
            resetSuccessText.innerText =
              data.message ||
              'Password reset successfully. Redirecting to Sign In...';

            resetSuccessBox.classList.remove(
              'hidden'
            );

            resetForm.reset();

            activeResetEmail =
              '';

            activeVerifiedOtp =
              '';

            setTimeout(
              () => {
                switchAuthView(
                  'signIn'
                );
              },
              1500
            );

          } else {
            resetErrorText.innerText =
              data.error ||
              'Failed to reset password.';

            resetErrorBox.classList.remove(
              'hidden'
            );
          }

        } catch (err) {
          console.error(
            'Reset password network error:',
            err
          );

          resetErrorText.innerText =
            'Network error. Please try again.';

          resetErrorBox.classList.remove(
            'hidden'
          );

        } finally {
          btnResetSubmit.disabled =
            false;

          btnResetText.innerHTML =
            '<i class="ri-shield-check-line"></i> Reset Password';
        }
      }
    );
  }

  // CHANGE PASSWORD FORM HANDLER
  const changePasswordForm =
    document.getElementById(
      'changePasswordForm'
    );

  const currPasswordInput =
    document.getElementById(
      'currPassword'
    );

  const newPasswordInput =
    document.getElementById(
      'newPassword'
    );

  const confirmNewPasswordInput =
    document.getElementById(
      'confirmNewPassword'
    );

  const btnChangePwSubmit =
    document.getElementById(
      'btnChangePwSubmit'
    );

  const btnChangePwText =
    document.getElementById(
      'btnChangePwText'
    );

  const changePwErrorBox =
    document.getElementById(
      'changePwErrorBox'
    );

  const changePwErrorText =
    document.getElementById(
      'changePwErrorText'
    );

  const changePwSuccessBox =
    document.getElementById(
      'changePwSuccessBox'
    );

  const changePwSuccessText =
    document.getElementById(
      'changePwSuccessText'
    );

  if (changePasswordForm) {
    changePasswordForm.addEventListener(
      'submit',
      async e => {
        e.preventDefault();

        const currentPassword =
          currPasswordInput.value;

        const newPassword =
          newPasswordInput.value;

        const confirmPassword =
          confirmNewPasswordInput.value;

        changePwErrorBox.classList.add(
          'hidden'
        );

        changePwSuccessBox.classList.add(
          'hidden'
        );

        if (
          !currentPassword ||
          !newPassword ||
          !confirmPassword
        ) {
          changePwErrorText.innerText =
            'Please fill out all password fields.';

          changePwErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        if (
          newPassword !==
          confirmPassword
        ) {
          changePwErrorText.innerText =
            'New passwords do not match.';

          changePwErrorBox.classList.remove(
            'hidden'
          );

          return;
        }

        btnChangePwSubmit.disabled =
          true;

        btnChangePwText.innerText =
          'Updating Password...';

        try {
          const res =
            await fetch(
              '/api/auth/change-password',
              {
                method: 'POST',
                headers:
                  getAuthHeaders(),
                body: JSON.stringify({
                  currentPassword,
                  newPassword,
                  confirmPassword
                })
              }
            );

          const data =
            await res.json();

          if (
            res.ok &&
            data.success
          ) {
            changePwSuccessText.innerText =
              data.message ||
              'Password updated successfully!';

            changePwSuccessBox.classList.remove(
              'hidden'
            );

            changePasswordForm.reset();

          } else {
            changePwErrorText.innerText =
              data.error ||
              'Failed to update password.';

            changePwErrorBox.classList.remove(
              'hidden'
            );
          }

        } catch (err) {
          console.error(
            'Change password error:',
            err
          );

          changePwErrorText.innerText =
            'Network error while updating password.';

          changePwErrorBox.classList.remove(
            'hidden'
          );

        } finally {
          btnChangePwSubmit.disabled =
            false;

          btnChangePwText.innerText =
            'Update Password';
        }
      }
    );
  }

  // Logout Handler
  if (btnLogout) {
    btnLogout.addEventListener(
      'click',
      () => {
        localStorage.removeItem(
          'smartwater_auth_token'
        );

        if (ws) {
          try {
            ws.close();
          } catch (e) { }

          ws = null;
        }

        updateAuthUserUI(
          null
        );

        if (valAlertsCount) {
          valAlertsCount.innerText =
            '0';
        }

        updateSidebarNotificationBadge(
          0
        );

        showLoginForm();
      }
    );
  }

  // Pump Mode Controls
  btnModeAuto.addEventListener(
    'click',
    async () => {
      console.log(
        `[PUMP UI TRACE] current mode: ${state.pump.mode} -> new mode: AUTO | timestamp: ${new Date().toLocaleTimeString()}`
      );

      console.trace(
        '[PUMP UI TRACE Call Stack]'
      );

      console.log(
        `[HTTP PUMP CONTROL] method: POST | URL: /api/pump/control | body: {"mode": "AUTO"} | timestamp: ${new Date().toLocaleTimeString()}`
      );

      const res =
        await fetch(
          '/api/pump/control',
          {
            method: 'POST',
            headers:
              getAuthHeaders(),

            body: JSON.stringify({
              mode: 'AUTO'
            })
          }
        );

      const data =
        await res.json();

      console.log(
        '[HTTP PUMP CONTROL RESPONSE]',
        data
      );
    }
  );

  btnModeManual.addEventListener(
    'click',
    async () => {
      console.log(
        `[PUMP UI TRACE] current mode: ${state.pump.mode} -> new mode: MANUAL | timestamp: ${new Date().toLocaleTimeString()}`
      );

      console.trace(
        '[PUMP UI TRACE Call Stack]'
      );

      console.log(
        `[HTTP PUMP CONTROL] method: POST | URL: /api/pump/control | body: {"mode": "MANUAL"} | timestamp: ${new Date().toLocaleTimeString()}`
      );

      const res =
        await fetch(
          '/api/pump/control',
          {
            method: 'POST',
            headers:
              getAuthHeaders(),

            body: JSON.stringify({
              mode: 'MANUAL'
            })
          }
        );

      const data =
        await res.json();

      console.log(
        '[HTTP PUMP CONTROL RESPONSE]',
        data
      );
    }
  );

  btnPumpOn.addEventListener(
    'click',
    async () => {
      console.log(
        `[PUMP UI TRACE] MANUAL PUMP ON | timestamp: ${new Date().toLocaleTimeString()}`
      );

      console.log(
        `[HTTP PUMP CONTROL] method: POST | URL: /api/pump/control | body: {"mode": "MANUAL", "status": "ON"} | timestamp: ${new Date().toLocaleTimeString()}`
      );

      const res =
        await fetch(
          '/api/pump/control',
          {
            method: 'POST',
            headers:
              getAuthHeaders(),

            body: JSON.stringify({
              mode: 'MANUAL',
              status: 'ON'
            })
          }
        );

      const data =
        await res.json();

      console.log(
        '[HTTP PUMP CONTROL RESPONSE]',
        data
      );
    }
  );

  btnPumpOff.addEventListener(
    'click',
    async () => {
      console.log(
        `[PUMP UI TRACE] MANUAL PUMP OFF | timestamp: ${new Date().toLocaleTimeString()}`
      );

      console.log(
        `[HTTP PUMP CONTROL] method: POST | URL: /api/pump/control | body: {"mode": "MANUAL", "status": "OFF"} | timestamp: ${new Date().toLocaleTimeString()}`
      );

      const res =
        await fetch(
          '/api/pump/control',
          {
            method: 'POST',
            headers:
              getAuthHeaders(),

            body: JSON.stringify({
              mode: 'MANUAL',
              status: 'OFF'
            })
          }
        );

      const data =
        await res.json();

      console.log(
        '[HTTP PUMP CONTROL RESPONSE]',
        data
      );
    }
  );

  initChart();

  checkAuth().then(
    authenticated => {
      if (authenticated) {
        fetchStatus();

        connectWebSocket();

        // DASHBOARD TODAY USAGE FIX
        syncDashboardTodayUsage();
      }
    }
  );

  // DASHBOARD TODAY USAGE FIX
  // Refresh the same Analytics-Today value every 10 seconds.
  setInterval(
    () => {
      if (
        localStorage.getItem(
          'smartwater_auth_token'
        )
      ) {
        syncDashboardTodayUsage();
      }
    },
    10000
  );

  // Fallback Polling
  setInterval(
    () => {
      console.log(
        '[FALLBACK POLL]',
        {
          timestamp:
            new Date().toISOString(),

          wsState:
            ws?.readyState
        }
      );

      if (
        localStorage.getItem(
          'smartwater_auth_token'
        )
      ) {
        if (
          !ws ||
          ws.readyState !==
          WebSocket.OPEN
        ) {
          fetchStatus();
        }
      }
    },
    3000
  );
});

window.addEventListener(
  'beforeunload',
  () => {
    console.log(
      '[PAGE UNLOAD]',
      new Date().toISOString()
    );
  }
);

window.addEventListener(
  'load',
  () => {
    console.log(
      '[PAGE LOAD]',
      new Date().toISOString()
    );
  }
);

console.log(
  '[APP INITIALIZED]',
  new Date().toISOString()
);