// ============================================================
//  🤖 GOOGLE CLOUD SHELL 24/7 KEEPER — Playwright (Node.js)
//
//  Workflow:
//    1. Google Cloud Shell URL load karta hai.
//    2. 1 minute (60 sec) wait karta hai terminal initialize hone ke liye.
//    3. Terminal me command type karta hai: `docker start omniroute` + Enter.
//    4. Session active hone ke baad KOI CLICK NAHI KARTA.
//    5. Har 10 minute me check karta hai session active hai ya end ho gaya.
//    6. Agar session end / disconnect ho gaya, auto-reconnect karke dobara command chalata hai.
// ============================================================

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_DIR = __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const USER_DATA_DIR = process.env.CLOUDSHELL_PROFILE || path.join(BASE_DIR, 'profile');
const LOG_FILE = path.join(BASE_DIR, 'cloudshell_keeper.log');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Config load error:', e.message);
  }
  return {
    cloudShellUrl: 'https://shell.cloud.google.com/?show=terminal',
    startupCommand: 'docker start omniroute',
    waitAfterLoadSec: 60,
    checkIntervalMin: 10,
    headless: true,
  };
}

const config = loadConfig();
const CLOUDSHELL_URL = process.env.CLOUDSHELL_URL || config.cloudShellUrl || 'https://shell.cloud.google.com/?show=terminal';
const STARTUP_COMMAND = process.env.STARTUP_CMD || config.startupCommand || 'docker start omniroute';
const WAIT_AFTER_LOAD_MS = (config.waitAfterLoadSec || 60) * 1000;
const CHECK_INTERVAL_MS = (config.checkIntervalMin || 10) * 60 * 1000;
const HEADLESS = process.env.HEADLESS !== 'false' && config.headless !== false;

function log(...args) {
  const timestamp = new Date().toLocaleTimeString();
  const line = `[${timestamp}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectExecutablePath() {
  const envPaths = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ];
  for (const ep of envPaths) {
    if (ep && fs.existsSync(ep)) return ep;
  }

  const isLinux = process.platform === 'linux';
  if (isLinux || process.platform === 'darwin') {
    const binaries = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'chrome'];
    try {
      const { execSync } = require('child_process');
      for (const b of binaries) {
        try {
          const found = execSync(`command -v ${b} || which ${b}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim().split('\n')[0].trim();
          if (found && fs.existsSync(found)) return found;
        } catch (_) {}
      }
    } catch (_) {}

    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
      for (const b of binaries) {
        const full = path.join(dir, b);
        if (fs.existsSync(full)) return full;
      }
    }
  }

  const candidates = process.platform === 'win32'
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
    if (p && fs.existsSync(p)) return p;
  }

  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (_) {}

  return undefined;
}

(async () => {
  log(`Starting Google Cloud Shell Keeper (${HEADLESS ? 'HEADLESS' : 'HEADED'} mode)...`);
  log(`Target URL: ${CLOUDSHELL_URL}`);
  log(`Startup Command: "${STARTUP_COMMAND}"`);
  log(`Wait after load: ${WAIT_AFTER_LOAD_MS / 1000} seconds (1 min)`);
  log(`Check interval: ${CHECK_INTERVAL_MS / 60000} minutes`);

  const isLinux = process.platform === 'linux';
  const launchArgs = isLinux
    ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    : ['--start-maximized'];

  const execPath = detectExecutablePath();
  if (execPath) log(`Using Chromium executable: ${execPath}`);

  const launchOpts = {
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    args: launchArgs,
  };
  if (execPath) launchOpts.executablePath = execPath;

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOpts);
  const page = context.pages()[0] || (await context.newPage());

  page.on('crash', async () => {
    log('⚠️ Page crashed — reloading Cloud Shell...');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  });

  page.on('pageerror', (err) => {
    if (!err.message.includes('ResizeObserver') && !err.message.includes('Extension')) {
      log(`Page error: ${err.message.substring(0, 100)}`);
    }
  });

  async function checkIsLoginRequired() {
    return page
      .evaluate(() => {
        const url = window.location.href || '';
        return (
          url.includes('accounts.google.com') ||
          url.includes('google.com/signin') ||
          url.includes('google.com/ServiceLogin')
        );
      })
      .catch(() => false);
  }

  async function checkSessionEnded() {
    if (page.isClosed()) return true;

    try {
      const isEnded = await page.evaluate(() => {
        const bodyText = document.body ? document.body.innerText.toLowerCase() : '';

        // Disconnected or session ended text indicators
        const disconnectPhrases = [
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

        for (const phrase of disconnectPhrases) {
          if (bodyText.includes(phrase)) return true;
        }

        // Check for visible Reconnect or Restart buttons
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a.mat-button, .mat-raised-button'));
        for (const btn of buttons) {
          const t = (btn.textContent || '').trim().toLowerCase();
          if (
            t === 'reconnect' ||
            t.includes('reconnect to cloud shell') ||
            t === 'restart cloud shell' ||
            t === 'start cloud shell' ||
            t === 'try again' ||
            t === 'retry'
          ) {
            const rect = btn.getBoundingClientRect();
            const style = window.getComputedStyle(btn);
            if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
              return true;
            }
          }
        }

        return false;
      });

      return isEnded;
    } catch (e) {
      return true;
    }
  }

  async function handleAuthorizationAndDialogs() {
    try {
      // Check for Authorize Cloud Shell popup / Start Cloud Shell / Open Terminal buttons
      const buttons = page.locator('button, [role="button"]').filter({
        hasText: /authorize|start cloud shell|open terminal|continue|agree|got it/i,
      });
      const count = await buttons.count();
      if (count > 0) {
        await buttons.first().click({ timeout: 4000 });
        log('Clicked authorization/startup dialog button');
        await sleep(2000);
      }
    } catch (_) {}
  }

  async function attemptReconnect() {
    log('Attempting Cloud Shell reconnection...');
    try {
      // 1. Try finding and clicking the Reconnect / Restart button
      const reconnectBtns = page.locator('button, [role="button"]').filter({
        hasText: /reconnect|restart|start cloud shell|try again/i,
      });

      const count = await reconnectBtns.count();
      if (count > 0) {
        await reconnectBtns.first().click({ timeout: 5000 });
        log('Clicked Reconnect/Restart button');
        await sleep(3000);
        return true;
      }

      // 2. Fallback: Reload the page
      log('No reconnect button found, reloading page...');
      await page.goto(CLOUDSHELL_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      return true;
    } catch (err) {
      log(`Reconnect attempt error: ${err.message}`);
      return false;
    }
  }

  async function sendTerminalCommand(cmd) {
    log(`Preparing to send command: "${cmd}" to Cloud Shell terminal...`);

    try {
      // Strategy 1: Focus xterm helper textarea if present
      const textarea = page.locator('textarea.xterm-helper-textarea, .xterm-helper-textarea, textarea').first();
      if (await textarea.count()) {
        await textarea.focus({ timeout: 5000 }).catch(() => {});
        await textarea.click({ timeout: 5000 }).catch(() => {});
        log('Focused xterm terminal textarea');
      } else {
        // Strategy 2: Focus xterm screen or terminal container
        const termScreen = page.locator('.xterm-screen, .xterm, [aria-label*="terminal" i], [role="region"]').first();
        if (await termScreen.count()) {
          await termScreen.click({ timeout: 5000 }).catch(() => {});
          log('Clicked terminal container element');
        }
      }

      // Check inside any iframe if Cloud Shell terminal is in an iframe
      const frames = page.frames();
      for (const frame of frames) {
        try {
          const frameTextarea = frame.locator('textarea.xterm-helper-textarea, textarea, .xterm-screen').first();
          if (await frameTextarea.count()) {
            await frameTextarea.focus({ timeout: 2000 }).catch(() => {});
            await frameTextarea.click({ timeout: 2000 }).catch(() => {});
            log('Focused terminal inside iframe');
            break;
          }
        } catch (_) {}
      }

      await sleep(500);

      // Type the command with human-like delay and press Enter
      log(`Typing "${cmd}" and pressing Enter...`);
      await page.keyboard.type(cmd, { delay: 40 });
      await sleep(300);
      await page.keyboard.press('Enter');
      await sleep(500);

      log(`✅ Command "${cmd}" successfully sent to Google Cloud Shell!`);
      return true;
    } catch (err) {
      log(`❌ Error sending command to terminal: ${err.message}`);
      return false;
    }
  }

  async function openAndInitializeSession() {
    log(`Navigating to Google Cloud Shell: ${CLOUDSHELL_URL}`);
    await page.goto(CLOUDSHELL_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch((e) => {
      log(`Navigation note: ${e.message}`);
    });

    // Check login
    if (await checkIsLoginRequired()) {
      log('⚠️ Google Login is required. Please login using `npm run login` or import cookies with `npm run cookies`.');
      return false;
    }

    await handleAuthorizationAndDialogs();

    log(`⏳ Waiting 1 minute (${WAIT_AFTER_LOAD_MS / 1000}s) for Cloud Shell environment & terminal initialization...`);
    await sleep(WAIT_AFTER_LOAD_MS);

    await handleAuthorizationAndDialogs();

    // Send the docker start omniroute command
    await sendTerminalCommand(STARTUP_COMMAND);
    log('🎯 Cloud Shell session initialized and command executed.');
    log('🔒 No further clicks will be performed during active session.');
    return true;
  }

  // Initial startup
  let sessionInitialized = await openAndInitializeSession();

  log(`\n======================================================`);
  log(`🚀 Active monitoring running. Checking session every ${CHECK_INTERVAL_MS / 60000} minutes.`);
  log(`   (Zero clicks while session is running)`);
  log(`======================================================\n`);

  while (true) {
    await sleep(CHECK_INTERVAL_MS);

    log(`🔍 [10-Min Check] Checking Google Cloud Shell session status...`);

    if (await checkIsLoginRequired()) {
      log('⚠️ Google Login required. Waiting for credentials/cookies...');
      continue;
    }

    const isEnded = await checkSessionEnded();

    if (isEnded) {
      log('🚨 Google Cloud Shell session has ENDED / DISCONNECTED!');
      log('🔄 Reconnecting and re-initializing session...');

      await attemptReconnect();

      log(`⏳ Waiting 1 minute (${WAIT_AFTER_LOAD_MS / 1000}s) for re-established shell initialization...`);
      await sleep(WAIT_AFTER_LOAD_MS);

      await handleAuthorizationAndDialogs();
      await sendTerminalCommand(STARTUP_COMMAND);

      log('✅ Reconnect complete! Returning to 10-minute monitoring loop.');
    } else {
      log('🟢 Session is ACTIVE and healthy. (No clicks performed).');
    }
  }
})();
