// import-cookies.js — Cookie-Editor / Chrome DevTools JSON ko Playwright profile mein inject karo
// Usage: node import-cookies.js cookies.json
// cookies.json = Cookie-Editor se exported JSON (Export -> as JSON -> Copy)
//
// IMPORTANT: Yeh Google session cookies (SID, __Secure-1PSID, etc.) inject karta hai.
// Dashboard ka "Import Profile" Colab Proxy token import karta hai — alag cheez hai.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = process.env.COLAB_PROFILE || path.join(__dirname, 'profile');
const cookiesFile = process.argv[2];

if (!cookiesFile) {
  console.error('Usage: node import-cookies.js cookies.json');
  process.exit(1);
}
if (!fs.existsSync(cookiesFile)) {
  console.error('File nahi mila:', cookiesFile);
  process.exit(1);
}

// Map Cookie-Editor sameSite -> Playwright enum
function mapSameSite(v) {
  const s = (v || '').toLowerCase();
  if (s === 'no_restriction') return 'None';
  if (s === 'strict') return 'Strict';
  if (s === 'lax') return 'Lax';
  return 'Lax';
}

(async () => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
  } catch (e) {
    console.error('JSON parse error:', e.message);
    process.exit(1);
  }

  // Cookie-Editor format: array of {name, value, domain, path, expirationDate, httpOnly, secure, sameSite}
  const pwCookies = raw
    .filter(c => c && c.name && c.value !== undefined)
    .map(c => {
      const cookie = {
        name: c.name,
        value: c.value,
        domain: c.domain && c.domain.startsWith('.') ? c.domain : (c.domain ? '.' + c.domain.replace(/^\.+/, '') : '.google.com'),
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      };
      // expirationDate (seconds) -> expires (seconds), optional
      if (c.expirationDate && c.expirationDate > 0) {
        cookie.expires = Math.floor(c.expirationDate);
      }
      // sameSite: only send if secure (Chrome requires SameSite=None + Secure)
      try { cookie.sameSite = mapSameSite(c.sameSite); } catch (_) {}
      return cookie;
    });

  console.log(`${pwCookies.length} cookies mili, injecting...`);

  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // Purani profile lock files hatao
  ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
    const p = path.join(PROFILE_DIR, f);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  });

  // Headed launch (better for cookie persistence) — but headless OK too
  const isLinux = process.platform === 'linux';
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
    if (isLinux || process.platform === 'darwin') {
      const binaries = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'chrome'];
      try {
        const { execSync } = require('child_process');
        for (const b of binaries) {
          try {
            const found = execSync(`command -v ${b} || which ${b}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0].trim();
            if (found && fs.existsSync(found)) return found;
          } catch (_) {}
        }
      } catch (_) {}
    }
    return undefined;
  }

  const execPath = detectExecutablePath();
  if (execPath) console.log(`Using Chromium: ${execPath}`);

  const launchOpts = {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: isLinux
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      : ['--start-maximized'],
  };
  if (execPath) launchOpts.executablePath = execPath;

  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);

  let ok = false;
  try {
    await context.addCookies(pwCookies);
    console.log('Cookies add ho gayi!');

    // VERIFY: Colab kholo aur dekho redirect hota hai ya nahi
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://colab.research.google.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    }).catch(e => console.log('Nav note:', e.message));

    const url = page.url();
    console.log('Colab URL:', url);

    if (url.includes('accounts.google.com')) {
      console.log('\n[WARN] Session valid NAHI lag raha — Google login page aa gaya.');
      console.log('       Cookies expire ho gayi ya galat domain/cookies hain.');
      console.log('       Chrome mein fresh cookies export karo (Colab tab pe logged-in hokar).');
    } else {
      console.log('\n[OK] Google session VALID hai! Login page nahi aaya.');
      ok = true;
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await context.close().catch(() => {});
  }

  if (ok) {
    console.log('\nProfile save ho gayi:', PROFILE_DIR);
    console.log('Ab worker restart karo: pm2 restart colab-pro-vps');
  } else {
    console.log('\nProfile save NAHI hua — upar wala WARN dekho.');
  }
})();
