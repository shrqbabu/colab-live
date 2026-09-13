require('./load-env');
// ============================================================
//  🔑 Google Cloud Shell Login Helper — Headed Login & Profile Saver
//  Usage: node cloudshell-login.js
//  Or:    GOOGLE_EMAIL=x@gmail.com GOOGLE_PASSWORD=pass node cloudshell-login.js
// ============================================================

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PROFILE_DIR = path.join(__dirname, 'profile');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {}
  return {};
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

(async () => {
  const config = loadConfig();
  const cloudShellUrl = config.cloudShellUrl || 'https://shell.cloud.google.com/?show=terminal';

  console.log('========================================================');
  console.log('  Google Cloud Shell Login & Session Profile Setup');
  console.log('========================================================\n');

  let email = process.env.GOOGLE_EMAIL;
  let password = process.env.GOOGLE_PASSWORD;

  if (!email) {
    email = await ask('Google Email (or press Enter to login manually in browser): ');
  }

  if (email && !password) {
    password = await ask('Google Password: ');
  }

  console.log('\nStarting Chromium browser in HEADED mode...');

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
            const found = execSync(`command -v ${b} || which ${b}`, {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            })
              .trim()
              .split('\n')[0]
              .trim();
            if (found && fs.existsSync(found)) return found;
          } catch (_) {}
        }
      } catch (_) {}
    }
    return undefined;
  }

  const execPath = detectExecutablePath();
  if (execPath) console.log(`Using Chromium binary: ${execPath}`);

  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }

  // Remove potential lock files from previous runs
  ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach((f) => {
    const p = path.join(PROFILE_DIR, f);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  });

  const launchOpts = {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: isLinux
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      : ['--start-maximized'],
  };
  if (execPath) launchOpts.executablePath = execPath;

  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
  const page = context.pages()[0] || (await context.newPage());

  try {
    if (email && password) {
      console.log('Navigating to Google Sign-in...');
      await page.goto('https://accounts.google.com/signin', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      // Fill Email
      try {
        await page.waitForSelector('input[type="email"]', { timeout: 15000 });
        await page.fill('input[type="email"]', email);
        await page.keyboard.press('Enter');
        console.log('Entered email, waiting for password field...');
      } catch (e) {
        console.log('Email input note:', e.message);
      }

      // Fill Password
      try {
        await page.waitForSelector('input[type="password"]', { timeout: 20000 });
        await page.fill('input[type="password"]', password);
        await page.keyboard.press('Enter');
        console.log('Entered password, authenticating...');
      } catch (e) {
        console.log('Password input note (may require manual action or 2FA):', e.message);
      }
    } else {
      console.log('Navigating directly to Google Cloud Shell...');
      await page.goto(cloudShellUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    console.log('\n[INFO] Please complete login, 2FA, or project selection in the browser window if prompted.');
    console.log('Waiting for Google Cloud Shell to load...');

    // Wait until URL moves past accounts.google.com
    await page
      .waitForURL((url) => !url.includes('accounts.google.com'), { timeout: 120000 })
      .catch(() => console.log('Proceeding to Cloud Shell check...'));

    // Open target Cloud Shell URL to make sure cookies and project cache are fully warm
    await page.goto(cloudShellUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => {
      console.log('Cloud Shell navigation note:', e.message);
    });

    console.log('Waiting 15 seconds for Cloud Shell session initialization...');
    await new Promise((r) => setTimeout(r, 15000));

    const finalUrl = page.url();
    console.log('Current URL:', finalUrl);

    if (finalUrl.includes('accounts.google.com')) {
      console.log('\n[WARN] Login not completed yet.');
      console.log('Giving 60 seconds to finish manually in browser...');
      await new Promise((r) => setTimeout(r, 60000));
    } else {
      console.log('\n[SUCCESS] Google Cloud Shell session established and saved to profile!');
    }

    console.log(`Profile saved at: ${PROFILE_DIR}`);
    console.log('\nYou can now run the 24/7 background worker:');
    console.log('  node server.js');
    console.log('  OR: pm2 start ecosystem.config.js\n');
  } catch (err) {
    console.error('Error during login:', err.message);
    console.log('Giving 60 seconds to finish manually...');
    await new Promise((r) => setTimeout(r, 60000));
  } finally {
    await context.close().catch(() => {});
    process.exit(0);
  }
})();
