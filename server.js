// ============================================================
//  🌐 GOOGLE CLOUD & COLAB MANAGER — Web Server & API
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const UnifiedGoogleWorker = require('./worker');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const worker = new UnifiedGoogleWorker(CONFIG_PATH);

// In-Memory state
const logBuffer = [];
const MAX_LOGS = 350;
const sseClients = new Set();

// Pipe worker logs to in-memory buffer & SSE
worker.on('log', (entry) => {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  broadcastSSE('log', entry);
});

worker.on('status_change', (status) => {
  broadcastSSE('status', status);
});

function broadcastSSE(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Secret, X-VPS-URL, X-VPS-Key, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: message });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, filename) {
  let filePath = path.join(__dirname, filename);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'public', filename);
  }
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendError(res, 404, 'File not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Secret, X-VPS-URL, X-VPS-Key, X-Requested-With');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Health Check (for VPS Gateway & Vercel) ──
  if (pathname === '/api/health' || pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'google-automation-manager-vps',
      isRunning: worker.isRunning,
      uptimeSec: Math.floor(process.uptime()),
      mode: worker.config.mode || 'cloudshell',
      port: PORT,
      timestamp: Date.now(),
    });
    return;
  }

  // ── Status check ──
  if ((pathname === '/api/status' || pathname === '/status') && method === 'GET') {
    sendJson(res, 200, { ok: true, ...worker.getStatus() });
    return;
  }

  // ── SSE Stream ──
  if (pathname === '/api/events' || pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: init\ndata: ${JSON.stringify({ status: worker.getStatus(), logs: logBuffer })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // ── Worker controls ──
  if ((pathname === '/api/start' || pathname === '/api/worker/start') && method === 'POST') {
    const result = await worker.start();
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  if ((pathname === '/api/stop' || pathname === '/api/worker/stop') && method === 'POST') {
    const result = await worker.stop();
    sendJson(res, 200, result);
    return;
  }

  if ((pathname === '/api/restart' || pathname === '/api/worker/restart') && method === 'POST') {
    await worker.stop();
    setTimeout(() => worker.start(), 1000);
    sendJson(res, 200, { ok: true });
    return;
  }

  if ((pathname === '/api/reconnect' || pathname === '/api/worker/reconnect') && method === 'POST') {
    const result = await worker.forceReconnect();
    sendJson(res, 200, result);
    return;
  }

  if ((pathname === '/api/run-all' || pathname === '/api/worker/run-all') && method === 'POST') {
    const result = await worker.triggerColabRunAll();
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  // ── Remote Command Execution ──
  if (pathname === '/api/send-command' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const cmd = body.command || worker.config.startupCommand || 'docker start omniroute';
      const result = await worker.sendTerminalCommand(cmd);
      sendJson(res, result.ok ? 200 : 500, result);
    } catch (e) {
      sendError(res, 400, e.message);
    }
    return;
  }

  // ── Live Screenshot Viewport ──
  if (pathname === '/api/screenshot' && method === 'GET') {
    const buffer = await worker.takeScreenshot();
    if (buffer) {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache, no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(buffer);
    } else {
      sendError(res, 404, 'No active screenshot available');
    }
    return;
  }

  // ── Logs ──
  if (pathname === '/api/logs' && method === 'GET') {
    sendJson(res, 200, { ok: true, logs: logBuffer });
    return;
  }

  if (pathname === '/api/logs/clear' && method === 'POST') {
    logBuffer.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── Import Cookies & Profile ──
  if ((pathname === '/api/cookies' || pathname === '/api/cookies/import') && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const result = await worker.importCookies(body);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (e) {
      sendError(res, 400, e.message);
    }
    return;
  }

  // ── Get & Update Config ──
  if (pathname === '/api/config' && method === 'GET') {
    const conf = worker.loadConfig();
    sendJson(res, 200, { ok: true, config: conf });
    return;
  }

  if (pathname === '/api/config' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      worker.saveConfig(body);
      sendJson(res, 200, { ok: true, config: worker.config });
    } catch (e) {
      sendError(res, 400, e.message);
    }
    return;
  }

  // ── Static Files (HTML / CSS / JS) ──
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(req, res, 'index.html');
    return;
  }
  if (pathname === '/style.css') {
    serveStatic(req, res, 'style.css');
    return;
  }
  if (pathname === '/client.js') {
    serveStatic(req, res, 'client.js');
    return;
  }

  sendError(res, 404, 'Not Found');
});

const config = worker.loadConfig();
const PORT = parseInt(process.env.PORT || config.port || '8080', 10);

server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================================');
  console.log(`  🌐 Google Cloud & Colab Manager Running on port ${PORT}`);
  console.log(`  🔗 Web Dashboard: http://localhost:${PORT}`);
  console.log(`  🎯 Selected Mode: [${(config.mode || 'cloudshell').toUpperCase()}]`);
  console.log(`  🔗 Cloud Shell URL: ${config.cloudShellUrl}`);
  console.log(`  🔗 Colab URL: ${config.colabUrl}`);
  console.log('========================================================\n');

  if (config.autoStart) {
    console.log('AutoStart is enabled. Starting worker in 2 seconds...');
    setTimeout(() => {
      worker.start().catch((e) => console.error('AutoStart error:', e.message));
    }, 2000);
  }
});
