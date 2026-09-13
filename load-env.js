const fs = require('fs');
const path = require('path');

function loadEnv(envFilePath) {
  const targetPath = envFilePath || path.join(__dirname, '.env');

  if (typeof process.loadEnvFile === 'function') {
    try {
      if (fs.existsSync(targetPath)) {
        process.loadEnvFile(targetPath);
        return;
      }
    } catch (_) {}
  }

  try {
    if (fs.existsSync(targetPath)) {
      const content = fs.readFileSync(targetPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (_) {}
}

loadEnv();

module.exports = { loadEnv };
