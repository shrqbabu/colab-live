// ============================================================
//  🌐 GOOGLE CLOUD SHELL & COLAB DASHBOARD — Frontend Client
// ============================================================

(function () {
  let sseSource = null;
  let screenshotTimer = null;
  let countdownTimer = null;
  let nextCheckTimestamp = null;
  let sessionStartTime = null;
  let isRunning = false;
  let currentMode = 'cloudshell';
  let appConfig = {};

  // DOM Elements
  const modeLogo = document.getElementById('modeLogo');
  const activeModeBadge = document.getElementById('activeModeBadge');
  const globalStatusPill = document.getElementById('globalStatusPill');
  const globalStatusText = document.getElementById('globalStatusText');
  const cookieStatusBadge = document.getElementById('cookieStatusBadge');
  const headlessBadge = document.getElementById('headlessBadge');

  const btnModeCloudshell = document.getElementById('btnModeCloudshell');
  const btnModeColab = document.getElementById('btnModeColab');
  const urlLabel = document.getElementById('urlLabel');
  const activeUrlInput = document.getElementById('activeUrlInput');
  const btnSaveUrl = document.getElementById('btnSaveUrl');

  const runtimeStateValue = document.getElementById('runtimeStateValue');
  const runtimeReason = document.getElementById('runtimeReason');
  const sessionDurationValue = document.getElementById('sessionDurationValue');
  const intervalLabel = document.getElementById('intervalLabel');
  const nextCheckValue = document.getElementById('nextCheckValue');
  const intervalHint = document.getElementById('intervalHint');
  const commandMetricLabel = document.getElementById('commandMetricLabel');
  const startupCmdValue = document.getElementById('startupCmdValue');
  const commandMetricHint = document.getElementById('commandMetricHint');

  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnReconnect = document.getElementById('btnReconnect');

  const commandCardTitle = document.getElementById('commandCardTitle');
  const commandCardSub = document.getElementById('commandCardSub');
  const cmdInput = document.getElementById('cmdInput');
  const btnSendCmd = document.getElementById('btnSendCmd');
  const quickCommandsContainer = document.getElementById('quickCommandsContainer');

  const terminalScreenshot = document.getElementById('terminalScreenshot');
  const screenshotPlaceholder = document.getElementById('screenshotPlaceholder');
  const btnRefreshScreenshot = document.getElementById('btnRefreshScreenshot');
  const autoRefreshScreenshot = document.getElementById('autoRefreshScreenshot');

  const logContainer = document.getElementById('logContainer');
  const btnClearLogs = document.getElementById('btnClearLogs');
  const autoScrollLogs = document.getElementById('autoScrollLogs');

  // Modals
  const settingsModal = document.getElementById('settingsModal');
  const btnSettings = document.getElementById('btnSettings');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const btnCancelSettings = document.getElementById('btnCancelSettings');
  const btnSaveSettings = document.getElementById('btnSaveSettings');

  const cfgCloudShellUrl = document.getElementById('cfgCloudShellUrl');
  const cfgColabUrl = document.getElementById('cfgColabUrl');
  const cfgStartupCmd = document.getElementById('cfgStartupCmd');
  const cfgWaitAfterLoad = document.getElementById('cfgWaitAfterLoad');
  const cfgCheckInterval = document.getElementById('cfgCheckInterval');
  const cfgColabKeepalive = document.getElementById('cfgColabKeepalive');
  const cfgColabAutoRun = document.getElementById('cfgColabAutoRun');
  const cfgHeadless = document.getElementById('cfgHeadless');

  const cookiesModal = document.getElementById('cookiesModal');
  const btnCookiesModal = document.getElementById('btnCookiesModal');
  const btnCloseCookies = document.getElementById('btnCloseCookies');
  const btnCancelCookies = document.getElementById('btnCancelCookies');
  const btnImportCookies = document.getElementById('btnImportCookies');
  const cookiesInput = document.getElementById('cookiesInput');
  const cookiesStatusMsg = document.getElementById('cookiesStatusMsg');

  // ── Format Duration ──
  function formatDuration(sec) {
    if (!sec || sec < 0) return '00:00:00';
    const h = Math.floor(sec / 3600).toString().padStart(2, '0');
    const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  // ── Append Log ──
  function appendLog(entry) {
    if (!entry) return;
    const div = document.createElement('div');
    const level = entry.level || 'info';
    div.className = `log-line log-${level}`;

    const timestamp = entry.timestamp || new Date().toLocaleTimeString();
    const msg = typeof entry === 'string' ? entry : entry.msg || JSON.stringify(entry);

    if (msg.includes('docker') || msg.includes('Ctrl+F9') || msg.includes('Command')) {
      div.className = 'log-line log-cmd';
    }

    div.textContent = `[${timestamp}] [${level.toUpperCase()}] ${msg}`;
    logContainer.appendChild(div);

    if (autoScrollLogs && autoScrollLogs.checked) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  // ── Apply Mode UI ──
  function setModeUI(mode) {
    currentMode = mode;
    if (mode === 'colab') {
      btnModeColab.classList.add('active');
      btnModeCloudshell.classList.remove('active');
      modeLogo.textContent = '🚀';
      activeModeBadge.textContent = 'Colab Mode';
      urlLabel.textContent = 'Dynamic Colab Notebook Link:';
      activeUrlInput.value = appConfig.colabUrl || 'https://colab.research.google.com/';

      intervalLabel.textContent = 'Colab Keep-Alive';
      intervalHint.textContent = 'Idle timeout click';
      commandMetricLabel.textContent = 'Auto Run All';
      commandMetricHint.textContent = 'Triggers on connect';
      startupCmdValue.textContent = 'Ctrl+F9 (Run All)';

      commandCardTitle.textContent = 'Notebook Controls';
      commandCardSub.textContent = 'Trigger actions in Colab';
      cmdInput.placeholder = 'Type command or shortcut...';
      cmdInput.value = 'Run All Cells (Ctrl+F9)';

      quickCommandsContainer.innerHTML = `
        <span>Quick actions:</span>
        <button class="chip" data-cmd="Run All Cells (Ctrl+F9)">▶ Run All (Ctrl+F9)</button>
        <button class="chip" data-cmd="Reconnect Runtime">🔄 Reconnect</button>
      `;
    } else {
      btnModeCloudshell.classList.add('active');
      btnModeColab.classList.remove('active');
      modeLogo.textContent = '☁️';
      activeModeBadge.textContent = 'Cloud Shell Mode';
      urlLabel.textContent = 'Dynamic Cloud Shell Link:';
      activeUrlInput.value = appConfig.cloudShellUrl || 'https://shell.cloud.google.com/?show=terminal';

      intervalLabel.textContent = 'Next 10-Min Check';
      intervalHint.textContent = 'Checks if session ended';
      commandMetricLabel.textContent = 'Startup Command';
      commandMetricHint.textContent = 'Runs after 1 min wait';
      startupCmdValue.textContent = appConfig.startupCommand || 'docker start omniroute';

      commandCardTitle.textContent = 'Cloud Shell Terminal Execution';
      commandCardSub.textContent = 'Send command to Cloud Shell';
      cmdInput.placeholder = 'docker start omniroute';
      cmdInput.value = appConfig.startupCommand || 'docker start omniroute';

      quickCommandsContainer.innerHTML = `
        <span>Quick actions:</span>
        <button class="chip" data-cmd="docker start omniroute">docker start omniroute</button>
        <button class="chip" data-cmd="docker ps">docker ps</button>
        <button class="chip" data-cmd="docker logs omniroute">docker logs omniroute</button>
        <button class="chip" data-cmd="uptime">uptime</button>
      `;
    }

    // Attach quick command chip listeners
    document.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const cmd = chip.getAttribute('data-cmd');
        cmdInput.value = cmd;
        sendCommand(cmd);
      });
    });
  }

  // ── Update Status UI ──
  function updateStatusUI(status) {
    if (!status) return;

    isRunning = !!status.isRunning;
    const isConnected = !!status.isConnected;
    const stateObj = status.runtimeState || {};
    const stateName = stateObj.state || (isRunning ? 'RUNNING' : 'IDLE');
    const reason = stateObj.reason || '';

    // Buttons
    btnStart.disabled = isRunning;
    btnStop.disabled = !isRunning;
    btnReconnect.disabled = !isRunning;

    // Status pill
    globalStatusText.textContent = stateName;
    const dot = globalStatusPill.querySelector('.status-dot');
    dot.className = 'status-dot';

    if (isConnected) {
      dot.classList.add('status-connected');
    } else if (stateName.includes('WAIT') || stateName.includes('STARTING') || stateName.includes('INITIALIZING')) {
      dot.classList.add('status-wait');
    } else if (stateName === 'DISCONNECTED' || stateName === 'ERROR' || stateName === 'LOGIN_REQUIRED') {
      dot.classList.add('status-disconnected');
    } else {
      dot.classList.add('status-idle');
    }

    runtimeStateValue.textContent = stateName;
    runtimeReason.textContent = reason || (isConnected ? 'Active (Zero clicks mode)' : 'Standby');

    if (status.headless !== undefined) {
      headlessBadge.textContent = `Headless: ${status.headless ? 'ON' : 'OFF'}`;
    }

    if (status.cookiesSaved !== undefined) {
      cookieStatusBadge.textContent = status.cookiesSaved ? 'Profile: Saved ✓' : 'Profile: No Cookies';
      cookieStatusBadge.style.color = status.cookiesSaved ? '#22c55e' : '#f59e0b';
    }

    if (status.sessionStartAt && isRunning) {
      sessionStartTime = status.sessionStartAt;
    } else {
      sessionStartTime = null;
      sessionDurationValue.textContent = '00:00:00';
    }

    if (status.nextCheckAt) {
      nextCheckTimestamp = status.nextCheckAt;
    }
  }

  // ── Next Check Countdown & Timer Ticks ──
  setInterval(() => {
    if (sessionStartTime && isRunning) {
      const diff = Math.floor((Date.now() - sessionStartTime) / 1000);
      sessionDurationValue.textContent = formatDuration(diff);
    }

    if (nextCheckTimestamp && isRunning) {
      const remaining = Math.max(0, Math.floor((nextCheckTimestamp - Date.now()) / 1000));
      const m = Math.floor(remaining / 60).toString().padStart(2, '0');
      const s = Math.floor(remaining % 60).toString().padStart(2, '0');
      nextCheckValue.textContent = `${m}:${s}`;
    } else {
      nextCheckValue.textContent = '--:--';
    }
  }, 1000);

  // ── Screenshot Fetcher ──
  async function fetchScreenshot() {
    try {
      const res = await fetch('/api/screenshot?t=' + Date.now());
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        terminalScreenshot.src = url;
        terminalScreenshot.style.display = 'block';
        screenshotPlaceholder.style.display = 'none';
      }
    } catch (_) {}
  }

  btnRefreshScreenshot.addEventListener('click', fetchScreenshot);

  setInterval(() => {
    if (autoRefreshScreenshot && autoRefreshScreenshot.checked && isRunning) {
      fetchScreenshot();
    }
  }, 15000);

  // ── Mode Switch Actions ──
  btnModeCloudshell.addEventListener('click', async () => {
    if (currentMode === 'cloudshell') return;
    setModeUI('cloudshell');
    await saveConfigToServer({ mode: 'cloudshell' });
    appendLog({ level: 'info', msg: 'Switched to Google Cloud Shell Mode.' });
  });

  btnModeColab.addEventListener('click', async () => {
    if (currentMode === 'colab') return;
    setModeUI('colab');
    await saveConfigToServer({ mode: 'colab' });
    appendLog({ level: 'info', msg: 'Switched to Google Colab Mode.' });
  });

  // ── Save Link Action ──
  btnSaveUrl.addEventListener('click', async () => {
    const val = activeUrlInput.value.trim();
    if (!val) return;
    const payload = {};
    if (currentMode === 'colab') {
      payload.colabUrl = val;
      appConfig.colabUrl = val;
    } else {
      payload.cloudShellUrl = val;
      appConfig.cloudShellUrl = val;
    }
    await saveConfigToServer(payload);
    appendLog({ level: 'info', msg: `Saved dynamic link: ${val}` });
    alert('Target Link Saved Successfully!');
  });

  // ── Start / Stop / Reconnect ──
  btnStart.addEventListener('click', async () => {
    btnStart.disabled = true;
    appendLog({ level: 'info', msg: `Starting ${currentMode.toUpperCase()} worker...` });
    try {
      const res = await fetch('/api/start', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) alert('Start failed: ' + (data.message || data.error));
    } catch (e) {
      alert('Start request error: ' + e.message);
    }
  });

  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    appendLog({ level: 'info', msg: 'Stopping worker (Profile preserved)...' });
    try {
      await fetch('/api/stop', { method: 'POST' });
    } catch (e) {
      alert('Stop error: ' + e.message);
    }
  });

  btnReconnect.addEventListener('click', async () => {
    btnReconnect.disabled = true;
    appendLog({ level: 'warn', msg: 'Manual force reconnect triggered...' });
    try {
      await fetch('/api/reconnect', { method: 'POST' });
    } catch (e) {
      alert('Reconnect error: ' + e.message);
    } finally {
      setTimeout(() => { btnReconnect.disabled = false; }, 3000);
    }
  });

  // ── Remote Command Execution ──
  async function sendCommand(cmd) {
    if (!cmd || !cmd.trim()) return;
    appendLog({ level: 'info', msg: `Executing command: ${cmd}...` });
    try {
      const res = await fetch('/api/send-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd.trim() }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert('Command error: ' + (data.message || data.error));
      }
    } catch (e) {
      alert('Command request error: ' + e.message);
    }
  }

  btnSendCmd.addEventListener('click', () => {
    sendCommand(cmdInput.value);
  });

  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCommand(cmdInput.value);
  });

  btnClearLogs.addEventListener('click', () => {
    logContainer.innerHTML = '';
  });

  // ── Cookies Modal (Save once, profile persists) ──
  btnCookiesModal.addEventListener('click', () => {
    cookiesInput.value = '';
    cookiesStatusMsg.className = 'status-msg';
    cookiesStatusMsg.textContent = '';
    cookiesModal.classList.add('show');
  });

  const closeCookies = () => cookiesModal.classList.remove('show');
  btnCloseCookies.addEventListener('click', closeCookies);
  btnCancelCookies.addEventListener('click', closeCookies);

  btnImportCookies.addEventListener('click', async () => {
    const raw = cookiesInput.value.trim();
    if (!raw) {
      alert('Please paste Cookie-Editor JSON cookies');
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      cookiesStatusMsg.className = 'status-msg error';
      cookiesStatusMsg.textContent = 'Invalid JSON: Ensure you exported from Cookie-Editor as JSON.';
      return;
    }

    btnImportCookies.disabled = true;
    cookiesStatusMsg.className = 'status-msg';
    cookiesStatusMsg.textContent = 'Saving cookies permanently to profile & disk backup...';

    try {
      const res = await fetch('/api/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      if (data.ok) {
        cookiesStatusMsg.className = 'status-msg success';
        cookiesStatusMsg.textContent = `✓ Successfully saved ${data.count} cookies! Session will persist across all restarts.`;
        cookieStatusBadge.textContent = 'Profile: Ready ✓';
        cookieStatusBadge.style.color = '#22c55e';
        setTimeout(closeCookies, 2000);
      } else {
        cookiesStatusMsg.className = 'status-msg error';
        cookiesStatusMsg.textContent = 'Error: ' + (data.error || data.message);
      }
    } catch (e) {
      cookiesStatusMsg.className = 'status-msg error';
      cookiesStatusMsg.textContent = 'Network error: ' + e.message;
    } finally {
      btnImportCookies.disabled = false;
    }
  });

  // ── Settings Modal ──
  btnSettings.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (data.ok && data.config) {
        appConfig = data.config;
        cfgCloudShellUrl.value = appConfig.cloudShellUrl || 'https://shell.cloud.google.com/?show=terminal';
        cfgColabUrl.value = appConfig.colabUrl || 'https://colab.research.google.com/';
        cfgStartupCmd.value = appConfig.startupCommand || 'docker start omniroute';
        cfgWaitAfterLoad.value = appConfig.waitAfterLoadSec || 60;
        cfgCheckInterval.value = appConfig.checkIntervalMin || 10;
        cfgColabKeepalive.value = appConfig.colabKeepaliveSec || 60;
        cfgColabAutoRun.checked = appConfig.colabAutoRun !== false;
        cfgHeadless.checked = appConfig.headless !== false;
      }
    } catch (_) {}
    settingsModal.classList.add('show');
  });

  const closeSettings = () => settingsModal.classList.remove('show');
  btnCloseSettings.addEventListener('click', closeSettings);
  btnCancelSettings.addEventListener('click', closeSettings);

  async function saveConfigToServer(payload) {
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok && data.config) {
        appConfig = data.config;
      }
      return data;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  btnSaveSettings.addEventListener('click', async () => {
    const payload = {
      cloudShellUrl: cfgCloudShellUrl.value.trim(),
      colabUrl: cfgColabUrl.value.trim(),
      startupCommand: cfgStartupCmd.value.trim(),
      waitAfterLoadSec: parseInt(cfgWaitAfterLoad.value, 10) || 60,
      checkIntervalMin: parseInt(cfgCheckInterval.value, 10) || 10,
      colabKeepaliveSec: parseInt(cfgColabKeepalive.value, 10) || 60,
      colabAutoRun: cfgColabAutoRun.checked,
      headless: cfgHeadless.checked,
    };

    const res = await saveConfigToServer(payload);
    if (res.ok) {
      setModeUI(currentMode);
      closeSettings();
      appendLog({ level: 'info', msg: 'Advanced configuration saved.' });
    } else {
      alert('Save failed: ' + (res.error || res.message));
    }
  });

  // ── SSE Real-time Setup ──
  function setupSSE() {
    if (sseSource) sseSource.close();
    sseSource = new EventSource('/api/events');

    sseSource.addEventListener('init', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.status) {
          if (data.status.mode) setModeUI(data.status.mode);
          updateStatusUI(data.status);
        }
        if (data.logs && Array.isArray(data.logs)) {
          logContainer.innerHTML = '';
          data.logs.forEach(appendLog);
        }
      } catch (_) {}
    });

    sseSource.addEventListener('status', (e) => {
      try {
        const status = JSON.parse(e.data);
        if (status.mode && status.mode !== currentMode) setModeUI(status.mode);
        updateStatusUI(status);
      } catch (_) {}
    });

    sseSource.addEventListener('log', (e) => {
      try {
        const entry = JSON.parse(e.data);
        appendLog(entry);
      } catch (_) {}
    });

    sseSource.onerror = () => {
      setTimeout(setupSSE, 5000);
    };
  }

  // ── Initial Load ──
  fetch('/api/config')
    .then((r) => r.json())
    .then((data) => {
      if (data.ok && data.config) {
        appConfig = data.config;
        setModeUI(appConfig.mode || 'cloudshell');
      }
    })
    .catch(() => {});

  fetch('/api/status')
    .then((r) => r.json())
    .then((data) => {
      if (data.ok) updateStatusUI(data);
    })
    .catch(() => {});

  setupSSE();
})();
