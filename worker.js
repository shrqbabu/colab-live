// ============================================================
//  🚀 UNIFIED GOOGLE WORKER — Colab & Cloud Shell Automation
// ============================================================

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

class UnifiedGoogleWorker extends EventEmitter {
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
    this.lastCheckAt = null;
    this.nextCheckAt = null;
    this.lastCommandExecuted = null;
    this.lastCommandTime = null;
    this.lastError = null;
    this.latestScreenshot = null;
    this.latestResources = null;
    this.pageTitle = 'Google Session';
    this.runtimeState = { state: 'IDLE', reason: 'not-started' };
    this.baseDir = path.dirname(configPath);
    this.userDataDir = path.join(this.baseDir, 'profile');
    this.savedCookiesPath = path.join(this.baseDir, 'cookies_saved.json');
    this.logFile = path.join(this.baseDir, 'automation.log');
    this._startLock = false;
    this._reconnectLock = false;
    this._ranForThisConnection = false;
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
      mode: 'cloudshell',
      cloudShellUrl: 'https://shell.cloud.google.com/?show=terminal',
      colabUrl: 'https://colab.research.google.com/',
      startupCommand: 'docker start omniroute',
      waitAfterLoadSec: 60,
      checkIntervalMin: 10,
      colabKeepaliveSec: 60,
      colabAutoRun: true,
      port: 8080,
      headless: true,
    };
  }

  saveConfig(newConfig) {
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
      this.log('Configuration saved to config.json', 'info');
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

  _detectExecutablePath() {
    const envPaths = [
      process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      process.env.CHROMIUM_PATH,
      process.env.PUPPETEER_EXECUTABLE_PATH,
      process.env.CHROME_PATH,
      this.config ? this.config.executablePath : null,
    ];
    for (const ep of envPaths) {
      if (ep && fs.existsSync(ep)) {
        this.log(`Found Chromium via environment: ${ep}`, 'info');
        return ep;
      }
    }

    if (process.platform === 'linux' || process.platform === 'darwin') {
      const binaries = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'chrome'];
      try {
        const { execSync } = require('child_process');
        for (const b of binaries) {
          try {
            const found = execSync(`command -v ${b} || which ${b}`, {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            })
              .trim()
              .split('\n')[0]
              .trim();
            if (found && fs.existsSync(found)) {
              this.log(`Found system Chromium (${b}): ${found}`, 'info');
              return found;
            }
          } catch (_) {}
        }
      } catch (_) {}

      const pathDirs = (process.env.PATH || '').split(path.delimiter);
      for (const dir of pathDirs) {
        for (const b of binaries) {
          const full = path.join(dir, b);
          if (fs.existsSync(full)) {
            this.log(`Found Chromium in PATH: ${full}`, 'info');
            return full;
          }
        }
      }
    }

    const candidates =
      process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA
              ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
              : '',
            'C:\\Program Files\\Chromium\\Application\\chrome.exe',
          ]
        : [
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/run/current-system/sw/bin/chromium',
            '/nix/var/nix/profiles/default/bin/chromium',
            '/home/runner/.nix-profile/bin/chromium',
          ];

    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        this.log(`Found system Chromium at: ${p}`, 'info');
        return p;
      }
    }

    try {
      const bundled = chromium.executablePath();
      if (bundled && fs.existsSync(bundled)) {
        this.log(`Using Playwright bundled Chromium: ${bundled}`, 'info');
        return bundled;
      }
    } catch (_) {}

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
    this._ranForThisConnection = false;
    this.sessionStartAt = Date.now();
    this.runtimeState = { state: 'STARTING', reason: 'browser-launch' };

    const mode = this.config.mode || 'cloudshell';
    const isHeadless = this.config.headless !== false && process.env.HEADLESS !== 'false';
    const targetUrl = mode === 'colab' ? this.config.colabUrl : this.config.cloudShellUrl;

    this.log(`[MODE: ${mode.toUpperCase()}] Starting Chromium (${isHeadless ? 'HEADLESS' : 'HEADED'})...`, 'info');
    this.log(`Target URL: ${targetUrl}`, 'info');

    try {
      const isLinux = process.platform === 'linux';
      const launchArgs = isLinux
        ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        : ['--start-maximized'];

      const executablePath = this._detectExecutablePath();
      const launchOpts = {
        headless: isHeadless,
        viewport: { width: 1280, height: 800 },
        args: launchArgs,
      };
      if (executablePath) {
        launchOpts.executablePath = executablePath;
      }

      if (!fs.existsSync(this.userDataDir)) {
        fs.mkdirSync(this.userDataDir, { recursive: true });
      }

      // Clear singleton lock files to avoid session contention
      ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach((f) => {
        const p = path.join(this.userDataDir, f);
        if (fs.existsSync(p)) {
          try {
            fs.rmSync(p, { force: true });
          } catch (_) {}
        }
      });

      // Launch Persistent Context (Preserves Cookies and Local Storage permanently)
      this.context = await chromium.launchPersistentContext(this.userDataDir, launchOpts);

      // Auto-inject saved backup cookies if present
      await this._loadSavedCookiesIntoContext();

      this.page = this.context.pages()[0] || (await this.context.newPage());

      this.page.on('crash', async () => {
        this.log('Page crashed — attempting reload...', 'error');
        this.runtimeState = { state: 'DISCONNECTED', reason: 'page-crash' };
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
          this.runtimeState = { state: 'IDLE', reason: 'context-closed' };
          this.emit('status_change', this.getStatus());
        }
      });

      this.log(`Navigating to ${targetUrl}...`, 'info');
      await this.page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
      }).catch((e) => {
        this.log(`Navigation note: ${e.message}`, 'warn');
      });

      try {
        this.pageTitle = (await this.page.title()) || (mode === 'colab' ? 'Google Colab' : 'Google Cloud Shell');
      } catch (_) {}

      this._startLock = false;

      // Dispatch to mode handler
      if (mode === 'colab') {
        this.runColabLifecycle();
      } else {
        this.runCloudShellLifecycle();
      }

      this.emit('status_change', this.getStatus());
      return { ok: true, mode, url: targetUrl };
    } catch (err) {
      this._startLock = false;
      this.isRunning = false;
      this.isConnected = false;
      this.runtimeState = { state: 'ERROR', reason: err.message };
      this.log(`Failed to start worker: ${err.message}`, 'error');
      await this.cleanup();
      this.emit('status_change', this.getStatus());
      return { ok: false, message: err.message };
    }
  }

  // ============================================================
  //  CLOUD SHELL MODE LIFECYCLE
  //  - Wait 1 minute (60s)
  //  - Run startup command (docker start omniroute)
  //  - ZERO CLICKS while active
  //  - Check every 10 mins
  //  - Auto-reconnect if ended
  // ============================================================
  async runCloudShellLifecycle() {
    const waitSec = this.config.waitAfterLoadSec || 60;
    const checkMin = this.config.checkIntervalMin || 10;
    const cmd = this.config.startupCommand || 'docker start omniroute';

    while (this.isRunning && !this.isStopping) {
      try {
        const state = await this.checkCloudShellState();
        this.runtimeState = state;

        if (state.state === 'LOGIN_REQUIRED') {
          this.isConnected = false;
          this.log('Google login required. Please inject cookies via "Import Cookies".', 'warn');
          this.emit('status_change', this.getStatus());
          await this.sleep(30000);
          continue;
        }

        // STEP 1: Wait 1 Minute (60s) for container initialization
        this.log(`⏳ Waiting 1 minute (${waitSec}s) for Cloud Shell container & terminal to initialize...`, 'info');
        this.runtimeState = { state: 'INITIALIZING_WAIT_1MIN', reason: `Waiting ${waitSec}s after load` };
        this.emit('status_change', this.getStatus());

        await this.sleep(waitSec * 1000);

        if (!this.isRunning || this.isStopping) break;

        await this.handleCloudShellDialogs();

        // STEP 2: Execute command (docker start omniroute)
        this.log(`🚀 Sending startup command: "${cmd}"...`, 'info');
        this.runtimeState = { state: 'SENDING_COMMAND', reason: 'typing-startup-cmd' };
        this.emit('status_change', this.getStatus());

        await this.sendTerminalCommand(cmd);

        this.isConnected = true;
        this.runtimeState = { state: 'CONNECTED', reason: 'passive-monitoring-active' };
        this.log('🔒 Active Cloud Shell session established. ZERO clicks will be performed during session.', 'info');
        this.emit('status_change', this.getStatus());

        // STEP 3: 10-Minute Passive Polling Loop
        const intervalMs = checkMin * 60 * 1000;
        while (this.isRunning && !this.isStopping) {
          this.lastCheckAt = Date.now();
          this.nextCheckAt = Date.now() + intervalMs;
          this.emit('status_change', this.getStatus());

          this.log(`Next status check in ${checkMin} minutes... (Zero clicks during active session)`, 'info');
          await this.sleep(intervalMs);

          if (!this.isRunning || this.isStopping) break;

          this.log(`🔍 [${checkMin}-Min Check] Checking Cloud Shell session status...`, 'info');
          const check = await this.checkCloudShellState();
          this.lastCheckAt = Date.now();

          if (check.state === 'LOGIN_REQUIRED') {
            this.isConnected = false;
            this.runtimeState = check;
            this.log('Google Login required during check.', 'warn');
            this.emit('status_change', this.getStatus());
            break;
          }

          if (check.state === 'DISCONNECTED') {
            this.isConnected = false;
            this.runtimeState = { state: 'DISCONNECTED', reason: check.reason };
            this.log(`🚨 Cloud Shell session ENDED (${check.reason}). Reconnecting...`, 'warn');
            this.emit('status_change', this.getStatus());

            await this.reconnectCloudShell();
            break; // Restart outer loop (wait 1 min -> send command)
          } else {
            this.isConnected = true;
            this.runtimeState = { state: 'CONNECTED', reason: 'session-healthy' };
            this.log('🟢 Cloud Shell session is ACTIVE & healthy. (No clicks performed).', 'info');
            this.emit('status_change', this.getStatus());
          }
        }
      } catch (err) {
        if (!this.isStopping) {
          this.log(`Cloud Shell loop error: ${err.message}`, 'error');
          await this.sleep(10000);
        }
      }
    }
  }

  // ============================================================
  //  COLAB MODE LIFECYCLE
  //  - Dismiss Drive/modal alerts
  //  - Auto-connect via shadow DOM
  //  - Auto Run All (Ctrl+F9)
  //  - Extract RAM/Disk metrics
  //  - Keep-alive click every 60s
  //  - Auto-reconnect on disconnect
  // ============================================================
  async runColabLifecycle() {
    const keepaliveMs = (this.config.colabKeepaliveSec || 60) * 1000;

    while (this.isRunning && !this.isStopping) {
      try {
        const state = await this.checkColabState();
        this.runtimeState = state;

        if (state.state === 'LOGIN_REQUIRED') {
          this.isConnected = false;
          this.log('Google login required for Colab. Please inject cookies via "Import Cookies".', 'warn');
          this.emit('status_change', this.getStatus());
          await this.sleep(30000);
          continue;
        }

        await this.dismissColabDialogs();

        if (state.state === 'CONNECTED') {
          this.isConnected = true;

          // Extract RAM / Disk metrics
          const metrics = await this.extractColabMetrics();
          if (metrics) this.latestResources = metrics;

          // Trigger Run All once per fresh connection
          if (this.config.colabAutoRun !== false && !this._ranForThisConnection) {
            this.log('Colab connected — triggering Run All Cells (Ctrl+F9)...', 'info');
            await this.sleep(4000);
            await this.triggerColabRunAll();
            this._ranForThisConnection = true;
          }

          this.runtimeState = { state: 'CONNECTED', reason: 'colab-runtime-connected' };
          this.emit('status_change', this.getStatus());

          // Keep-alive click to prevent idle timeout
          await this.sleep(keepaliveMs);
          await this.clickColabConnect();

        } else {
          // DISCONNECTED / LOADING
          this.isConnected = false;
          this._ranForThisConnection = false;
          this.log(`Colab is disconnected/loading (${state.reason}) — clicking connect button...`, 'warn');
          this.emit('status_change', this.getStatus());

          await this.clickColabConnect();
          await this.sleep(10000);
        }
      } catch (err) {
        if (!this.isStopping) {
          this.log(`Colab loop error: ${err.message}`, 'error');
          await this.sleep(10000);
        }
      }
    }
  }

  // ── Helper: Cloud Shell State Detection ──
  async checkCloudShellState() {
    if (!this.page || this.page.isClosed()) return { state: 'UNKNOWN', reason: 'no-page' };
    try {
      return await this.page.evaluate(() => {
        const url = window.location.href || '';
        if (url.includes('accounts.google.com') || url.includes('google.com/signin')) {
          return { state: 'LOGIN_REQUIRED', reason: 'google-login-url' };
        }

        const body = document.body ? document.body.innerText.toLowerCase() : '';
        const disconnectTerms = [
          'session terminated',
          'session disconnected',
          'disconnected from server',
          'connection lost',
          'cloud shell is temporarily unavailable',
          'reconnect to your cloud shell',
          'your session was disconnected',
          'session expired',
          'inactive session',
        ];

        for (const t of disconnectTerms) {
          if (body.includes(t)) return { state: 'DISCONNECTED', reason: 'matched: ' + t };
        }

        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a.mat-button'));
        for (const b of buttons) {
          const txt = (b.textContent || '').trim().toLowerCase();
          if (txt === 'reconnect' || txt.includes('reconnect to cloud shell') || txt === 'restart cloud shell' || txt === 'try again') {
            const rect = b.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { state: 'DISCONNECTED', reason: 'reconnect-btn-visible' };
            }
          }
        }

        const hasTerminal = !!document.querySelector('.xterm-screen, textarea.xterm-helper-textarea, iframe');
        if (hasTerminal || body.includes('cloud shell') || body.includes('terminal')) {
          return { state: 'CONNECTED', reason: 'terminal-dom-active' };
        }

        return { state: 'CONNECTED', reason: 'page-active' };
      });
    } catch (e) {
      return { state: 'UNKNOWN', reason: e.message };
    }
  }

  // ── Helper: Colab State Detection ──
  async checkColabState() {
    if (!this.page || this.page.isClosed()) return { state: 'UNKNOWN', reason: 'no-page' };
    try {
      return await this.page.evaluate(() => {
        const url = window.location.href || '';
        if (url.includes('accounts.google.com') || url.includes('google.com/signin')) {
          return { state: 'LOGIN_REQUIRED', reason: 'google-login-url' };
        }

        if (document.querySelector('colab-reconnect-button')) {
          return { state: 'DISCONNECTED', reason: 'reconnect-button-present' };
        }

        const btn = document.querySelector('#top-toolbar colab-connect-button, colab-connect-button');
        if (btn) {
          if (btn.hasAttribute('connected') || btn.getAttribute('connected') === 'true' || btn.classList.contains('connected')) {
            return { state: 'CONNECTED', reason: 'connected-attribute' };
          }
          const shadowTxt = ((btn.shadowRoot && btn.shadowRoot.textContent) || '').toLowerCase();
          if (shadowTxt.includes('ram') || shadowTxt.includes('disk') || shadowTxt.includes('connected')) {
            return { state: 'CONNECTED', reason: 'resource-metrics-visible' };
          }
          if (shadowTxt.includes('connect')) {
            return { state: 'LOADING', reason: 'connect-button-idle' };
          }
        }

        const bodyTxt = document.body ? document.body.innerText : '';
        if (/google compute engine/i.test(bodyTxt) && /\bRAM\b/i.test(bodyTxt)) {
          return { state: 'CONNECTED', reason: 'compute-engine-ram-visible' };
        }

        return { state: 'DISCONNECTED', reason: 'no-connection-signals' };
      });
    } catch (e) {
      return { state: 'UNKNOWN', reason: e.message };
    }
  }

  // ── Colab Connect Button Click (Shadow DOM Pierce) ──
  async clickColabConnect() {
    if (!this.page || this.page.isClosed()) return false;
    try {
      const host = this.page.locator('#top-toolbar colab-connect-button, colab-connect-button').first();
      if ((await host.count()) > 0) {
        const inner = host.locator('mwc-button, button').filter({ hasText: /connect|reconnect/i }).first();
        if ((await inner.count()) > 0) {
          await inner.click({ timeout: 4000 });
          this.log('Colab connect clicked (inner shadow)', 'info');
          return true;
        }
        await host.click({ timeout: 4000 });
        return true;
      }
    } catch (_) {}

    return await this.page.evaluate(() => {
      const hosts = document.querySelectorAll('#top-toolbar colab-connect-button, colab-connect-button, colab-reconnect-button');
      for (const h of hosts) {
        const root = h.shadowRoot || h;
        const btns = root.querySelectorAll('mwc-button, button, [role="button"]');
        for (const b of btns) {
          if (/connect|reconnect/i.test(b.textContent || '')) {
            b.click();
            return true;
          }
        }
      }
      return false;
    }).catch(() => false);
  }

  // ── Colab Dialogs & Drive Authorization Dismiss ──
  async dismissColabDialogs() {
    if (!this.page || this.page.isClosed()) return;
    try {
      const drive = this.page.getByText('Connect to Google Drive', { exact: false });
      if ((await drive.count()) > 0) {
        await drive.first().click({ timeout: 3000 });
        this.log('Drive Authorization: Clicked Connect to Google Drive', 'info');
        await this.sleep(1500);
        return;
      }
      const noThanks = this.page.getByText('No thanks', { exact: false });
      if ((await noThanks.count()) > 0) {
        await noThanks.first().click({ timeout: 3000 });
        await this.sleep(1000);
      }
    } catch (_) {}
  }

  async triggerColabRunAll() {
    if (!this.page || this.page.isClosed()) return;
    const runKey = process.platform === 'darwin' ? 'Meta+F9' : 'Control+F9';
    this.log(`Sending keyboard shortcut: ${runKey} (Run All Cells)`, 'info');
    try {
      await this.page.keyboard.press(runKey);
    } catch (e) {
      this.log(`Run All shortcut error: ${e.message}`, 'error');
    }
  }

  async extractColabMetrics() {
    if (!this.page || this.page.isClosed()) return null;
    return await this.page.evaluate(() => {
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

  // ── Cloud Shell Dialogs & Reconnection ──
  async handleCloudShellDialogs() {
    if (!this.page || this.page.isClosed()) return;
    try {
      const dialogBtns = this.page.locator('button, [role="button"]').filter({
        hasText: /authorize|start cloud shell|open terminal|continue|agree|got it/i,
      });
      if ((await dialogBtns.count()) > 0) {
        await dialogBtns.first().click({ timeout: 4000 });
        this.log('Clicked Cloud Shell startup/dialog button', 'info');
        await this.sleep(2000);
      }
    } catch (_) {}
  }

  async reconnectCloudShell() {
    if (!this.page || this.page.isClosed()) return false;
    this.log('Attempting Cloud Shell reconnection...', 'info');
    try {
      const reconnectBtns = this.page.locator('button, [role="button"]').filter({
        hasText: /reconnect|restart|start cloud shell|try again/i,
      });
      if ((await reconnectBtns.count()) > 0) {
        await reconnectBtns.first().click({ timeout: 5000 });
        this.log('Clicked Reconnect button', 'info');
        await this.sleep(3000);
        return true;
      }
      const targetUrl = this.config.cloudShellUrl || 'https://shell.cloud.google.com/?show=terminal';
      await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      return true;
    } catch (e) {
      this.log(`Reconnect failed: ${e.message}`, 'warn');
      return false;
    }
  }

  // ── Terminal Remote Command Sender ──
  async sendTerminalCommand(cmd) {
    if (!this.page || this.page.isClosed()) {
      return { ok: false, message: 'No active browser page' };
    }

    const commandToRun = cmd || this.config.startupCommand || 'docker start omniroute';
    this.log(`Executing in terminal: "${commandToRun}"`, 'info');

    try {
      const textarea = this.page.locator('textarea.xterm-helper-textarea, .xterm-helper-textarea, textarea').first();
      if ((await textarea.count()) > 0) {
        await textarea.focus({ timeout: 4000 }).catch(() => {});
        await textarea.click({ timeout: 4000 }).catch(() => {});
      } else {
        const termScreen = this.page.locator('.xterm-screen, .xterm, [aria-label*="terminal" i]').first();
        if ((await termScreen.count()) > 0) {
          await termScreen.click({ timeout: 4000 }).catch(() => {});
        }
      }

      const frames = this.page.frames();
      for (const frame of frames) {
        try {
          const frameTextarea = frame.locator('textarea.xterm-helper-textarea, textarea, .xterm-screen').first();
          if ((await frameTextarea.count()) > 0) {
            await frameTextarea.focus({ timeout: 2000 }).catch(() => {});
            await frameTextarea.click({ timeout: 2000 }).catch(() => {});
            break;
          }
        } catch (_) {}
      }

      await this.sleep(400);
      await this.page.keyboard.type(commandToRun, { delay: 40 });
      await this.sleep(200);
      await this.page.keyboard.press('Enter');
      await this.sleep(400);

      this.lastCommandExecuted = commandToRun;
      this.lastCommandTime = Date.now();
      this.log(`✅ Command "${commandToRun}" sent successfully!`, 'info');
      return { ok: true, command: commandToRun };
    } catch (err) {
      this.log(`❌ Command error: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  }

  // ── Force Reconnect ──
  async forceReconnect() {
    if (this._reconnectLock) return { ok: false, message: 'Reconnect in progress' };
    this._reconnectLock = true;
    const mode = this.config.mode || 'cloudshell';
    this.log(`Manual reconnect triggered for [${mode.toUpperCase()}]`, 'info');

    try {
      if (mode === 'colab') {
        const ok = await this.clickColabConnect();
        this._ranForThisConnection = false;
        return { ok, message: ok ? 'Colab connect clicked' : 'Connect button not found' };
      } else {
        const ok = await this.reconnectCloudShell();
        if (ok) {
          const waitSec = this.config.waitAfterLoadSec || 60;
          this.log(`Waiting ${waitSec}s after reconnect before typing command...`, 'info');
          await this.sleep(waitSec * 1000);
          await this.sendTerminalCommand(this.config.startupCommand || 'docker start omniroute');
        }
        return { ok, message: ok ? 'Cloud Shell reconnected & command sent' : 'Reconnect failed' };
      }
    } finally {
      this._reconnectLock = false;
    }
  }

  // ── Persistent Cookie Injection & Disk Backup ──
  async _loadSavedCookiesIntoContext() {
    if (!this.context) return;
    try {
      // Try environment variable first (for Vercel serverless)
      let cookies = null;
      if (process.env.GOOGLE_COOKIES) {
        try {
          cookies = JSON.parse(process.env.GOOGLE_COOKIES);
          this.log(`Loaded ${cookies.length} cookies from environment variable.`, 'info');
        } catch (_) {}
      }

      // Fallback to disk file
      if (!cookies && fs.existsSync(this.savedCookiesPath)) {
        cookies = JSON.parse(fs.readFileSync(this.savedCookiesPath, 'utf8'));
        this.log(`Loaded ${cookies.length} cookies from disk backup.`, 'info');
      }

      if (Array.isArray(cookies) && cookies.length > 0) {
        await this.context.addCookies(cookies);
        // Auto-refresh saved cookies periodically
        this._startCookieAutoBackup();
      }
    } catch (e) {
      this.log(`Note loading saved cookies: ${e.message}`, 'warn');
    }
  }

  async _startCookieAutoBackup() {
    // Backup cookies every 5 minutes to survive session changes
    if (this._cookieBackupInterval) return;
    this._cookieBackupInterval = setInterval(async () => {
      try {
        if (this.context) {
          const cookies = await this.context.cookies();
          const googleCookies = cookies.filter(c =>
            c.domain.includes('google.com') ||
            c.domain.includes('googleapis.com') ||
            c.domain.includes('gstatic.com')
          );
          if (googleCookies.length > 0) {
            fs.writeFileSync(this.savedCookiesPath, JSON.stringify(googleCookies, null, 2), 'utf8');
            this.log(`Auto-backed up ${googleCookies.length} Google cookies`, 'debug');
          }
        }
      } catch (e) {
        this.log(`Cookie auto-backup error: ${e.message}`, 'warn');
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  async importCookies(input) {
    let raw = input;
    if (!Array.isArray(raw) && raw && Array.isArray(raw.cookies)) raw = raw.cookies;
    if (!Array.isArray(raw)) {
      return { ok: false, error: 'Expected array of cookie objects from Cookie-Editor' };
    }

    const mapSameSite = (v) => {
      const s = (v || '').toLowerCase();
      if (s === 'no_restriction') return 'None';
      if (s === 'strict') return 'Strict';
      return 'Lax';
    };

    const pwCookies = raw
      .filter((c) => c && c.name && c.value !== undefined)
      .map((c) => {
        const cookie = {
          name: c.name,
          value: c.value,
          domain:
            c.domain && c.domain.startsWith('.')
              ? c.domain
              : c.domain
              ? '.' + c.domain.replace(/^\.+/, '')
              : '.google.com',
          path: c.path || '/',
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
        };
        if (c.expirationDate && c.expirationDate > 0) cookie.expires = Math.floor(c.expirationDate);
        cookie.sameSite = mapSameSite(c.sameSite);
        return cookie;
      });

    if (!pwCookies.length) {
      return { ok: false, error: 'No valid cookies found in payload' };
    }

    // 1. Save cookies to disk backup so it survives stops, restarts, and reboots permanently
    try {
      fs.writeFileSync(this.savedCookiesPath, JSON.stringify(pwCookies, null, 2), 'utf8');
      this.log(`Persisted ${pwCookies.length} cookies to cookies_saved.json`, 'info');
    } catch (e) {
      this.log(`Warning writing cookies backup: ${e.message}`, 'warn');
    }

    // 2. Inject into active browser context if running
    if (this.context) {
      try {
        await this.context.addCookies(pwCookies);
        this.log(`Injected ${pwCookies.length} cookies into running session.`, 'info');
        const mode = this.config.mode || 'cloudshell';
        const target = mode === 'colab' ? this.config.colabUrl : this.config.cloudShellUrl;
        await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await this.sleep(4000);
        const valid = !(this.page.url() || '').includes('accounts.google.com');
        return { ok: true, count: pwCookies.length, appliedTo: 'running-session', valid };
      } catch (e) {
        this.log(`addCookies failed: ${e.message}`, 'warn');
      }
    }

    // 3. If running in Serverless (Vercel / Lambda) environment, return immediately
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      return { ok: true, count: pwCookies.length, appliedTo: 'disk-backup' };
    }

    // 4. If browser is not running on VPS, save into persistent profile folder directly
    try {
      const isLinux = process.platform === 'linux';
      const execPath = this._detectExecutablePath();
      const launchOpts = {
        headless: true,
        viewport: { width: 1280, height: 800 },
        args: isLinux
          ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
          : ['--start-maximized'],
      };
      if (execPath) launchOpts.executablePath = execPath;

      const tmp = await chromium.launchPersistentContext(this.userDataDir, launchOpts);
      try {
        await tmp.addCookies(pwCookies);
        const page = tmp.pages()[0] || (await tmp.newPage());
        await page.goto('https://colab.research.google.com/', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
        await this.sleep(3000);
        const valid = !page.url().includes('accounts.google.com');
        this.log(`Saved cookies to profile: ${valid ? 'VALID ✓' : 'SAVED'} (${pwCookies.length} cookies)`, 'info');
        return { ok: true, count: pwCookies.length, appliedTo: 'profile-dir', valid };
      } finally {
        await tmp.close().catch(() => {});
      }
    } catch (e) {
      this.log(`Profile cookie setup error: ${e.message}`, 'error');
      return { ok: true, count: pwCookies.length, note: 'Saved to disk backup' };
    }
  }

  async takeScreenshot() {
    if (!this.page || this.page.isClosed()) return null;
    try {
      const buffer = await this.page.screenshot({ type: 'png' });
      this.latestScreenshot = buffer;
      return buffer;
    } catch (e) {
      return null;
    }
  }

  async stop() {
    if (!this.isRunning) return { ok: true };
    this.log('Stopping worker (profile and cookies remain safely preserved)...', 'info');
    this.isStopping = true;
    this.isRunning = false;
    this.isConnected = false;
    this.runtimeState = { state: 'STOPPED', reason: 'manual-stop' };
    await this.cleanup();
    this.log('Worker stopped cleanly', 'info');
    this.emit('status_change', this.getStatus());
    return { ok: true };
  }

  async cleanup() {
    try {
      // Clear cookie auto-backup interval
      if (this._cookieBackupInterval) {
        clearInterval(this._cookieBackupInterval);
        this._cookieBackupInterval = null;
      }
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
    const duration = this.sessionStartAt && this.isRunning ? Math.floor((now - this.sessionStartAt) / 1000) : 0;
    const mode = this.config.mode || 'cloudshell';
    const activeUrl = mode === 'colab' ? this.config.colabUrl : this.config.cloudShellUrl;
    const cookiesSaved = fs.existsSync(this.savedCookiesPath);

    return {
      mode,
      activeUrl,
      cloudShellUrl: this.config.cloudShellUrl,
      colabUrl: this.config.colabUrl,
      startupCommand: this.config.startupCommand || 'docker start omniroute',
      waitAfterLoadSec: this.config.waitAfterLoadSec || 60,
      checkIntervalMin: this.config.checkIntervalMin || 10,
      colabKeepaliveSec: this.config.colabKeepaliveSec || 60,
      colabAutoRun: this.config.colabAutoRun !== false,
      isRunning: this.isRunning,
      isConnected: this.isConnected,
      runtimeState: this.runtimeState,
      pageTitle: this.pageTitle,
      headless: this.config.headless !== false,
      sessionStartAt: this.sessionStartAt,
      sessionDurationSec: duration,
      lastCheckAt: this.lastCheckAt,
      nextCheckAt: this.nextCheckAt,
      lastCommandExecuted: this.lastCommandExecuted,
      lastCommandTime: this.lastCommandTime,
      resources: this.latestResources,
      cookiesSaved,
      lastError: this.lastError,
      vpsUptimeSec: Math.floor(process.uptime()),
    };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = UnifiedGoogleWorker;
