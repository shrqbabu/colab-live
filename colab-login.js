const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const context = await chromium.launchPersistentContext(
    path.join(__dirname, 'profile'),
    {
      headless: false,
      viewport: null,
      args: ['--start-maximized']
    }
  );

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://colab.research.google.com/drive/1rbcpyiaEneeLuqpczvYaJn3soEFR7LkQ');

  console.log('Browser khula hai — Google login complete karo, phir yahan Enter dabao...');
  process.stdin.once('data', async () => {
    console.log('Profile save ho gaya! Browser band kar sakte ho.');
    process.exit(0);
  });
})();