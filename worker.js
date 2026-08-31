// ============================================================
//  COLAB WORKER — Emergency/Manual Recovery Tool (VPS Ready)
//  VPS is the PRIMARY system. This worker is MANUAL-ONLY.
// ============================================================

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

class ColabWorker extends EventEmitter {
  constructor(configPath) {
    super();
    this.configPath = configPath;
    this.config = this.loadConfig();
    this.context = null;
    this.page = null;
    this.isRunning = false;
    this.isConnected = false;
    this.isStopping = false;
    this.sessionStartAt = null;
    this.lastPingAt = null;
    this.totalSecondsRun = 0;
    this.lastError = null;
    this.latestResources = null;
    this.latestScreenshot = null;
    this.notebookTitle = 'Google Colab Notebook';
    this.wasDisconnected = false;
    this.ranForThisConnection = false;
    this.runtimeState = { state: 'UNKNOWN', reason: 'not-started' };
    this.baseDir = path.dirname(configPath);
    this.userDataDir = path.join(this.baseDir, 'profile');
    this.logFile = path.join(this.baseDir, 'colab_keeper.log');
    this._startLock = false;
    this._reconnectLock = false;
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      }
    } catch (e) {
      this.log('Error loading config.json: ' + e.message, 'error');
    }
    return {
      notebookUrl: 'https://colab.research.google.com/',
      headless: true,
      keepaliveMs: 60000,
      retryConnectMs: 10000,
      waitAfterConnectMs: 6000,
      autoRunOnConnect: true,
    };
  }

  saveConfig(newConfig) {
    // Deep-merge: preserve nested objects like `profile` unless explicitly replaced
    const merged = { ...this.config };
    for (const key of Object.keys(newConfig)) {
      if (
        newConfig[key] !== null &&
        typeof newConfig[key] === 'object' &&
        !Array.isArray(newConfig[key]) &&
        typeof merged[key] === 'object' &&
        merged[key] !== null
      ) {
        merged[key] = { ...merged[key], ...newConfig[key] };
      } else {
        merged[key] = newConfig[key];
      }
    }
    this.config = merged;
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      this.log('Configuration saved to disk', 'info');
    } catch (e) {
      this.log('Failed to save config.json: ' + e.message, 'error');
    }
  }

  log(msg, level = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const entry = { timestamp, msg, level };
    const line = `[${timestamp}] [${level.toUpperCase()}] ${msg}`;
    console.log(line);
    try {
      fs.appendFileSync(this.logFile, line + '\n');
    } catch (_) {}
    this.emit('log', entry);
    if (level === 'error') {
      this.lastError = msg;
    }
  }

  // Detect system Chromium for VPS/desktop environments
  _detectExecutablePath() {
    if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
      return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    }
    if (this.config.executablePath) {
      return this.config.executablePath;
    }
    const candidates = process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          process.env.LOCALAPPDATA
            ? process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
            : '',
          'C:\\Program Files\\Chromium\\Application\\chrome.exe',
        ]
      : [
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/nix/var/nix/profiles/default/bin/chromium',
        ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        this.log(`Found system Chromium at: ${p}`, 'info');
        return p;
      }
    }
    // Fall back to Playwright's bundled executable
    return undefined;
  }

  async start() {
    if (this._startLock || this.isRunning) {
      this.log('Worker is already running or starting', 'warn');
      return { ok: false, message: 'Already running' };
    }
    this._startLock = true;

    this.config = this.loadConfig();
    this.isRunning = true;
    this.isStopping = false;
    this.lastError = null;
    this.wasDisconnected = false;
    this.ranForThisConnection = false;
    this.sessionStartAt = Date.now();
    this.lastPingAt = Date.now();
    this.runtimeState = { state: 'LOADING', reason: 'starting' };

    this.log(`Starting Playwright (${this.config.headless ? 'HEADLESS' : 'HEADED'} mode)...`, 'info');

    try {
      const isLinux = process.platform === 'linux';
      const launchArgs = isLinux
        ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        : ['--start-maximized'];

      const executablePath = this._detectExecutablePath();
      if (executablePath) {
        this.log(`Using Chromium executable: ${executablePath}`, 'info');
      } else {
        this.log('Using Playwright bundled Chromium', 'info');
      }

      const launchOpts = {
        headless: this.config.headless !== false,
        viewport: { width: 1280, height: 800 },
        args: launchArgs,
      };
      if (executablePath) {
        launchOpts.executablePath = executablePath;
      }

      this.context = await chromium.launchPersistentContext(this.userDataDir, launchOpts);

      this.page = this.context.pages()[0] || (await this.context.newPage());

      this.page.on('crash', async () => {
        this.log('Page crashed — attempting reload...', 'error');
        this.runtimeState = { state: 'UNKNOWN', reason: 'page-crash' };
        await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      });

      this.page.on('pageerror', (err) => {
        if (!err.message.includes('ResizeObserver') && !err.message.includes('Extension')) {
          this.log(`Browser page error: ${err.message.substring(0, 100)}`, 'warn');
        }
      });

      this.context.on('close', () => {
        if (!this.isStopping) {
          this.log('Browser context closed unexpectedly', 'warn');
          this.isRunning = false;
          this.isConnected = false;
          this.runtimeState = { state: 'UNKNOWN', reason: 'context-closed' };
          this.emit('status_change', this.getStatus());
        }
      });

      const targetUrl = this.config.notebookUrl || 'https://colab.research.google.com/';
      this.log(`Navigating to notebook...`, 'info');

      await this.page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
      }).catch((e) => {
        this.log(`Navigation note: ${e.message}`, 'warn');
      });

      await this.page.waitForTimeout(4000);

      try {
        this.notebookTitle = (await this.page.title())
          .replace(/\s*-\s*Colab.*$/i, '').trim() || 'Colab Notebook';
      } catch (_) {}

      this.log(`Notebook loaded: ${this.notebookTitle}`, 'info');
      this._startLock = false;

      this.runMonitoringLoop();

      this.emit('status_change', this.getStatus());
      return { ok: true };
    } catch (err) {
      this._startLock = false;
      this.isRunning = false;
      this.isConnected = false;
      this.runtimeState = { state: 'UNKNOWN', reason: 'launch-failed' };
      this.log(`Failed to start worker: ${err.message}`, 'error');
      await this.cleanup();
      this.emit('status_change', this.getStatus());
      return { ok: false, message: err.message };
    }
  }

  // ─── Core: Structured runtime state detection ───────────────────
  async getRuntimeState() {
    if (!this.page || this.page.isClosed()) {
      return { state: 'UNKNOWN', reason: 'no-page' };
    }

    try {
      const result = await this.page.evaluate(() => {
        // 1. Check if we're on a Google login page
        const currentUrl = window.location.href || '';
        if (
          currentUrl.includes('accounts.google.com') ||
          currentUrl.includes('google.com/signin') ||
          currentUrl.includes('google.com/ServiceLogin')
        ) {
          return { state: 'LOGIN_REQUIRED', reason: 'google-accounts-url' };
        }

        // 2. Check for explicit reconnect button that is VISIBLE
        const reconnectBtn = document.querySelector('colab-reconnect-button');
        if (reconnectBtn) {
          const style = window.getComputedStyle(reconnectBtn);
          const rect = reconnectBtn.getBoundingClientRect();
          const isVisible = style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            style.opacity !== '0' &&
                            rect.width > 0 &&
                            rect.height > 0;
          if (isVisible) {
            return { state: 'DISCONNECTED', reason: 'visible-reconnect-button' };
          }
        }

        // 3. Check connect button state
        const tb = document.querySelector('#top-toolbar > colab-connect-button, colab-connect-button');
        if (tb) {
          // Strong connected signals
          if (tb.hasAttribute('connected') || tb.getAttribute('connected') === 'true') {
            return { state: 'CONNECTED', reason: 'connected-attribute' };
          }
          if (tb.classList.contains('connected')) {
            return { state: 'CONNECTED', reason: 'connected-class' };
          }

          // Shadow root text signals
          const shadowText = ((tb.shadowRoot && tb.shadowRoot.textContent) || '').toLowerCase();
          if (shadowText.includes('ram') || shadowText.includes('disk')) {
            return { state: 'CONNECTED', reason: 'resource-metrics-visible' };
          }
          if (shadowText.includes('connected')) {
            return { state: 'CONNECTED', reason: 'connected-text' };
          }
          // Spinner/loading state
          if (shadowText.includes('connect') && !shadowText.includes('reconnect')) {
            return { state: 'LOADING', reason: 'connect-button-present-loading' };
          }
        }

        // 4. Check body content for resource indicators (conservative — requires RAM)
        const bodyText = document.body ? document.body.innerText : '';
        if (/google compute engine/i.test(bodyText) && /\bRAM\b/i.test(bodyText)) {
          return { state: 'CONNECTED', reason: 'compute-engine-ram-text' };
        }

        // 5. If page doesn't look like colab at all
        if (!document.querySelector('colab-connect-button') && !document.querySelector('#top-toolbar')) {
          return { state: 'UNKNOWN', reason: 'not-a-colab-page' };
        }

        return { state: 'DISCONNECTED', reason: 'unknown-state' };
      });

      return result;
    } catch (e) {
      return { state: 'UNKNOWN', reason: 'evaluate-error: ' + e.message.substring(0, 60) };
    }
  }

  // ─── Attempt reconnect (only call when genuinely disconnected) ──
  async attemptReconnect() {
    if (!this.page || this.page.isClosed()) return false;
    this.log('Attempting reconnect via connect button...', 'info');
    try {
      const clicked = await this.page.evaluate(() => {
        // Try colab-reconnect-button first
        const rc = document.querySelector('colab-reconnect-button');
        if (rc && rc.shadowRoot) {
          const b = rc.shadowRoot.querySelector('button, connect, #connect');
          if (b) { b.click(); return 'reconnect-button'; }
        }
        // Try top toolbar connect button
        const tb = document.querySelector('#top-toolbar > colab-connect-button, colab-connect-button');
        if (tb && tb.shadowRoot) {
          const b = tb.shadowRoot.querySelector('mwc-button, button, connect, #connect');
          if (b) { b.click(); return 'connect-top'; }
        }
        // DOM fallback
        const normalBtn = document.querySelector('#connect, .colab-connect-button');
        if (normalBtn) { normalBtn.click(); return 'connect-fallback'; }
        return null;
      }).catch(() => null);

      if (clicked) {
        this.log(`Reconnect click sent (${clicked})`, 'info');
        return true;
      } else {
        this.log('Reconnect: no clickable connect button found', 'warn');
        return false;
      }
    } catch (e) {
      this.log(`Reconnect error: ${e.message}`, 'warn');
      return false;
    }
  }

  async runMonitoringLoop() {
    while (this.isRunning && !this.isStopping) {
      try {
        // 1. Detect runtime state FIRST
        const stateResult = await this.getRuntimeState();
        this.runtimeState = stateResult;
        this.log(`Runtime state: ${stateResult.state} (${stateResult.reason})`, 'info');

        if (stateResult.state === 'CONNECTED') {
          this.isConnected = true;
          this.lastPingAt = Date.now();
          this.totalSecondsRun += Math.floor((this.config.keepaliveMs || 60000) / 1000);

          // Extract resource metrics
          const res = await this.extractResourceMetrics();
          if (res) this.latestResources = res;

          // Run All only once per fresh connection (not every loop)
          if (this.config.autoRunOnConnect !== false && (this.wasDisconnected || !this.ranForThisConnection)) {
            this.log('Runtime connected — triggering Auto Run All (once)...', 'info');
            const waitMs = this.config.waitAfterConnectMs || 6000;
            await this.sleep(waitMs);
            await this.triggerRunAll();
            this.wasDisconnected = false;
            this.ranForThisConnection = true;
          }

          this.emit('status_change', this.getStatus());
          await this.sleep(this.config.keepaliveMs || 60000);

        } else if (stateResult.state === 'DISCONNECTED') {
          this.isConnected = false;
          if (!this.wasDisconnected) {
            this.log('Runtime disconnected — will attempt reconnect...', 'warn');
            this.wasDisconnected = true;
            this.ranForThisConnection = false;
          }
          // Attempt reconnect only when genuinely disconnected
          await this.attemptReconnect();
          this.emit('status_change', this.getStatus());
          await this.sleep(this.config.retryConnectMs || 10000);

        } else if (stateResult.state === 'LOGIN_REQUIRED') {
          this.isConnected = false;
          this.log('Google login required — cannot auto-login. Manual action needed.', 'warn');
          this.emit('status_change', this.getStatus());
          // Check again after longer interval — don't spam
          await this.sleep(30000);

        } else if (stateResult.state === 'LOADING') {
          this.isConnected = false;
          this.log('Runtime is loading/initializing...', 'info');
          this.emit('status_change', this.getStatus());
          await this.sleep(8000);

        } else {
          // UNKNOWN
          this.isConnected = false;
          this.log(`Unknown runtime state (${stateResult.reason}) — waiting...`, 'warn');
          this.emit('status_change', this.getStatus());
          await this.sleep(15000);
        }

      } catch (err) {
        if (!this.isStopping) {
          this.log(`Monitoring loop exception: ${err.message}`, 'warn');
          await this.sleep(5000);
        }
      }
    }
  }

  async extractResourceMetrics() {
    if (!this.page || this.page.isClosed()) return null;
    return this.page.evaluate(() => {
      try {
        const text = document.body ? document.body.innerText : '';
        let ram = null, disk = null;

        const ramMatch = text.match(/RAM\s*[:\n]?\s*([\d.]+)\s*(GB|MB)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
        if (ramMatch) {
          const used = parseFloat(ramMatch[1]) * (ramMatch[2].toUpperCase() === 'GB' ? 1e9 : 1e6);
          const total = parseFloat(ramMatch[3]) * (ramMatch[4].toUpperCase() === 'GB' ? 1e9 : 1e6);
          ram = { available: Math.max(0, total - used), total, utilization: total > 0 ? used / total : 0 };
        }

        const diskMatch = text.match(/Disk\s*[:\n]?\s*([\d.]+)\s*(GB|MB)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
        if (diskMatch) {
          const used = parseFloat(diskMatch[1]) * (diskMatch[2].toUpperCase() === 'GB' ? 1e9 : 1e6);
          const total = parseFloat(diskMatch[3]) * (diskMatch[4].toUpperCase() === 'GB' ? 1e9 : 1e6);
          disk = { available: Math.max(0, total - used), total, utilization: total > 0 ? used / total : 0 };
        }

        return { memory: ram, disk };
      } catch (_) {
        return null;
      }
    }).catch(() => null);
  }

  async triggerRunAll() {
    if (!this.page || this.page.isClosed()) return { ok: false, error: 'No active page' };
    const runKey = process.platform === 'darwin' ? 'Meta+F9' : 'Control+F9';
    this.log(`Sending keyboard shortcut: ${runKey} (Run All Cells)`, 'info');
    try {
      await this.page.keyboard.press(runKey);
      return { ok: true, message: `Pressed ${runKey}` };
    } catch (e) {
      this.log(`Failed to send ${runKey}: ${e.message}`, 'error');
      return { ok: false, error: e.message };
    }
  }

  async forceReconnect() {
    if (this._reconnectLock) {
      return { ok: false, message: 'Reconnect already in progress' };
    }
    if (!this.isRunning) {
      return { ok: false, message: 'Worker is not running' };
    }
    this._reconnectLock = true;
    this.log('Manual reconnect triggered', 'info');
    try {
      const ok = await this.attemptReconnect();
      return { ok, message: ok ? 'Reconnect signal sent' : 'No connect button found' };
    } finally {
      this._reconnectLock = false;
    }
  }

  async takeScreenshot() {
    if (!this.page || this.page.isClosed()) return null;
    try {
      const buffer = await this.page.screenshot({ type: 'png' });
      this.latestScreenshot = buffer;
      return buffer;
    } catch (e) {
      this.log(`Screenshot error: ${e.message}`, 'warn');
      return null;
    }
  }

  async stop() {
    if (!this.isRunning) return { ok: true };
    this.log('Stopping Colab worker...', 'info');
    this.isStopping = true;
    this.isRunning = false;
    this.isConnected = false;
    this.runtimeState = { state: 'UNKNOWN', reason: 'stopped' };
    await this.cleanup();
    this.log('Worker stopped cleanly', 'info');
    this.emit('status_change', this.getStatus());
    return { ok: true };
  }

  async cleanup() {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => {});
      }
      if (this.context) {
        await this.context.close().catch(() => {});
      }
    } catch (_) {}
    this.page = null;
    this.context = null;
  }

  getStatus() {
    const now = Date.now();
    const curDuration = this.sessionStartAt && this.isRunning
      ? Math.floor((now - this.sessionStartAt) / 1000)
      : 0;

    return {
      isRunning: this.isRunning,
      isConnected: this.isConnected,
      runtimeState: this.runtimeState,
      notebookTitle: this.notebookTitle,
      // Never expose notebookUrl with token params, just the base notebook URL
      notebookUrl: this.config.notebookUrl
        ? this.config.notebookUrl.replace(/[?&]token=[^&]+/gi, '').replace(/[?&]authuser=[^&]+/gi, '')
        : null,
      headless: this.config.headless !== false,
      autoRunOnConnect: this.config.autoRunOnConnect !== false,
      keepaliveMs: this.config.keepaliveMs || 60000,
      sessionStartAt: this.sessionStartAt,
      lastPingAt: this.lastPingAt,
      sessionDurationSec: curDuration,
      totalSecondsRun: this.totalSecondsRun,
      lastError: this.lastError,
      resources: this.latestResources,
      proxyConfigured: !!(this.config.profile && this.config.profile.proxyUrl),
      vpsUptimeSec: Math.floor(process.uptime()),
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = ColabWorker;
