// ============================================================
//  🍪 import-cookies.js — Cookie-Editor JSON ko Playwright profile mein save karo
//  Usage: node import-cookies.js [cookies.json]
// ============================================================

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.join(__dirname, 'profile');
const BACKUP_PATH = path.join(__dirname, 'cookies_saved.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const cookiesFile = process.argv[2] || path.join(__dirname, 'cookies.json');

if (!fs.existsSync(cookiesFile)) {
  console.error(`\n[ERROR] Cookies file not found: ${cookiesFile}`);
  console.error('Usage: node import-cookies.js <path-to-cookies.json>');
  console.error('\nInstructions:');
  console.error('  1. Login to Google Cloud Shell or Google Colab in Chrome.');
  console.error('  2. Click Cookie-Editor extension -> Export -> Export as JSON.');
  console.error('  3. Save to cookies.json and run: node import-cookies.js cookies.json\n');
  process.exit(1);
}

function mapSameSite(v) {
  const s = (v || '').toLowerCase();
  if (s === 'no_restriction') return 'None';
  if (s === 'strict') return 'Strict';
  return 'Lax';
}

(async () => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
    if (!Array.isArray(raw) && raw && Array.isArray(raw.cookies)) {
      raw = raw.cookies;
    }
  } catch (e) {
    console.error('JSON parse error in cookies file:', e.message);
    process.exit(1);
  }

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

  console.log(`Found ${pwCookies.length} cookies.`);

  // 1. Save cookies to disk backup (survives process stops, PM2 reboots)
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(pwCookies, null, 2), 'utf8');
  console.log(`✓ Saved permanent backup to: ${BACKUP_PATH}`);

  // 2. Inject into persistent browser profile
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach((f) => {
    const p = path.join(PROFILE_DIR, f);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  });

  const isLinux = process.platform === 'linux';
  const launchOpts = {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: isLinux
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      : ['--start-maximized'],
  };

  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);

  let ok = false;
  try {
    await context.addCookies(pwCookies);
    const page = context.pages()[0] || (await context.newPage());

    console.log('Verifying session with Google...');
    await page.goto('https://colab.research.google.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 35000,
    }).catch(() => {});

    await new Promise((r) => setTimeout(r, 3000));
    const url = page.url();
    console.log('Verification URL:', url);

    if (url.includes('accounts.google.com')) {
      console.log('\n[WARN] Session expired or invalid. Google login page appeared.');
      console.log('       Please export fresh cookies from Chrome while logged in.');
    } else {
      console.log('\n[SUCCESS] Google session is VALID and saved to profile permanently!');
      ok = true;
    }
  } catch (e) {
    console.error('Error during cookie import:', e.message);
  } finally {
    await context.close().catch(() => {});
  }

  if (ok) {
    console.log(`\nProfile Directory: ${PROFILE_DIR}`);
    console.log('Browser stops and restarts will automatically use this profile.');
    console.log('You can now run: npm start');
  }
})();
