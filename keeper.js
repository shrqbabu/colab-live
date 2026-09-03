// ============================================================
//  🤖 UNIFIED GOOGLE 24/7 KEEPER — CLI Runner (Cloud Shell & Colab)
//  Usage: node keeper.js
// ============================================================

const UnifiedGoogleWorker = require('./worker');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const worker = new UnifiedGoogleWorker(CONFIG_PATH);

console.log('========================================================');
console.log('  🤖 Unified Google 24/7 Keeper (Colab & Cloud Shell)');
console.log('========================================================\n');

worker.on('log', (entry) => {
  // Worker already prints color/level formatted logs
});

worker.on('status_change', (status) => {
  // Status change hook
});

(async () => {
  const result = await worker.start();
  if (!result.ok) {
    console.error('Failed to start keeper:', result.message);
    process.exit(1);
  }
})();
