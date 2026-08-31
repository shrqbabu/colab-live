// colab-login.js — Automated Google login + profile save
// Usage: node colab-login.js
// Or:    GOOGLE_EMAIL=x@gmail.com GOOGLE_PASSWORD=pass node colab-login.js

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
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

(async () => {
  const config = loadConfig();
  const notebookUrl = config.notebookUrl || 'https://colab.research.google.com/';

  // Credentials: env var > prompt
  const email = process.env.GOOGLE_EMAIL || await ask('Google Email: ');
  const password = process.env.GOOGLE_PASSWORD || await ask('Google Password: ');

  if (!email || !password) {
    console.error('Email aur password zaroori hai.');
    process.exit(1);
  }

  console.log('Browser launch ho raha hai...');

  const isLinux = process.platform === 'linux';
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: isLinux
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      : ['--start-maximized'],
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log('Google login page pe ja raha hai...');
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Email step
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.fill('input[type="email"]', email);
    await page.keyboard.press('Enter');

    // Password step
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    await page.fill('input[type="password"]', password);
    await page.keyboard.press('Enter');

    // Wait for redirect away from login page
    console.log('Login ho raha hai...');
    await page.waitForURL(url => !url.includes('accounts.google.com'), { timeout: 30000 })
      .catch(() => console.log('Redirect timeout — manually check karo'));

    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);

    if (currentUrl.includes('accounts.google.com')) {
      console.log('\n[WARN] Login pura nahi hua. Possible reasons:');
      console.log('  - 2FA required (OTP/verification)');
      console.log('  - Wrong credentials');
      console.log('  - Google security challenge');
      console.log('\nAb 120 seconds diye ja rahe hain — manually complete karo agar VNC available hai...');
      await new Promise(r => setTimeout(r, 120000));
    } else {
      console.log('Login successful! Colab pe ja raha hai...');
    }

    // Navigate to actual notebook to fully save session
    await page.goto(notebookUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(e => console.log('Notebook navigation note:', e.message));

    await new Promise(r => setTimeout(r, 5000));

    console.log('\nProfile save ho gaya!');
    console.log('Profile directory:', PROFILE_DIR);
    console.log('\nAb server chala sakte ho: node server.js');

  } catch (err) {
    console.error('Login error:', err.message);
    console.log('\n120 seconds diye ja rahe hain — manually complete karo agar VNC available hai...');
    await new Promise(r => setTimeout(r, 120000));
  }

  await context.close();
  process.exit(0);
})();
