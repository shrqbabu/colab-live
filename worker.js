// ============================================================
//  🚀 UNIFIED GOOGLE WORKER — Colab & Cloud Shell Automation
//  Architecture: Persistent Chromium Profile as Primary Source
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

  _cleanStaleLocks() {
    if (!fs.existsSync(this.userDataDir)) return;
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const f of lockFiles) {
      const p = path.join(this.userDataDir, f);
      try {
        if (fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) {
          if (f === 'SingletonLock') {
            try {
              const target = fs.readlinkSync(p);
              const parts = target.split('-');
              const pid = parseInt(parts[parts.length - 1], 10);
              if (pid && !isNaN(pid)) {
                try {
                  process.kill(pid, 0);
                  // Process is alive, do not remove
                  continue;
                } catch (_) {
                  // Process is dead
                }
              }
            } catch (_) {}
          }
          fs.unlinkSync(p);
        }
      } catch (_) {}
    }
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

    this.log(`[MODE: ${mode.toUpperCase()}] Launching persistent Chromium profile (${isHeadless ? 'HEADLESS' : 'HEADED'})...`, 'info');
    this.log(`Target URL: ${targetUrl}`, 'info');

    try {
      const isLinux = process.platform === 'linux';
      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-infobars',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1400,900',
        '--lang=en-US,en',
      ];
      if (!isLinux) {
        launchArgs.push('--start-maximized');
      }

      const executablePath = this._detectExecutablePath();
      const standardUserAgent = isLinux
        ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

      const launchOpts = {
        headless: isHeadless,
        viewport: { width: 1400, height: 900 },
        args: launchArgs,
        ignoreDefaultArgs: ['--enable-automation'],
        userAgent: standardUserAgent,
      };
      if (executablePath) {
        launchOpts.executablePath = executablePath;
      }

      if (!fs.existsSync(this.userDataDir)) {
        fs.mkdirSync(this.userDataDir, { recursive: true });
      }

      // Safely clean dead singleton locks if previous process crashed
      this._cleanStaleLocks();

      // Launch Persistent Context (Preserves Cookies, Storage, and Session State naturally)
      this.context = await chromium.launchPersistentContext(this.userDataDir, launchOpts);

      // Auto-load saved cookies backup into context if available
      await this._loadSavedCookiesIntoContext();

      this.page = this.context.pages()[0] || (await this.context.newPage());

      this.page.on('crash', async () => {
        this.log('Page crashed — attempting recovery...', 'error');
        this.runtimeState = { state: 'DISCONNECTED', reason: 'page-crash' };
        if (this.page && !this.page.isClosed()) {
          await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }
      });

      this.page.on('pageerror', (err) => {
        if (!err.message.includes('ResizeObserver') && !err.message.includes('Extension')) {
          this.log(`Browser page error: ${err.message.substring(0, 100)}`, 'warn');
        }
      });

      this.context.on('close', () => {
        if (!this.isStopping) {
          this.log('Browser context closed', 'warn');
          this.isRunning = false;
          this.isConnected = false;
          this.runtimeState = { state: 'IDLE', reason: 'context-closed' };
          this.emit('status_change', this.getStatus());
        }
      });

      // Prime Google session via accounts.google.com first
      try {
        await this.page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await this.sleep(1500);
      } catch (_) {}

      this.log(`Navigating to ${targetUrl}...`, 'info');
      await this.page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
      }).catch((e) => {
        this.log(`Navigation note: ${e.message}`, 'warn');
      });

      await this.sleep(3000);
      if (mode === 'cloudshell') {
        await this.handleCloudShellDialogs();
      } else {
        await this.dismissColabDialogs();
      }

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
  //  CLOUD SHELL / WORKSPACE MODE LIFECYCLE
  //  - Wait after load (default 60s) for container & terminal initialization
  //  - Execute startup command (e.g. docker start omniroute)
  //  - Check every 10 mins (checkIntervalMin)
  //  - If workspace is visible and active, auto-run the command
  //  - If session ended/disconnected, auto-reconnect and re-initialize
  // ============================================================
  async runCloudShellLifecycle() {
    const waitSec = this.config.waitAfterLoadSec || 60;
    const checkMin = this.config.checkIntervalMin || 10;
    const cmd = this.config.startupCommand || 'docker start omniroute';

    while (this.isRunning && !this.isStopping) {
      try {
        const state = await this.checkCloudShellState();
        this.runtimeState = state;

        if (state.state === 'LOGIN_REQUIRED' || state.state === 'COOKIE_ERROR') {
          this.isConnected = false;
          this.log(`Authentication required (${state.state}: ${state.reason}).`, 'warn');
          this.emit('status_change', this.getStatus());
          await this.sleep(30000);
          continue;
        }

        // STEP 1: Wait for container & terminal/workspace to initialize
        this.log(`⏳ Waiting ${waitSec}s for workspace/terminal initialization...`, 'info');
        this.runtimeState = { state: 'INITIALIZING_WAIT', reason: `Waiting ${waitSec}s after load` };
        this.emit('status_change', this.getStatus());

        await this.sleep(waitSec * 1000);

        if (!this.isRunning || this.isStopping) break;

        await this.handleCloudShellDialogs();

        const preCheck = await this.checkCloudShellState();
        if (preCheck.state === 'LOGIN_REQUIRED' || preCheck.state === 'COOKIE_ERROR') {
          this.isConnected = false;
          this.runtimeState = preCheck;
          this.log(`Authentication required (${preCheck.state}: ${preCheck.reason}).`, 'warn');
          this.emit('status_change', this.getStatus());
          await this.sleep(20000);
          continue;
        }

        // STEP 2: Execute startup command on initial load
        this.log(`🚀 Initial run: Sending command: "${cmd}"...`, 'info');
        this.runtimeState = { state: 'SENDING_COMMAND', reason: 'typing-startup-cmd' };
        this.emit('status_change', this.getStatus());

        const cmdRes = await this.sendTerminalCommand(cmd);
        if (cmdRes && cmdRes.ok) {
          this.isConnected = true;
          this.runtimeState = { state: 'CONNECTED', reason: 'workspace-active' };
          this.log('🟢 Active workspace session established and startup command sent.', 'info');
        } else {
          this.isConnected = false;
          this.runtimeState = { state: 'TERMINAL_WAITING', reason: cmdRes ? cmdRes.error || cmdRes.message : 'no-terminal' };
          this.log('Terminal not ready yet. Will auto-run on next status check.', 'warn');
        }
        this.emit('status_change', this.getStatus());

        // STEP 3: 10-Minute Polling & Auto-Execution Loop
        const intervalMs = checkMin * 60 * 1000;
        while (this.isRunning && !this.isStopping) {
          this.lastCheckAt = Date.now();
          this.nextCheckAt = Date.now() + intervalMs;
          this.emit('status_change', this.getStatus());

          this.log(`Next status check in ${checkMin} minutes...`, 'info');
          await this.sleep(intervalMs);

          if (!this.isRunning || this.isStopping) break;

          this.log(`🔍 [${checkMin}-Min Check] Checking workspace session status...`, 'info');
          await this.handleCloudShellDialogs();
          const check = await this.checkCloudShellState();
          this.lastCheckAt = Date.now();

          if (check.state === 'LOGIN_REQUIRED' || check.state === 'COOKIE_ERROR') {
            this.isConnected = false;
            this.runtimeState = check;
            this.log(`Authentication required during check (${check.state}).`, 'warn');
            this.emit('status_change', this.getStatus());
            break;
          }

          if (check.state === 'DISCONNECTED') {
            this.isConnected = false;
            this.runtimeState = { state: 'DISCONNECTED', reason: check.reason };
            this.log(`🚨 Session ENDED (${check.reason}). Reconnecting...`, 'warn');
            this.emit('status_change', this.getStatus());

            await this.reconnectCloudShell();
            break; // Restart outer loop
          } else if (check.state === 'CONNECTED') {
            this.isConnected = true;
            this.runtimeState = { state: 'CONNECTED', reason: 'workspace-active' };
            this.log(`🟢 Workspace is ACTIVE & visible! Auto-running command: "${cmd}"...`, 'info');
            this.emit('status_change', this.getStatus());

            // Auto-run command whenever workspace is visible and active
            await this.sendTerminalCommand(cmd);
          }
        }
      } catch (err) {
        if (!this.isStopping) {
          this.log(`Workspace loop error: ${err.message}`, 'error');
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
          this.log('Google login required for Colab. Please authenticate profile or import cookies.', 'warn');
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

  // ── Helper: Cloud Shell / Replit / Workspace State Detection ──
  async checkCloudShellState() {
    if (!this.page || this.page.isClosed()) return { state: 'UNKNOWN', reason: 'no-page' };
    try {
      return await this.page.evaluate(() => {
        const url = window.location.href || '';
        const body = document.body ? document.body.innerText.toLowerCase() : '';

        // 1. Google / Platform Cookie Error / Privacy Settings Block
        if (
          url.includes('support.google.com') ||
          url.includes('CookieMismatch') ||
          url.includes('answer.py?hl=') ||
          url.includes('nocookies') ||
          body.includes('problem with your cookie settings') ||
          body.includes("we've detected a problem with your cookie settings") ||
          body.includes('adjust your privacy settings') ||
          body.includes('enable cookies')
        ) {
          return { state: 'COOKIE_ERROR', reason: 'cookie-settings-rejected' };
        }

        // 2. Login / Sign-in required
        if (
          url.includes('accounts.google.com/signin') ||
          url.includes('accounts.google.com/ServiceLogin') ||
          url.includes('accounts.google.com/InteractiveLogin') ||
          url.includes('accounts.google.com/AccountChooser') ||
          url.includes('accounts.google.com/v3/signin') ||
          url.includes('replit.com/login') ||
          body.includes('sign in with your google account') ||
          body.includes('choose an account') ||
          body.includes('sign in to continue') ||
          body.includes('log in to replit')
        ) {
          return { state: 'LOGIN_REQUIRED', reason: 'login-url' };
        }

        // 3. Disconnected / Session ended / Sleeping
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
          'repl is sleeping',
          'repl offline',
          'waking up your repl',
        ];

        for (const t of disconnectTerms) {
          if (body.includes(t)) return { state: 'DISCONNECTED', reason: 'matched: ' + t };
        }

        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a.mat-button, .mat-raised-button'));
        for (const b of buttons) {
          const txt = (b.textContent || '').trim().toLowerCase();
          if (
            txt === 'reconnect' ||
            txt.includes('reconnect to cloud shell') ||
            txt === 'restart cloud shell' ||
            txt === 'start cloud shell' ||
            txt === 'try again' ||
            txt === 'retry' ||
            txt === 'wake up repl' ||
            txt === 'wake up'
          ) {
            const rect = b.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { state: 'DISCONNECTED', reason: 'reconnect-btn-visible' };
            }
          }
        }

        // 4. Authenticated & Terminal / Workspace Ready
        const hasTerminal = !!document.querySelector(
          '.xterm-screen, textarea.xterm-helper-textarea, .terminal textarea, canvas.xterm-text-layer, [role="terminal"], div[class*="terminal"]'
        );
        if (hasTerminal) {
          return { state: 'CONNECTED', reason: 'terminal-dom-active' };
        }

        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const f of iframes) {
          try {
            const doc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
            if (doc && doc.querySelector('.xterm-screen, textarea.xterm-helper-textarea, .terminal textarea, canvas.xterm-text-layer')) {
              return { state: 'CONNECTED', reason: 'iframe-terminal-active' };
            }
          } catch (_) {}
        }

        // Replit / Cloud Shell workspace indicators
        const hasWorkspace = !!document.querySelector(
          '[data-cy="workspace"], .workspace, [aria-label*="workspace" i], .monaco-workbench, .theia-ApplicationShell, button[data-cy="run-button"]'
        );
        if (hasWorkspace) {
          return { state: 'CONNECTED', reason: 'workspace-dom-active' };
        }

        // 5. Initializing / Loading
        if (url.includes('shell.cloud.google.com') || url.includes('console.cloud.google.com') || url.includes('replit.com')) {
          return { state: 'LOADING', reason: 'page-initializing' };
        }

        return { state: 'LOADING', reason: 'waiting-for-terminal' };
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

  // ── Workspace / Cloud Shell Dialogs & Reconnection ──
  async handleCloudShellDialogs() {
    if (!this.page || this.page.isClosed()) return;
    try {
      // Cookie consent / region banner
      const consentBtns = this.page.locator('button, [role="button"], a').filter({
        hasText: /accept all|i agree|agree|got it|allow all|consent/i,
      });
      if ((await consentBtns.count()) > 0) {
        await consentBtns.first().click({ timeout: 3000 }).catch(() => {});
        this.log('Dismissed cookie / consent dialog', 'info');
        await this.sleep(1000);
      }

      const dialogBtns = this.page.locator('button, [role="button"], a.mat-button, .mat-button, .mat-raised-button').filter({
        hasText: /authorize|start cloud shell|open terminal|continue|agree|got it|start|wake up/i,
      });
      if ((await dialogBtns.count()) > 0) {
        await dialogBtns.first().click({ timeout: 4000 }).catch(() => {});
        this.log('Clicked startup/authorize dialog button', 'info');
        await this.sleep(2000);
      }
    } catch (_) {}
  }

  async reconnectCloudShell() {
    if (!this.page || this.page.isClosed()) return false;
    this.log('Attempting reconnection...', 'info');
    try {
      const reconnectBtns = this.page.locator('button, [role="button"]').filter({
        hasText: /reconnect|restart|start cloud shell|try again|wake up repl|wake up/i,
      });
      if ((await reconnectBtns.count()) > 0) {
        await reconnectBtns.first().click({ timeout: 5000 });
        this.log('Clicked Reconnect / Wake up button', 'info');
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

  // ── Terminal / Workspace Remote Command Sender ──
  async sendTerminalCommand(cmd) {
    if (!this.page || this.page.isClosed()) {
      return { ok: false, message: 'No active browser page' };
    }

    const commandToRun = cmd || this.config.startupCommand || 'docker start omniroute';
    if (commandToRun.trim().toLowerCase() === 'ctrl+c' || commandToRun.trim().toLowerCase() === '^c') {
      return await this.pressKey('Control+c');
    }
    if (commandToRun.trim().toLowerCase() === 'ctrl+d' || commandToRun.trim().toLowerCase() === '^d') {
      return await this.pressKey('Control+d');
    }
    this.log(`Executing in terminal: "${commandToRun}"`, 'info');

    try {
      let focused = false;

      // 1. If in Replit, check for Console or Shell tab and activate it if needed
      try {
        const consoleTabs = this.page.locator('button, [role="tab"], div').filter({ hasText: /^(Console|Shell)$/i });
        if ((await consoleTabs.count()) > 0) {
          const tab = consoleTabs.first();
          if (await tab.isVisible().catch(() => false)) {
            await tab.click({ timeout: 2000 }).catch(() => {});
            await this.sleep(300);
          }
        }
      } catch (_) {}

      // 2. If command is 'run' or repl needs run trigger, check for Replit Run button
      if (commandToRun.trim().toLowerCase() === 'run') {
        try {
          const runBtn = this.page.locator('button[data-cy="run-button"], button[aria-label="Run"], button').filter({ hasText: /^Run$/i }).first();
          if ((await runBtn.count()) > 0 && (await runBtn.isVisible().catch(() => false))) {
            await runBtn.click({ timeout: 3000 }).catch(() => {});
            this.lastCommandExecuted = 'Run';
            this.lastCommandTime = Date.now();
            this.log('✅ Clicked Replit Run button successfully!', 'info');
            return { ok: true, command: 'Run' };
          }
        } catch (_) {}
      }

      // 3. Focus interactive terminal element
      const textarea = this.page.locator(
        'textarea.xterm-helper-textarea, .xterm-helper-textarea, .terminal textarea, [role="terminal"] textarea, div[class*="terminal"] textarea, div[data-testid*="terminal"] textarea'
      ).first();
      if ((await textarea.count()) > 0) {
        await textarea.focus({ timeout: 4000 }).catch(() => {});
        await textarea.click({ timeout: 4000 }).catch(() => {});
        focused = true;
      } else {
        const termScreen = this.page.locator(
          '.xterm-screen, .xterm, [aria-label*="terminal" i], [role="terminal"], div[class*="terminal"], .theia-terminal, canvas.xterm-text-layer'
        ).first();
        if ((await termScreen.count()) > 0) {
          await termScreen.click({ timeout: 4000 }).catch(() => {});
          focused = true;
        }
      }

      // 4. Check inside any frames/iframes
      const frames = this.page.frames();
      for (const frame of frames) {
        try {
          const frameTextarea = frame.locator('textarea.xterm-helper-textarea, textarea, .xterm-screen, [role="terminal"]').first();
          if ((await frameTextarea.count()) > 0) {
            await frameTextarea.focus({ timeout: 2000 }).catch(() => {});
            await frameTextarea.click({ timeout: 2000 }).catch(() => {});
            focused = true;
            break;
          }
        } catch (_) {}
      }

      if (!focused) {
        // Fallback: Check if Replit Run button is present
        try {
          const runBtn = this.page.locator('button[data-cy="run-button"], button[aria-label="Run"], button').filter({ hasText: /^Run$/i }).first();
          if ((await runBtn.count()) > 0 && (await runBtn.isVisible().catch(() => false))) {
            await runBtn.click({ timeout: 3000 }).catch(() => {});
            this.lastCommandExecuted = 'Run';
            this.lastCommandTime = Date.now();
            this.log('✅ Clicked Replit Run button (fallback)!', 'info');
            return { ok: true, command: 'Run' };
          }
        } catch (_) {}

        this.log('⚠️ No interactive terminal element found on screen yet.', 'warn');
        return { ok: false, error: 'Terminal element not found' };
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

  // ── Browser Interactive Controls (Remote Viewport & Control) ──
  async navigate(url) {
    const target = (url || '').trim();
    if (!target) return { ok: false, message: 'Valid URL is required' };

    if (!this.isRunning || !this.page || this.page.isClosed()) {
      this.config.cloudShellUrl = target;
      if (this.config.mode === 'colab') this.config.colabUrl = target;
      this.saveConfig(this.config);
      this.log(`Browser not running — launching persistent browser to: ${target}`, 'info');
      const startRes = await this.start();
      if (!startRes.ok) return startRes;
      return { ok: true, url: target, title: this.pageTitle, started: true };
    }

    this.log(`Interactive navigation to: ${target}`, 'info');
    try {
      await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.sleep(2000);
      if (this.config.mode === 'cloudshell') {
        await this.handleCloudShellDialogs();
      } else {
        await this.dismissColabDialogs();
      }
      try {
        this.pageTitle = (await this.page.title()) || this.pageTitle;
      } catch (_) {}
      this.emit('status_change', this.getStatus());
      return { ok: true, url: this.page.url(), title: this.pageTitle };
    } catch (e) {
      this.log(`Navigation error: ${e.message}`, 'error');
      return { ok: false, error: e.message };
    }
  }

  async clickCoordinate(x, y, clientWidth, clientHeight) {
    if (!this.page || this.page.isClosed()) {
      return { ok: false, message: 'Browser session is not active. Click Start Session first.' };
    }
    try {
      let realX = Number(x);
      let realY = Number(y);
      if (clientWidth && clientHeight && clientWidth > 0 && clientHeight > 0) {
        const scaleX = 1400 / Number(clientWidth);
        const scaleY = 900 / Number(clientHeight);
        realX = Math.round(realX * scaleX);
        realY = Math.round(realY * scaleY);
      }
      realX = Math.max(0, Math.min(1400, realX));
      realY = Math.max(0, Math.min(900, realY));
      this.log(`Viewport click at (${realX}, ${realY})`, 'info');
      await this.page.mouse.click(realX, realY);
      await this.sleep(300);
      return { ok: true, x: realX, y: realY };
    } catch (e) {
      this.log(`Click error: ${e.message}`, 'error');
      return { ok: false, error: e.message };
    }
  }

  async typeText(text) {
    if (!this.page || this.page.isClosed()) {
      return { ok: false, message: 'Browser session is not active. Click Start Session first.' };
    }
    try {
      const str = String(text || '');
      this.log(`Typing ${str.length} characters into active browser element...`, 'info');
      await this.page.keyboard.type(str, { delay: 35 });
      await this.sleep(300);
      return { ok: true, length: str.length };
    } catch (e) {
      this.log(`Type error: ${e.message}`, 'error');
      return { ok: false, error: e.message };
    }
  }

  async pressKey(key) {
    if (!this.page || this.page.isClosed()) {
      return { ok: false, message: 'Browser session is not active. Click Start Session first.' };
    }
    try {
      const validKey = String(key || 'Enter').trim();
      this.log(`Keyboard key press: ${validKey}`, 'info');
      const lower = validKey.toLowerCase();
      if (lower === 'ctrl+c' || lower === 'control+c') {
        await this.page.keyboard.press('Control+c');
      } else if (lower === 'ctrl+v' || lower === 'control+v') {
        await this.page.keyboard.press('Control+v');
      } else if (lower === 'ctrl+d' || lower === 'control+d') {
        await this.page.keyboard.press('Control+d');
      } else if (lower.startsWith('ctrl+')) {
        await this.page.keyboard.press('Control+' + validKey.slice(5));
      } else {
        await this.page.keyboard.press(validKey);
      }
      await this.sleep(300);
      return { ok: true, key: validKey };
    } catch (e) {
      this.log(`Key press error: ${e.message}`, 'error');
      return { ok: false, error: e.message };
    }
  }

  async goBack() {
    if (!this.page || this.page.isClosed()) return { ok: false, message: 'Browser session is not active' };
    try {
      await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.sleep(1000);
      return { ok: true, url: this.page.url() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async goForward() {
    if (!this.page || this.page.isClosed()) return { ok: false, message: 'Browser session is not active' };
    try {
      await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.sleep(1000);
      return { ok: true, url: this.page.url() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async reloadPage() {
    if (!this.page || this.page.isClosed()) return { ok: false, message: 'Browser session is not active' };
    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.sleep(1500);
      return { ok: true, url: this.page.url() };
    } catch (e) {
      return { ok: false, error: e.message };
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
      let cookies = null;
      if (process.env.GOOGLE_COOKIES) {
        try {
          cookies = JSON.parse(process.env.GOOGLE_COOKIES);
        } catch (_) {}
      }
      if (!cookies && fs.existsSync(this.savedCookiesPath)) {
        try {
          cookies = JSON.parse(fs.readFileSync(this.savedCookiesPath, 'utf8'));
        } catch (_) {}
      }
      if (Array.isArray(cookies) && cookies.length > 0) {
        const formatted = this._cleanAndFormatCookies(cookies);
        if (formatted.length > 0) {
          await this.context.addCookies(formatted);
          this.log(`Injected ${formatted.length} cookies from disk backup into session.`, 'info');
        }
      }
    } catch (e) {
      this.log(`Note loading saved cookies: ${e.message}`, 'warn');
    }
  }

  // ── Cookie Format Helper (No Cross-Domain Cloning, Preserves Exact Origin) ──
  _cleanAndFormatCookies(raw) {
    if (!Array.isArray(raw)) return [];

    const mapSameSite = (v) => {
      if (!v) return undefined;
      const s = String(v).toLowerCase().trim();
      if (s === 'strict') return 'Strict';
      if (s === 'lax') return 'Lax';
      if (s === 'none' || s === 'no_restriction') return 'None';
      return undefined;
    };

    const formatted = [];
    const seen = new Set();

    for (const c of raw) {
      if (!c || !c.name || c.value === undefined) continue;

      const sameSite = mapSameSite(c.sameSite);
      const isNone = sameSite === 'None';
      const isSecure = Boolean(
        c.secure ||
        isNone ||
        c.name.startsWith('__Secure-') ||
        c.name.startsWith('__Host-')
      );

      const cookie = {
        name: String(c.name).trim(),
        value: String(c.value),
        httpOnly: Boolean(c.httpOnly),
        secure: isSecure,
      };

      if (sameSite) {
        cookie.sameSite = sameSite;
      }

      if (c.expirationDate && c.expirationDate > 0) {
        cookie.expires = Math.floor(c.expirationDate);
      }

      if (c.name.startsWith('__Host-')) {
        // __Host- cookies must have url and MUST NOT have domain or path per Playwright/RFC
        let cleanHost = (c.domain || '').replace(/^\.+/, '');
        if (!cleanHost) cleanHost = 'accounts.google.com';
        cookie.url = `https://${cleanHost}`;
      } else {
        // All other cookies must have domain and path, and MUST NOT have url
        let dom = c.domain ? c.domain.trim() : '.google.com';
        if (!dom.startsWith('.') && !dom.includes('localhost')) {
          dom = '.' + dom;
        }
        cookie.domain = dom;
        cookie.path = c.path || '/';
      }

      const dedupeKey = `${cookie.name}|${cookie.domain || cookie.url}|${cookie.path || ''}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        formatted.push(cookie);
      }
    }

    return formatted;
  }

  // ── Import Cookies (Preserves Existing Session & Profile) ──
  async importCookies(input) {
    let raw = input;
    if (!Array.isArray(raw) && raw && Array.isArray(raw.cookies)) raw = raw.cookies;
    if (!Array.isArray(raw)) {
      return { ok: false, error: 'Expected array of cookie objects from Cookie-Editor' };
    }

    const pwCookies = this._cleanAndFormatCookies(raw);

    if (!pwCookies.length) {
      return { ok: false, error: 'No valid cookies found in payload' };
    }

    // 1. Save cookies to disk backup as recovery data
    try {
      fs.writeFileSync(this.savedCookiesPath, JSON.stringify(pwCookies, null, 2), 'utf8');
      this.log(`Saved ${pwCookies.length} formatted cookies to cookies_saved.json (recovery backup)`, 'info');
    } catch (e) {
      this.log(`Warning writing cookies backup: ${e.message}`, 'warn');
    }

    // 2. Inject into active browser context if running (WITHOUT clearing existing session)
    if (this.context) {
      try {
        await this.context.addCookies(pwCookies);
        this.log(`Added ${pwCookies.length} cookies into active context.`, 'info');

        const mode = this.config.mode || 'cloudshell';
        const target = mode === 'colab' ? this.config.colabUrl : this.config.cloudShellUrl;
        if (this.page && !this.page.isClosed()) {
          try {
            await this.page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await this.sleep(1500);
            await this.handleCloudShellDialogs();
          } catch (_) {}

          await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await this.sleep(3000);
          if (mode === 'cloudshell') {
            await this.handleCloudShellDialogs();
          } else {
            await this.dismissColabDialogs();
          }
          const state = mode === 'colab' ? await this.checkColabState() : await this.checkCloudShellState();
          this.runtimeState = state;
          this.emit('status_change', this.getStatus());
          return { ok: true, count: pwCookies.length, appliedTo: 'running-session', state: state.state };
        }
        return { ok: true, count: pwCookies.length, appliedTo: 'running-session' };
      } catch (e) {
        this.log(`addCookies failed: ${e.message}`, 'warn');
        return { ok: false, error: e.message };
      }
    }

    // 3. If running in Serverless (Vercel / Lambda) environment, return immediately
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      return { ok: true, count: pwCookies.length, appliedTo: 'disk-backup' };
    }

    // 4. If browser is not running, add into persistent profile directory
    try {
      const execPath = this._detectExecutablePath();
      const isLinux = process.platform === 'linux';
      const launchOpts = {
        headless: true,
        viewport: { width: 1400, height: 900 },
        args: isLinux
          ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-infobars']
          : ['--start-maximized', '--disable-infobars'],
        ignoreDefaultArgs: ['--enable-automation'],
      };
      if (execPath) launchOpts.executablePath = execPath;

      this._cleanStaleLocks();
      const tmp = await chromium.launchPersistentContext(this.userDataDir, launchOpts);
      try {
        await tmp.addCookies(pwCookies);
        this.log(`Imported ${pwCookies.length} cookies into persistent profile directory.`, 'info');
        return { ok: true, count: pwCookies.length, appliedTo: 'profile-dir' };
      } finally {
        await tmp.close().catch(() => {});
      }
    } catch (e) {
      this.log(`Profile cookie setup error: ${e.message}`, 'error');
      return { ok: true, count: pwCookies.length, note: 'Saved to disk backup' };
    }
  }

  async takeScreenshot() {
    if (!this.page || this.page.isClosed()) {
      return this.latestScreenshot || null;
    }
    try {
      const buffer = await this.page.screenshot({ type: 'png', timeout: 5000 });
      if (buffer) this.latestScreenshot = buffer;
      return buffer || this.latestScreenshot || null;
    } catch (e) {
      return this.latestScreenshot || null;
    }
  }

  async stop() {
    if (!this.isRunning) return { ok: true };
    this.log('Stopping worker (persistent profile preserved)...', 'info');
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
