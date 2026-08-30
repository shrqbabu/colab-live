// ============================================================
//  🌐 COLAB VPS KEEPER — Web Server & Dashboard Controller
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const ColabWorker = require('./worker');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Initialize Worker
const worker = new ColabWorker(CONFIG_PATH);

// Memory state
const activeSessions = new Set();
const logBuffer = [];
const MAX_LOGS = 300;
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

// ── Helpers ──
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) { // 5MB limit
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

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: message });
}

function checkAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token && activeSessions.has(token)) return true;

  // Cookie fallback
  const cookies = req.headers['cookie'] || '';
  const match = cookies.match(/colab_token=([a-f0-9]+)/);
  if (match && activeSessions.has(match[1])) return true;

  return false;
}

// ── MIME Types ──
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

// ── HTTP Request Handler ──
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // Handle CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  // ── Public Routes ──

  // 1. Login
  if (pathname === '/api/login' && method === 'POST') {
    try {
      const { email, password } = await parseJsonBody(req);
      const conf = worker.loadConfig();
      const validEmail = (conf.auth && conf.auth.email) || 'admin@colab.pro';
      const validPassword = (conf.auth && conf.auth.password) || 'password123';

      if (email === validEmail && password === validPassword) {
        const token = generateToken();
        activeSessions.add(token);
        worker.log(`User logged in: ${email}`, 'info');
        res.setHeader('Set-Cookie', `colab_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
        sendJson(res, 200, { ok: true, token, user: { email } });
      } else {
        worker.log(`Failed login attempt for: ${email}`, 'warn');
        sendJson(res, 401, { ok: false, error: 'Invalid email or password' });
      }
    } catch (e) {
      sendError(res, 400, e.message);
    }
    return;
  }

  // 2. Check Auth status
  if (pathname === '/api/auth/check' && method === 'GET') {
    const isAuthed = checkAuth(req);
    sendJson(res, 200, { authenticated: isAuthed });
    return;
  }

  // 3. Logout
  if (pathname === '/api/logout' && method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token) activeSessions.delete(token);
    res.setHeader('Set-Cookie', 'colab_token=; Path=/; Max-Age=0');
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── Protected API Routes ──
  if (pathname.startsWith('/api/')) {
    if (!checkAuth(req)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized. Please login.' });
      return;
    }

    // Status
    if (pathname === '/api/status' && method === 'GET') {
      sendJson(res, 200, { ok: true, status: worker.getStatus() });
      return;
    }

    // Worker Controls
    if (pathname === '/api/worker/start' && method === 'POST') {
      const result = await worker.start();
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/worker/stop' && method === 'POST') {
      const result = await worker.stop();
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/worker/restart' && method === 'POST') {
      await worker.stop();
      await worker.sleep(1500);
      const result = await worker.start();
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/worker/run-all' && method === 'POST') {
      const result = await worker.triggerRunAll();
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/worker/reconnect' && method === 'POST') {
      const result = await worker.forceReconnect();
      sendJson(res, 200, result);
      return;
    }

    // Screenshot
    if (pathname === '/api/screenshot' && method === 'GET') {
      const buffer = await worker.takeScreenshot();
      if (buffer) {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache',
          'Content-Length': buffer.length
        });
        res.end(buffer);
      } else {
        sendError(res, 404, 'No active screenshot available (Worker may be stopped or loading)');
      }
      return;
    }

    // Logs
    if (pathname === '/api/logs' && method === 'GET') {
      sendJson(res, 200, { ok: true, logs: logBuffer });
      return;
    }

    if (pathname === '/api/logs/clear' && method === 'POST') {
      logBuffer.length = 0;
      sendJson(res, 200, { ok: true });
      return;
    }

    // Config Management
    if (pathname === '/api/config' && method === 'GET') {
      const conf = worker.loadConfig();
      const sanitized = { ...conf };
      if (sanitized.auth) delete sanitized.auth.password; // do not leak password
      sendJson(res, 200, { ok: true, config: sanitized });
      return;
    }

    if (pathname === '/api/config' && method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        worker.saveConfig(body);
        sendJson(res, 200, { ok: true, config: worker.getStatus() });
      } catch (e) {
        sendError(res, 400, e.message);
      }
      return;
    }

    // Profile Import (from Chrome extension exported JSON)
    if (pathname === '/api/profile/import' && method === 'POST') {
      try {
        const importedData = await parseJsonBody(req);
        const profile = importedData.profile || importedData;

        const updates = {};
        if (profile.notebookId) {
          updates.notebookUrl = `https://colab.research.google.com/drive/${profile.notebookId}`;
        }
        if (profile.proxyUrl || profile.token) {
          updates.profile = {
            proxyUrl: profile.proxyUrl || '',
            token: profile.token || '',
            notebookId: profile.notebookId || '',
            region: profile.region || '—'
          };
        }

        worker.saveConfig(updates);
        worker.log('✅ Chrome Extension profile imported successfully!', 'info');
        sendJson(res, 200, { ok: true, message: 'Profile imported', updates });
      } catch (e) {
        sendError(res, 400, 'Invalid JSON profile payload: ' + e.message);
      }
      return;
    }

    // Change Password
    if (pathname === '/api/auth/update' && method === 'POST') {
      try {
        const { email, newPassword } = await parseJsonBody(req);
        if (!newPassword || newPassword.length < 6) {
          sendError(res, 400, 'Password must be at least 6 characters');
          return;
        }
        const currentConf = worker.loadConfig();
        currentConf.auth = {
          email: email || currentConf.auth?.email || 'admin@colab.pro',
          password: newPassword
        };
        worker.saveConfig(currentConf);
        worker.log('Admin credentials updated', 'info');
        sendJson(res, 200, { ok: true, message: 'Credentials updated' });
      } catch (e) {
        sendError(res, 400, e.message);
      }
      return;
    }

    // Server-Sent Events (SSE) for Real-Time Streaming
    if (pathname === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`event: init\ndata: ${JSON.stringify({ status: worker.getStatus(), logs: logBuffer.slice(-50) })}\n\n`);
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    sendError(res, 404, 'API endpoint not found');
    return;
  }

  // ── Static Frontend Files ──
  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  const ext = path.extname(filePath).toLowerCase();

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Access Denied');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // Fallback to index.html for SPA
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, indexContent) => {
          if (e2) {
            res.writeHead(404);
            res.end('File Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(indexContent);
          }
        });
      } else {
        res.writeHead(500);
        res.end('Internal Server Error: ' + err.code);
      }
    } else {
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

// ── Start Server ──
const config = worker.loadConfig();
const PORT = process.env.PORT || config.port || 3000;

server.listen(PORT, '0.0.0.0', () => {
  worker.log(`====================================================`, 'info');
  worker.log(`⚡ Colab Pro VPS Dashboard running on http://0.0.0.0:${PORT}`, 'info');
  worker.log(`🔑 Default Login: ${config.auth?.email || 'admin@colab.pro'} / ${config.auth?.password || 'password123'}`, 'info');
  worker.log(`====================================================`, 'info');

  // Auto-start worker if configured
  if (config.autoStart !== false) {
    worker.start();
  }
});
