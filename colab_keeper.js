// ============================================================
//  🤖 COLAB 24/7 KEEPER — Playwright (Node.js)  [VPS Edition]
//
//  Yeh script Google Colab session ko:
//    1. Alive rakhta hai (keep-alive click, idle timeout roko)
//    2. Session stop / timeout / restart hone par AUTO-RECONNECT
//    3. Reconnect hote hi "Run All" (Ctrl+F9) trigger karta hai
//       -> notebook ka checkpoint system wahi se resume karta hai
//
//  Setup (VPS):
//    npm install
//    npx playwright install chromium
//    node colab_keeper.js              # headed (pehli baar login)
//    pm2 start ecosystem.config.js     # headless mode (24/7)
//
//  NOTE: Pehli baar LOGIN zaroori hai. 2 tarike:
//  1. Local PC pe headed run karo -> profile/ folder VPS pe copy karo
//  2. Ya VPS pe: xvfb-run node colab_keeper.js  (headed via virtual display)
// ============================================================

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ==================== CONFIG (yahi set karo) ====================
const NOTEBOOK_URL = 'https://colab.research.google.com/drive/YOUR_NOTEBOOK_ID'; // <<< APNA notebook link daalo
const KEEPALIVE_MS = 60000;         // keep-alive click interval (60 sec)
const RETRY_CONNECT_MS = 10000;     // disconnect hone par retry interval
const WAIT_AFTER_CONNECT_MS = 6000; // runtime ready hone ka wait (Run All se pehle)

// ⭐ SAB KUCH IS FOLDER ME HOGA — script, profile, log
const BASE_DIR = __dirname;
const USER_DATA_DIR = process.env.COLAB_PROFILE || path.join(BASE_DIR, 'profile');
const LOG_FILE = path.join(BASE_DIR, 'colab_keeper.log');

// VPS mode: HEADLESS = true (browser nahi dikhta)
// Login ke liye PEHLI BAAR headed chalao, phir headless switch karo
// Tarika: process.env.HEADLESS !== 'false'  (default headless)
//          HEADLESS=false node colab_keeper.js  (headed mode)
const HEADLESS = process.env.HEADLESS !== 'false';
// ================================================================

// Log console + file dono me likhta hai
function log(...a) {
  const msg = `[${new Date().toLocaleTimeString()}] ${a.join(' ')}`;
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch (e) { /* ignore */ }
}
// Mac pe Meta+F9, Windows/Linux pe Ctrl+F9
const runKey = process.platform === 'darwin' ? 'Meta+F9' : 'Control+F9';

// Throttle: connect click aur dialog dismiss ko spam mat karo
let lastConnectClickAt = 0;
let lastDialogActionAt = 0;

(async () => {
  log(`Launching Chromium (${HEADLESS ? 'HEADLESS' : 'headed'} mode)...`);

  // VPS (Linux/root) pe Chromium sandbox issue hota hai — no-sandbox chahiye
  const isLinux = process.platform === 'linux';
  const launchArgs = isLinux
    ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    : ['--start-maximized'];

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: null,
    args: launchArgs,
  });

  const page = context.pages()[0] || (await context.newPage());

  // Page crash ho to reload kar do
  page.on('crash', async () => {
    log('⚠️ Page crash — reloading...');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  });

  log(`Opening notebook: ${NOTEBOOK_URL}`);
  await page
    .goto(NOTEBOOK_URL, { waitUntil: 'domcontentloaded', timeout: 120000 })
    .catch((e) => log('⚠️ goto error:', e.message));

  // ============ Helpers (Colab shadow DOM pierce karke) ============

  // Kya page Google login pe redirect ho gaya? (session expire)
  async function isLoginRequired() {
    return page
      .evaluate(() => {
        const url = window.location.href || '';
        return (
          url.includes('accounts.google.com') ||
          url.includes('/signin') ||
          url.includes('ServiceLogin')
        );
      })
      .catch(() => false);
  }

  // Drive autorize / modal dialogs ko dismiss karo (Run All block na karein)
  async function dismissDialogs() {
    const now = Date.now();
    if (now - lastDialogActionAt < 6000) return null; // throttle: 6s
    lastDialogActionAt = now;

    const action = await page
      .evaluate(() => {
        const clickLabel = (root, labels) => {
          const els = root.querySelectorAll('button, mwc-button, paper-button, [role="button"], jupyter-button');
          for (const el of els) {
            const t = (el.textContent || '').trim().toLowerCase();
            if (t && labels.some((l) => t.includes(l))) { el.click(); return true; }
          }
          return false;
        };
        const containers = document.querySelectorAll(
          'dialog, colab-dialog, mwc-dialog, .goog-modal-dialog, [role="dialog"]'
        );
        // Pehle Drive autorize karo (data Drive mein hi hai — zaroori)
        for (const c of containers) {
          if (clickLabel(c, ['connect to google drive', 'allow', 'authorize'])) return 'drive-connect';
        }
        for (const c of containers) {
          if (clickLabel(c, ['no thanks', 'cancel', 'dismiss', 'close', 'skip'])) return 'dialog-dismiss';
        }
        for (const c of containers) {
          if (c.open && c.parentElement) {
            const back = c.parentElement.querySelector('.modal-backdrop, .backdrop, modal-backdrop');
            if (back) { back.click(); return 'backdrop-dismiss'; }
          }
        }
        return null;
      })
      .catch(() => null);

    if (action) {
      log(`Dialogue action: ${action}`);
      await page.waitForTimeout(1200);
    }
    return action;
  }

  // Colab ka connect button (shadow DOM ke andar mwc-button) — robust click
  async function clickConnect() {
    const now = Date.now();
    if (now - lastConnectClickAt < 8000) return null; // throttle: 8s
    lastConnectClickAt = now;

    // 1) Playwright locator — open shadow roots pierce karta hai
    try {
      const host = page.locator('#top-toolbar colab-connect-button, colab-connect-button').first();
      if (await host.count()) {
        const inner = host.locator('mwc-button, button').filter({ hasText: /connect|reconnect/i }).first();
        if (await inner.count()) {
          await inner.click({ timeout: 4000 });
          return 'connect-inner';
        }
        await host.click({ timeout: 4000 });
        return 'connect-host';
      }
    } catch (_) {}

    // 2) JS fallback through shadow DOM
    return page
      .evaluate(() => {
        const hosts = document.querySelectorAll(
          '#top-toolbar colab-connect-button, colab-connect-button, colab-reconnect-button'
        );
        for (const host of hosts) {
          const root = host.shadowRoot || host;
          const btns = root.querySelectorAll('mwc-button, button, [role="button"], connect');
          for (const b of btns) {
            if (/connect|reconnect/i.test(b.textContent || '')) { b.click(); return 'connect-js'; }
          }
        }
        return null;
      })
      .catch(() => null);
  }

  // Runtime connected hai ya nahi (modern Colab: RAM/Disk text = connected)
  async function isConnected() {
    return page
      .evaluate(() => {
        // Disconnect hone par Colab ye element dikhata hai -> connected nahi
        if (document.querySelector('colab-reconnect-button')) return false;
        const tb = document.querySelector('#top-toolbar colab-connect-button, colab-connect-button');
        if (!tb) return false;
        // Connected state signals (Colab ka internal state)
        if (tb.hasAttribute('connected') || tb.getAttribute('connected') === 'true' || tb.classList.contains('connected')) return true;
        // Shadow root ka text: RAM/Disk ya connected/check dikhe to connected
        const txt = ((tb.shadowRoot && tb.shadowRoot.textContent) || '').toLowerCase();
        if (txt.includes('ram') || txt.includes('disk')) return true;
        if (txt.includes('connected') || txt.includes('check')) return true;
        return false;
      })
      .catch(() => false);
  }

  async function triggerRunAll() {
    log('▶️ Run All trigger (' + runKey + ')...');
    await page.keyboard.press(runKey).catch((e) => log('⚠️ keyboard error:', e.message));
  }

  async function waitForCells() {
    try {
      await page.waitForSelector('.cell, [class*="cell"]', { timeout: 60000 });
      log('Notebook cells ready');
    } catch {
      log('⚠️ Cells dikhe nahi — Google login pending ho sakta hai');
    }
  }

  // ============ Initial: Drive auth dialog clear karo, phir cells wait ============
  await page.waitForTimeout(4000);
  await dismissDialogs();
  await waitForCells();

  let wasDisconnected = false;
  let ranForThisConnection = false;

  log('Monitoring start... (keep-alive ON, disconnect watch ON)');

  while (true) {
    // 0) Login expire check — accounts.google.com pe redirect nahi hona chahiye
    if (await isLoginRequired()) {
      log('🔑 Google login required — manual re-login zaroori hai. 30s baad retry...');
      await page.waitForTimeout(30000);
      continue;
    }

    // 1) Har loop me chatne wale dialogs (Drive autorize) dismiss karo
    await dismissDialogs();

    // 2) Keep-alive: har loop me connect click (idle timeout rokta hai)
    await clickConnect();

    const connected = await isConnected();

    if (connected) {
      // Fresh connection ya pehli baar -> Run All EK baar trigger karo
      if (wasDisconnected || !ranForThisConnection) {
        log('✅ Runtime connected — notebook run karta hoon');
        await page.waitForTimeout(WAIT_AFTER_CONNECT_MS);
        await triggerRunAll();
        wasDisconnected = false;
        ranForThisConnection = true;
      }
      // Session chal raha hai — bas alive rakho (dobara run mat karo)
      await page.waitForTimeout(KEEPALIVE_MS);
    } else {
      if (!wasDisconnected) {
        log('🚨 Session stop/disconnect ho gaya — auto-reconnect shuru...');
        wasDisconnected = true;
        ranForThisConnection = false;
      }
      await page.waitForTimeout(RETRY_CONNECT_MS);
    }
  }
})();
