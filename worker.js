// ============================================================
//  🤖 COLAB 24/7 WORKER — Playwright Controller (VPS Ready)
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
    this.loopTimer = null;
    this.sessionStartAt = null;
    this.lastPingAt = null;
    this.totalSecondsRun = 0;
    this.lastError = null;
    this.latestResources = null;
    this.latestScreenshot = null;
    this.notebookTitle = "Google Colab Notebook";
    this.wasDisconnected = false;
    this.ranForThisConnection = false;
    this.baseDir = path.dirname(configPath);
    this.userDataDir = path.join(this.baseDir, 'profile');
    this.logFile = path.join(this.baseDir, 'colab_keeper.log');
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      }
    } catch (e) {
      this.log('Error loading config.json:', e.message, 'error');
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
    this.config = { ...this.config, ...newConfig };
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

  async start() {
    if (this.isRunning) {
      this.log('Worker is already running', 'warn');
      return { ok: false, message: 'Already running' };
    }

    this.config = this.loadConfig();
    this.isRunning = true;
    this.isStopping = false;
    this.lastError = null;
    this.wasDisconnected = false;
    this.ranForThisConnection = false;
    this.sessionStartAt = Date.now();
    this.lastPingAt = Date.now();

    this.log(`🚀 Starting Playwright (${this.config.headless ? 'HEADLESS' : 'HEADED'} mode)...`, 'info');

    try {
      const isLinux = process.platform === 'linux';
      const launchArgs = isLinux
        ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        : ['--start-maximized'];

      const headers = {};
      if (this.config.profile && this.config.profile.token) {
        headers['X-Colab-Runtime-Proxy-Token'] = this.config.profile.token;
      }

      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        headless: this.config.headless !== false,
        viewport: { width: 1280, height: 800 },
        args: launchArgs,
        extraHTTPHeaders: headers
      });

      this.page = this.context.pages()[0] || (await this.context.newPage());

      this.page.on('crash', async () => {
        this.log('⚠️ Page crashed! Attempting reload...', 'error');
        await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      });

      this.page.on('pageerror', (err) => {
        // Suppress benign internal Colab errors
        if (!err.message.includes('ResizeObserver') && !err.message.includes('Extension')) {
          this.log(`Browser Page Error: ${err.message.substring(0, 100)}`, 'warn');
        }
      });

      const targetUrl = this.config.notebookUrl || 'https://colab.research.google.com/';
      this.log(`Navigating to: ${targetUrl}`, 'info');

      await this.page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000
      }).catch((e) => {
        this.log(`Navigation note: ${e.message}`, 'warn');
      });

      // Wait for page to initialize
      await this.page.waitForTimeout(3000);
      try {
        this.notebookTitle = (await this.page.title()).replace(/\s*-\s*Colab.*$/i, '').trim() || "Colab Notebook";
      } catch (_) {}

      this.log(`Notebook loaded: ${this.notebookTitle}`, 'info');

      // Start the monitoring & keep-alive loop
      this.runMonitoringLoop();

      this.emit('status_change', this.getStatus());
      return { ok: true };
    } catch (err) {
      this.isRunning = false;
      this.isConnected = false;
      this.log(`Failed to start worker: ${err.message}`, 'error');
      await this.cleanup();
      this.emit('status_change', this.getStatus());
      return { ok: false, message: err.message };
    }
  }

  async runMonitoringLoop() {
    while (this.isRunning && !this.isStopping) {
      try {
        // 1. Keep-alive click on connect button
        await this.clickConnectButton();

        // 2. Check if connected
        const connected = await this.checkIfConnected();
        this.isConnected = connected;

        if (connected) {
          this.lastPingAt = Date.now();
          this.totalSecondsRun += Math.floor((this.config.keepaliveMs || 60000) / 1000);

          // 3. Extract live resource metrics
          const res = await this.extractResourceMetrics();
          if (res) this.latestResources = res;

          // 4. Trigger Run All on first connect or reconnect
          if (this.config.autoRunOnConnect !== false && (this.wasDisconnected || !this.ranForThisConnection)) {
            this.log('✅ Runtime connected — triggering Auto Run All...', 'info');
            const waitMs = this.config.waitAfterConnectMs || 6000;
            await this.page.waitForTimeout(waitMs);
            await this.triggerRunAll();
            this.wasDisconnected = false;
            this.ranForThisConnection = true;
          }

          this.emit('status_change', this.getStatus());
          await this.sleep(this.config.keepaliveMs || 60000);
        } else {
          if (!this.wasDisconnected) {
            this.log('🚨 Session disconnected/stopped — attempting auto-reconnect...', 'warn');
            this.wasDisconnected = true;
            this.ranForThisConnection = false;
          }

          this.emit('status_change', this.getStatus());
          await this.sleep(this.config.retryConnectMs || 10000);
        }
      } catch (err) {
        if (!this.isStopping) {
          this.log(`Loop exception: ${err.message}`, 'warn');
          await this.sleep(5000);
        }
      }
    }
  }

  async clickConnectButton() {
    if (!this.page || this.page.isClosed()) return null;
    return this.page.evaluate(() => {
      // 1. Top toolbar connect button
      const tb = document.querySelector('#top-toolbar > colab-connect-button, colab-connect-button');
      if (tb && tb.shadowRoot) {
        const b = tb.shadowRoot.querySelector('connect, #connect, mwc-button, button');
        if (b) { b.click(); return 'connect_top'; }
      }
      // 2. Reconnect button
      const rc = document.querySelector('colab-reconnect-button, #reconnect');
      if (rc && rc.shadowRoot) {
        const b = rc.shadowRoot.querySelector('connect, #connect, button');
        if (b) { b.click(); return 'reconnect'; }
      }
      // 3. Simple DOM fallback
      const normalBtn = document.querySelector('#connect, .colab-connect-button');
      if (normalBtn) { normalBtn.click(); return 'connect_fallback'; }
      return null;
    }).catch(() => null);
  }

  async checkIfConnected() {
    if (!this.page || this.page.isClosed()) return false;
    return this.page.evaluate(() => {
      if (document.querySelector('colab-reconnect-button')) return false;

      const tb = document.querySelector('#top-toolbar > colab-connect-button, colab-connect-button');
      if (tb) {
        if (tb.hasAttribute('connected') || tb.classList.contains('connected')) return true;
        if (tb.getAttribute('connected') === 'true') return true;
        const txt = ((tb.shadowRoot && tb.shadowRoot.textContent) || '').toLowerCase();
        if (txt.includes('connected') || txt.includes('ram') || txt.includes('disk') || txt.includes('check')) return true;
      }

      // Check page text for compute engine indication
      const bodyText = document.body ? document.body.innerText : '';
      if (/google compute engine|connected|busy|executing/i.test(bodyText) && /ram/i.test(bodyText)) {
        return true;
      }
      return false;
    }).catch(() => false);
  }

  async extractResourceMetrics() {
    if (!this.page || this.page.isClosed()) return null;
    return this.page.evaluate(() => {
      try {
        const text = document.body ? document.body.innerText : '';
        let ram = null, disk = null;

        const ramMatch = text.match(/RAM\s*[:\n]?\s*([\d.]+)\s*(GB|MB)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
        if (ramMatch) {
          const used = parseFloat(ramMatch[1]) * (ramMatch[2].toUpperCase() === "GB" ? 1e9 : 1e6);
          const total = parseFloat(ramMatch[3]) * (ramMatch[4].toUpperCase() === "GB" ? 1e9 : 1e6);
          ram = { available: Math.max(0, total - used), total, utilization: total > 0 ? used / total : 0 };
        }

        const diskMatch = text.match(/Disk\s*[:\n]?\s*([\d.]+)\s*(GB|MB)\s*\/\s*([\d.]+)\s*(GB|MB)/i);
        if (diskMatch) {
          const used = parseFloat(diskMatch[1]) * (diskMatch[2].toUpperCase() === "GB" ? 1e9 : 1e6);
          const total = parseFloat(diskMatch[3]) * (diskMatch[4].toUpperCase() === "GB" ? 1e9 : 1e6);
          disk = { available: Math.max(0, total - used), total, utilization: total > 0 ? used / total : 0 };
        }

        return { memory: ram, disk: disk };
      } catch (_) {
        return null;
      }
    }).catch(() => null);
  }

  async triggerRunAll() {
    if (!this.page || this.page.isClosed()) return { ok: false };
    const runKey = process.platform === 'darwin' ? 'Meta+F9' : 'Control+F9';
    this.log(`⚡ Sending keyboard shortcut: ${runKey} (Run All Cells)`, 'info');
    try {
      await this.page.keyboard.press(runKey);
      return { ok: true, message: `Pressed ${runKey}` };
    } catch (e) {
      this.log(`Failed to press ${runKey}: ${e.message}`, 'error');
      return { ok: false, error: e.message };
    }
  }

  async forceReconnect() {
    this.log('🔄 Manual reconnect triggered', 'info');
    await this.clickConnectButton();
    if (this.page) {
      await this.page.evaluate(() => {
        const rc = document.querySelector('colab-reconnect-button');
        if (rc && rc.shadowRoot) {
          const b = rc.shadowRoot.querySelector('connect, button');
          if (b) b.click();
        }
      }).catch(() => {});
    }
    return { ok: true };
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
    this.log('🛑 Stopping Colab worker...', 'info');
    this.isStopping = true;
    this.isRunning = false;
    this.isConnected = false;
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
    const curDuration = this.sessionStartAt && this.isRunning ? Math.floor((now - this.sessionStartAt) / 1000) : 0;

    return {
      isRunning: this.isRunning,
      isConnected: this.isConnected,
      notebookTitle: this.notebookTitle,
      notebookUrl: this.config.notebookUrl,
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
