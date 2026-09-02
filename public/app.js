// ============================================================
//  ⚡ COLAB PRO VPS — Dashboard Client Application
// ============================================================

(function () {
  "use strict";

  // Prevent evaluation crash if executed in Node.js / Serverless environment
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const getStorage = (key) => {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    } catch (_) {
      return null;
    }
  };

  const setStorage = (key, val) => {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, val);
    } catch (_) {}
  };

  const removeStorage = (key) => {
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(key);
    } catch (_) {}
  };

  let authToken = getStorage('colab_auth_token') || null;
  let customVpsUrl = getStorage('colab_vps_url') || '';
  let customVpsSecret = getStorage('colab_vps_secret') || '';
  let autoScrollLogs = true;
  let sseSource = null;
  let currentStatus = null;
  let vpsHealthInterval = null;

  // ── Toast Notifications ──
  function showToast(msg, isError = false) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.style.borderColor = isError ? 'var(--danger)' : 'var(--primary)';
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 3500);
  }

  // ── Formatters ──
  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function fmtHumanDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${sec}s`;
  }

  function fmtBytes(b) {
    if (!b && b !== 0) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(0) + ' MB';
    return (b / 1073741824).toFixed(1) + ' GB';
  }

  // ── API Fetch Wrapper with Oracle VPS Gateway Bridge ──
  async function api(path, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    if (customVpsUrl) {
      headers['X-VPS-URL'] = customVpsUrl;
    }
    if (customVpsSecret) {
      headers['X-API-Secret'] = customVpsSecret;
    }

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(path, opts);
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error('Unauthorized');
    }

    const data = await res.json();
    return data;
  }

  function handleUnauthorized() {
    authToken = null;
    removeStorage('colab_auth_token');
    $('#dashboardView').style.display = 'none';
    $('#loginView').style.display = 'flex';
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }
  }

  // ── Authentication ──
  async function checkAuth() {
    try {
      const res = await api('/api/auth/check');
      if (res && res.authenticated) {
        showDashboard();
      } else {
        showLogin();
      }
    } catch (_) {
      showLogin();
    }
  }

  function showLogin() {
    $('#dashboardView').style.display = 'none';
    $('#loginView').style.display = 'flex';
  }

  function showDashboard() {
    $('#loginView').style.display = 'none';
    $('#dashboardView').style.display = 'block';
    loadConfig();
    loadStatus();
    loadLogs();
    connectSSE();
    checkVpsHealth();
    if (!vpsHealthInterval) {
      vpsHealthInterval = setInterval(checkVpsHealth, 10000);
    }
  }

  // ── Oracle VPS Health Monitor ──
  async function checkVpsHealth() {
    const pill = $('#vpsNodePill');
    const dot = $('#vpsNodeDot');
    const text = $('#vpsNodeText');
    if (!pill || !text) return;

    const startTime = Date.now();
    try {
      const res = await api('/api/health');
      const latency = Date.now() - startTime;
      if (res && res.ok) {
        pill.className = 'vps-node-pill online';
        text.textContent = `Oracle VPS: Online (${latency}ms)`;
        pill.title = `Connected to Oracle VPS Automation Node. Latency: ${latency}ms, Worker running: ${res.isRunning ? 'YES' : 'NO'}`;
      } else {
        pill.className = 'vps-node-pill warning';
        text.textContent = 'Oracle VPS: Degraded';
      }
    } catch (e) {
      pill.className = 'vps-node-pill offline';
      text.textContent = 'Oracle VPS: Disconnected';
      pill.title = 'Cannot connect to Oracle VPS Backend. Click to configure VPS URL or check security list.';
    }
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value.trim();
    const errBox = $('#loginError');
    const submitBtn = $('#loginSubmitBtn');

    errBox.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Verifying...</span> ⏳';

    try {
      const loginHeaders = { 'Content-Type': 'application/json' };
      if (customVpsUrl) loginHeaders['X-VPS-URL'] = customVpsUrl;
      if (customVpsSecret) loginHeaders['X-API-Secret'] = customVpsSecret;

      const res = await fetch('/api/login', {
        method: 'POST',
        headers: loginHeaders,
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (data.ok && data.token) {
        authToken = data.token;
        setStorage('colab_auth_token', authToken);
        showDashboard();
      } else {
        errBox.textContent = data.error || 'Invalid credentials';
        errBox.style.display = 'block';
      }
    } catch (err) {
      errBox.textContent = 'Server connection error: ' + err.message;
      errBox.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Sign In to Dashboard</span> ➔';
    }
  });

  $('#quickFillBtn').addEventListener('click', () => {
    $('#loginEmail').value = 'admin@colab.pro';
    $('#loginPassword').value = 'password123';
  });

  $('#togglePasswordBtn').addEventListener('click', () => {
    const pwInput = $('#loginPassword');
    const btn = $('#togglePasswordBtn');
    if (pwInput.type === 'password') {
      pwInput.type = 'text';
      btn.textContent = '🔒';
    } else {
      pwInput.type = 'password';
      btn.textContent = '👁';
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/logout', 'POST');
    } catch (_) {}
    handleUnauthorized();
    showToast('Logged out successfully');
  });

  // ── Dashboard Rendering ──
  function renderStatus(st) {
    if (!st) return;
    currentStatus = st;

    // Header & Status Badge
    const badge = $('#masterStatusBadge');
    const badgeText = $('#masterStatusText');

    if (st.isRunning && st.isConnected) {
      badge.className = 'status-badge connected';
      badgeText.textContent = 'RUNNING · CONNECTED';
    } else if (st.isRunning && !st.isConnected) {
      badge.className = 'status-badge connecting';
      badgeText.textContent = 'RUNNING · RECONNECTING';
    } else {
      badge.className = 'status-badge stopped';
      badgeText.textContent = 'WORKER STOPPED';
    }

    $('#headerNotebookName').textContent = st.notebookTitle || st.notebookUrl || 'Colab Notebook';
    $('#vpsUptimeText').textContent = fmtHumanDuration(st.vpsUptimeSec);
    $('#headlessBadge').textContent = `Headless: ${st.headless ? 'ON' : 'OFF'}`;
    $('#autoRunBadge').textContent = `Auto-Run: ${st.autoRunOnConnect ? 'ON' : 'OFF'}`;

    // Metrics
    $('#sessionTimerText').textContent = fmtDuration(st.sessionDurationSec);
    $('#totalRuntimeText').textContent = fmtHumanDuration(st.totalSecondsRun);

    if (st.sessionStartAt && st.isRunning) {
      $('#sessionStartSub').textContent = `Started: ${new Date(st.sessionStartAt).toLocaleTimeString()}`;
    } else {
      $('#sessionStartSub').textContent = 'Worker idle / not running';
    }

    // Resources (RAM / Disk)
    if (st.resources) {
      const res = st.resources;
      // RAM
      if (res.memory) {
        const mem = res.memory;
        const pct = Math.round((mem.utilization || (mem.total ? 1 - mem.available / mem.total : 0)) * 100);
        $('#ramDetailText').textContent = `${pct}% (${fmtBytes(mem.total - mem.available)} / ${fmtBytes(mem.total)})`;
        const ramFill = $('#ramProgressFill');
        ramFill.style.width = `${pct}%`;
        ramFill.className = `progress-bar-fill ${pct > 85 ? 'danger' : pct > 65 ? 'warning' : ''}`;
        $('#ramSubText').textContent = 'Live Google Compute Engine RAM';
      }
      // Disk
      if (res.disk) {
        const disk = res.disk;
        const pct = Math.round((disk.utilization || (disk.total ? 1 - disk.available / disk.total : 0)) * 100);
        $('#diskDetailText').textContent = `${pct}% (${fmtBytes(disk.total - disk.available)} / ${fmtBytes(disk.total)})`;
        const diskFill = $('#diskProgressFill');
        diskFill.style.width = `${pct}%`;
        diskFill.className = `progress-bar-fill ${pct > 85 ? 'danger' : pct > 65 ? 'warning' : ''}`;
        $('#diskSubText').textContent = 'Colab Local Storage';
      }
    } else {
      $('#ramDetailText').textContent = '—';
      $('#ramProgressFill').style.width = '0%';
      $('#diskDetailText').textContent = '—';
      $('#diskProgressFill').style.width = '0%';
      $('#ramSubText').textContent = st.isRunning ? 'Waiting for runtime stats' : 'Worker stopped';
      $('#diskSubText').textContent = st.isRunning ? 'Waiting for disk stats' : 'Worker stopped';
    }

    // Button states
    $('#startWorkerBtn').disabled = st.isRunning;
    $('#stopWorkerBtn').disabled = !st.isRunning;
  }

  // ── Logs Management ──
  function appendLog(entry) {
    const terminal = $('#terminalLogs');
    const div = document.createElement('div');
    div.className = `log-entry ${entry.level || 'info'}`;
    div.textContent = `[${entry.timestamp || ''}] [${(entry.level || 'info').toUpperCase()}] ${entry.msg}`;

    // Filter check
    const filterText = $('#logFilterInput').value.trim().toLowerCase();
    if (filterText && !div.textContent.toLowerCase().includes(filterText)) {
      div.style.display = 'none';
    }

    terminal.appendChild(div);

    if (autoScrollLogs) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  }

  function renderAllLogs(logs) {
    const terminal = $('#terminalLogs');
    terminal.innerHTML = '';
    if (!logs || logs.length === 0) {
      terminal.innerHTML = '<div class="log-entry info">[System] No logs recorded yet.</div>';
      return;
    }
    logs.forEach(appendLog);
  }

  $('#logFilterInput').addEventListener('input', (e) => {
    const val = e.target.value.trim().toLowerCase();
    $$('.log-entry').forEach((el) => {
      el.style.display = !val || el.textContent.toLowerCase().includes(val) ? '' : 'none';
    });
  });

  $('#clearLogsBtn').addEventListener('click', async () => {
    try {
      await api('/api/logs/clear', 'POST');
      $('#terminalLogs').innerHTML = '<div class="log-entry info">[System] Logs cleared.</div>';
      showToast('Logs cleared');
    } catch (_) {}
  });

  $('#scrollToggleBtn').addEventListener('click', () => {
    autoScrollLogs = !autoScrollLogs;
    $('#scrollToggleBtn').style.opacity = autoScrollLogs ? '1' : '0.4';
    showToast(autoScrollLogs ? 'Auto-scroll ON' : 'Auto-scroll OFF');
  });

  // ── Real-Time SSE Stream ──
  function connectSSE() {
    if (sseSource) sseSource.close();
    sseSource = new EventSource('/api/events');

    sseSource.addEventListener('init', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.status) renderStatus(data.status);
        if (data.logs) renderAllLogs(data.logs);
      } catch (_) {}
    });

    sseSource.addEventListener('status', (e) => {
      try {
        const data = JSON.parse(e.data);
        renderStatus(data);
      } catch (_) {}
    });

    sseSource.addEventListener('log', (e) => {
      try {
        const data = JSON.parse(e.data);
        appendLog(data);
      } catch (_) {}
    });

    sseSource.onerror = () => {
      // Reconnect after 4s
      setTimeout(() => {
        if (authToken) connectSSE();
      }, 4000);
    };
  }

  async function loadStatus() {
    try {
      const res = await api('/api/status');
      if (res && res.ok) renderStatus(res.status);
    } catch (_) {}
  }

  async function loadLogs() {
    try {
      const res = await api('/api/logs');
      if (res && res.ok) renderAllLogs(res.logs);
    } catch (_) {}
  }

  async function loadConfig() {
    try {
      const res = await api('/api/config');
      if (res && res.ok && res.config) {
        const c = res.config;
        $('#configNotebookUrl').value = c.notebookUrl || '';
        $('#configKeepalive').value = Math.round((c.keepaliveMs || 60000) / 1000);
        $('#configRetry').value = Math.round((c.retryConnectMs || 10000) / 1000);
        $('#configAutoRun').checked = c.autoRunOnConnect !== false;
        $('#configHeadless').checked = c.headless !== false;
      }
    } catch (_) {}
  }

  // ── Worker Action Handlers ──
  $('#startWorkerBtn').addEventListener('click', async () => {
    $('#startWorkerBtn').disabled = true;
    showToast('Starting Playwright worker...');
    try {
      const res = await api('/api/worker/start', 'POST');
      if (res.ok) showToast('✅ Worker launched successfully');
      else showToast('❌ ' + res.message, true);
    } catch (e) {
      showToast('❌ Start failed: ' + e.message, true);
    }
  });

  $('#stopWorkerBtn').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to stop the 24/7 worker?')) return;
    showToast('Stopping worker...');
    try {
      await api('/api/worker/stop', 'POST');
      showToast('Worker stopped');
    } catch (e) {
      showToast('❌ Stop failed', true);
    }
  });

  $('#restartWorkerBtn').addEventListener('click', async () => {
    showToast('Restarting Playwright instance...');
    try {
      const res = await api('/api/worker/restart', 'POST');
      if (res.ok) showToast('✅ Restarted successfully');
      else showToast('❌ ' + res.message, true);
    } catch (e) {
      showToast('❌ Restart failed', true);
    }
  });

  $('#runAllBtn').addEventListener('click', async () => {
    showToast('⚡ Triggering Run All (Ctrl+F9)...');
    try {
      const res = await api('/api/worker/run-all', 'POST');
      if (res.ok) showToast('✅ Run All command sent to Colab');
      else showToast('❌ ' + (res.error || 'Failed to send keys'), true);
    } catch (e) {
      showToast('❌ Failed: ' + e.message, true);
    }
  });

  $('#reconnectBtn').addEventListener('click', async () => {
    showToast('🔌 Forcing Reconnect...');
    try {
      await api('/api/worker/reconnect', 'POST');
      showToast('Reconnect signal sent');
    } catch (_) {}
  });

  // ── Screenshot Modal ──
  async function fetchScreenshot() {
    const loading = $('#screenshotLoading');
    const img = $('#screenshotImg');
    loading.style.display = 'block';
    img.style.display = 'none';

    try {
      const headers = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      if (customVpsUrl) headers['X-VPS-URL'] = customVpsUrl;
      if (customVpsSecret) headers['X-API-Secret'] = customVpsSecret;

      const res = await fetch('/api/screenshot', { headers });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        img.src = url;
        loading.style.display = 'none';
        img.style.display = 'block';
      } else {
        loading.innerHTML = '<p style="color:var(--danger)">No active screenshot. (Worker may be stopped or initializing)</p>';
      }
    } catch (e) {
      loading.innerHTML = `<p style="color:var(--danger)">Error: ${e.message}</p>`;
    }
  }

  $('#viewScreenshotBtn').addEventListener('click', () => {
    $('#screenshotModal').style.display = 'flex';
    fetchScreenshot();
  });

  $('#refreshScreenshotBtn').addEventListener('click', fetchScreenshot);
  $('#closeScreenshotModalBtn').addEventListener('click', () => {
    $('#screenshotModal').style.display = 'none';
  });

  // ── Oracle VPS Backend Settings Modal ──
  function openVpsModal() {
    $('#vpsUrlInput').value = customVpsUrl || '';
    $('#vpsSecretInput').value = customVpsSecret || '';
    $('#vpsTestResult').style.display = 'none';
    $('#vpsSettingsModal').style.display = 'flex';
  }

  $('#openVpsSettingsBtn').addEventListener('click', openVpsModal);
  $('#vpsNodePill').addEventListener('click', openVpsModal);

  $('#closeVpsSettingsBtn').addEventListener('click', () => {
    $('#vpsSettingsModal').style.display = 'none';
  });

  $('#testVpsBtn').addEventListener('click', async () => {
    const testUrl = $('#vpsUrlInput').value.trim();
    const testSecret = $('#vpsSecretInput').value.trim();
    const resultBox = $('#vpsTestResult');
    const testBtn = $('#testVpsBtn');

    testBtn.disabled = true;
    testBtn.textContent = '⏳ Testing...';
    resultBox.style.display = 'block';
    resultBox.className = 'alert-box info';
    resultBox.textContent = 'Connecting to Oracle VPS node...';

    const testHeaders = { 'Content-Type': 'application/json' };
    if (testUrl) testHeaders['X-VPS-URL'] = testUrl;
    if (testSecret) testHeaders['X-API-Secret'] = testSecret;

    try {
      const res = await fetch('/api/health', { headers: testHeaders });
      const data = await res.json();
      if (res.ok && data.ok) {
        resultBox.className = 'alert-box success';
        resultBox.textContent = `✅ Successfully connected to Oracle VPS! (Uptime: ${fmtHumanDuration(data.uptimeSec)}, Worker running: ${data.isRunning ? 'YES' : 'NO'})`;
        showToast('✅ VPS Node Connection Successful!');
      } else {
        resultBox.className = 'alert-box error';
        resultBox.textContent = '❌ Failed: ' + (data.error || 'Unknown error response');
      }
    } catch (err) {
      resultBox.className = 'alert-box error';
      resultBox.textContent = '❌ Connection Error: ' + err.message;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '⚡ Test Connection';
    }
  });

  $('#vpsSettingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    customVpsUrl = $('#vpsUrlInput').value.trim();
    customVpsSecret = $('#vpsSecretInput').value.trim();

    if (customVpsUrl) {
      setStorage('colab_vps_url', customVpsUrl);
    } else {
      removeStorage('colab_vps_url');
    }

    if (customVpsSecret) {
      setStorage('colab_vps_secret', customVpsSecret);
    } else {
      removeStorage('colab_vps_secret');
    }

    $('#vpsSettingsModal').style.display = 'none';
    showToast('💾 VPS settings saved & applied!');
    checkVpsHealth();
    loadStatus();
    loadLogs();
  });

  // ── Import JSON Modal ──
  $('#importJsonModalBtn').addEventListener('click', () => {
    $('#importModal').style.display = 'flex';
  });

  $('#closeImportModalBtn').addEventListener('click', () => {
    $('#importModal').style.display = 'none';
  });
  $('#cancelImportBtn').addEventListener('click', () => {
    $('#importModal').style.display = 'none';
  });

  $('#confirmImportBtn').addEventListener('click', async () => {
    const raw = $('#importJsonTextarea').value.trim();
    if (!raw) {
      showToast('Please paste valid JSON', true);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const res = await api('/api/profile/import', 'POST', parsed);
      if (res.ok) {
        showToast('✅ Profile data imported into VPS!');
        $('#importModal').style.display = 'none';
        $('#importJsonTextarea').value = '';
        loadConfig();
      } else {
        showToast('❌ Import error: ' + res.error, true);
      }
    } catch (e) {
      showToast('❌ Invalid JSON syntax', true);
    }
  });

  // ── Google Session Cookies Import ──
  $('#cookieImportBtn').addEventListener('click', () => {
    $('#cookieImportResult').style.display = 'none';
    $('#cookieImportModal').style.display = 'flex';
  });

  $('#closeCookieImportBtn').addEventListener('click', () => {
    $('#cookieImportModal').style.display = 'none';
  });
  $('#cancelCookieImportBtn').addEventListener('click', () => {
    $('#cookieImportModal').style.display = 'none';
  });

  $('#confirmCookieImportBtn').addEventListener('click', async () => {
    const raw = $('#cookieJsonTextarea').value.trim();
    if (!raw) {
      showToast('Please paste cookie JSON', true);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      showToast('❌ Invalid JSON syntax', true);
      return;
    }
    const resultBox = $('#cookieImportResult');
    const btn = $('#confirmCookieImportBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Importing cookies...';
    try {
      const res = await api('/api/cookies/import', 'POST', parsed);
      if (res.ok) {
        const validTxt = res.valid
          ? '✅ Valid Google session — worker ab login nahi maangega'
          : '⚠️ Cookies seem expired — Chrome se fresh export karo';
        resultBox.textContent = `Imported ${res.count} cookies → ${validTxt}`;
        resultBox.className = 'alert-box ' + (res.valid ? 'success' : 'warning');
        resultBox.style.display = 'block';
        showToast(res.valid ? '✅ Cookies imported & valid!' : '⚠️ Cookies imported but expired', !res.valid);
        $('#cookieJsonTextarea').value = '';
      } else {
        resultBox.textContent = '❌ ' + (res.error || 'Import failed');
        resultBox.className = 'alert-box error';
        resultBox.style.display = 'block';
        showToast('❌ ' + (res.error || 'Import failed'), true);
      }
    } catch (e) {
      showToast('❌ Import error: ' + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '✅ Import Cookies';
    }
  });

  // ── Save Configuration ──
  $('#configForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const notebookUrl = $('#configNotebookUrl').value.trim();
    const keepaliveMs = parseInt($('#configKeepalive').value, 10) * 1000;
    const retryConnectMs = parseInt($('#configRetry').value, 10) * 1000;
    const autoRunOnConnect = $('#configAutoRun').checked;
    const headless = $('#configHeadless').checked;

    try {
      const res = await api('/api/config', 'POST', {
        notebookUrl,
        keepaliveMs,
        retryConnectMs,
        autoRunOnConnect,
        headless
      });
      if (res.ok) {
        showToast('💾 Configuration saved!');
      } else {
        showToast('❌ ' + res.error, true);
      }
    } catch (err) {
      showToast('❌ Save error: ' + err.message, true);
    }
  });

  // ── Update Password ──
  $('#passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPassword = $('#newPasswordInput').value.trim();
    if (!newPassword || newPassword.length < 6) {
      showToast('Password must be at least 6 characters', true);
      return;
    }
    try {
      const res = await api('/api/auth/update', 'POST', { newPassword });
      if (res.ok) {
        showToast('🔐 Password updated successfully');
        $('#newPasswordInput').value = '';
      } else {
        showToast('❌ ' + res.error, true);
      }
    } catch (err) {
      showToast('❌ Failed: ' + err.message, true);
    }
  });

  // Live Timer Tick
  setInterval(() => {
    if (currentStatus && currentStatus.isRunning && currentStatus.sessionStartAt) {
      const sec = Math.floor((Date.now() - currentStatus.sessionStartAt) / 1000);
      $('#sessionTimerText').textContent = fmtDuration(sec);
    }
  }, 1000);

  // Init
  document.addEventListener('DOMContentLoaded', checkAuth);
})();
