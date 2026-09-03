// ============================================================
//  ⚡ Vercel Serverless All-in-One Gateway & Static Server
//  Cloud Shell & Colab Unified Automation
// ============================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

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

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'x-vps-url',
]);

function parseVpsUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let raw = input.trim().replace(/^["'`\s]+|["'`\s]+$/g, '').trim();
  if (!raw) return null;
  if (/^https?:\/*$/i.test(raw) || raw === 'undefined' || raw === 'null' || raw === 'http' || raw === 'https') {
    return null;
  }
  raw = raw.replace(/^https?:\/\/(https?:\/\/)+/i, '$1');
  raw = raw.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!/^https?:\/\//i.test(raw)) {
    raw = 'http://' + raw;
  }
  raw = raw.replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^["'`]+|["'`]+$/g, '');
    if (!host || host === 'http' || host === 'https' || host.length < 3 || host.includes('"') || host.includes("'")) {
      return null;
    }
    return u.origin;
  } catch (_) {
    return null;
  }
}

function sendResponse(res, statusCode, body, headers = {}) {
  if (res.headersSent) return;
  for (const [k, v] of Object.entries(headers)) {
    try { res.setHeader(k, v); } catch (_) {}
  }
  if (typeof res.status === 'function') {
    res.status(statusCode);
  } else {
    res.statusCode = statusCode;
  }
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    try { res.setHeader('Content-Type', 'application/json; charset=utf-8'); } catch (_) {}
    res.end(JSON.stringify(body));
  } else {
    res.end(body);
  }
}

async function getRequestBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return Buffer.from(JSON.stringify(req.body));
    } else if (typeof req.body === 'string') {
      return Buffer.from(req.body);
    } else if (Buffer.isBuffer(req.body)) {
      return req.body;
    }
  }

  if (req.readableEnded || req.complete || req.readable === false) {
    return Buffer.alloc(0);
  }

  return new Promise((resolve) => {
    const chunks = [];
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) { finished = true; resolve(Buffer.concat(chunks)); }
    }, 1500);

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!finished) { finished = true; clearTimeout(timer); resolve(Buffer.concat(chunks)); }
    });
    req.on('error', () => {
      if (!finished) { finished = true; clearTimeout(timer); resolve(Buffer.alloc(0)); }
    });
  });
}

// Import Unified Worker
const UnifiedGoogleWorker = require('./worker');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const worker = new UnifiedGoogleWorker(CONFIG_PATH);

// In-Memory state
const logBuffer = [];
const MAX_LOGS = 350;
const sseClients = new Set();

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

async function parseJsonBody(req) {
  const buffer = await getRequestBody(req);
  try {
    return buffer.length > 0 ? JSON.parse(buffer.toString('utf-8')) : {};
  } catch (err) {
    throw new Error('Invalid JSON');
  }
}

const authTokens = new Map();

module.exports = async function handler(req, res) {
  // Global CORS
  try {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, X-VPS-URL, X-API-Secret, X-VPS-Key'
    );
  } catch (_) {}

  if (req.method === 'OPTIONS') {
    if (typeof res.status === 'function') return res.status(200).end();
    res.statusCode = 200;
    return res.end();
  }

  // Determine requested path
  const rawUrl = req.url || '/';
  let parsedReqUrl;
  try {
    parsedReqUrl = new URL(rawUrl, 'http://localhost');
  } catch (_) {
    parsedReqUrl = new URL('/', 'http://localhost');
  }

  let pathname = parsedReqUrl.searchParams.get('__path') || parsedReqUrl.pathname || '/';
  if (!pathname.startsWith('/')) pathname = '/' + pathname;

  // Check headers if rewritten by Vercel
  const xMatched = req.headers['x-matched-path'] || req.headers['x-forwarded-url'] || req.headers['x-original-url'];
  if (xMatched && xMatched !== '/index.js' && !parsedReqUrl.searchParams.has('__path')) {
    try {
      pathname = new URL(xMatched, 'http://localhost').pathname;
    } catch (_) {
      pathname = xMatched.split('?')[0];
    }
  }

  // ── 1. API ROUTES: /api/* ──
  if (pathname.startsWith('/api/') || pathname === '/api') {
    let apiPath = pathname.replace(/^\/api/, '');
    if (!apiPath.startsWith('/')) apiPath = '/' + apiPath;

    // ── Auth Endpoints ──
    if (apiPath === '/login' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const conf = worker.loadConfig();
        const email = body.email || '';
        const password = body.password || '';

        if (email === (conf.auth?.email || 'admin@cloudshell.pro') &&
            password === (conf.auth?.password || 'password123')) {
          const token = generateToken();
          authTokens.set(token, { email, created: Date.now() });
          return sendResponse(res, 200, { ok: true, token });
        }
        return sendResponse(res, 401, { ok: false, error: 'Invalid credentials' });
      } catch (e) {
        return sendResponse(res, 400, { ok: false, error: e.message });
      }
    }

    if (apiPath === '/logout' && req.method === 'POST') {
      const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
      authTokens.delete(token);
      return sendResponse(res, 200, { ok: true });
    }

    if (apiPath === '/auth/check') {
      const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
      return sendResponse(res, 200, { ok: true, authenticated: authTokens.has(token) });
    }

    if (apiPath === '/auth/update' && req.method === 'POST') {
      const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
      if (!authTokens.has(token)) return sendResponse(res, 401, { ok: false, error: 'Unauthorized' });
      try {
        const body = await parseJsonBody(req);
        worker.saveConfig({ auth: { password: body.newPassword } });
        return sendResponse(res, 200, { ok: true });
      } catch (e) {
        return sendResponse(res, 400, { ok: false, error: e.message });
      }
    }

    // ── Status & SSE ──
    if (apiPath === '/status' && req.method === 'GET') {
      return sendResponse(res, 200, { ok: true, ...worker.getStatus() });
    }

    if (apiPath === '/logs' && req.method === 'GET') {
      return sendResponse(res, 200, { ok: true, logs: logBuffer });
    }

    if (apiPath === '/logs/clear' && req.method === 'POST') {
      logBuffer.length = 0;
      return sendResponse(res, 200, { ok: true });
    }

    // SSE Stream
    if (apiPath === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: init\ndata: ${JSON.stringify({ status: worker.getStatus(), logs: logBuffer })}\n\n`);
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // ── Worker Controls ──
    if (apiPath === '/worker/start' && req.method === 'POST') {
      const result = await worker.start();
      return sendResponse(res, result.ok ? 200 : 500, result);
    }

    if (apiPath === '/worker/stop' && req.method === 'POST') {
      const result = await worker.stop();
      return sendResponse(res, 200, result);
    }

    if (apiPath === '/worker/restart' && req.method === 'POST') {
      await worker.stop();
      setTimeout(() => worker.start(), 1000);
      return sendResponse(res, 200, { ok: true });
    }

    if (apiPath === '/worker/run-all' && req.method === 'POST') {
      const result = await worker.triggerColabRunAll();
      return sendResponse(res, result.ok ? 200 : 500, result);
    }

    if (apiPath === '/worker/reconnect' && req.method === 'POST') {
      const result = await worker.forceReconnect();
      return sendResponse(res, 200, result);
    }

    // ── Remote Command ──
    if (apiPath === '/send-command' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const result = await worker.sendTerminalCommand(body.command);
        return sendResponse(res, result.ok ? 200 : 500, result);
      } catch (e) {
        return sendResponse(res, 400, { ok: false, error: e.message });
      }
    }

    // ── Screenshot ──
    if (apiPath === '/screenshot' && req.method === 'GET') {
      const buffer = await worker.takeScreenshot();
      if (buffer) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        res.end(buffer);
      } else {
        sendResponse(res, 404, 'No screenshot available');
      }
      return;
    }

    // ── Config & Cookies ──
    if (apiPath === '/config' && req.method === 'GET') {
      const conf = worker.loadConfig();
      return sendResponse(res, 200, { ok: true, config: conf });
    }

    if (apiPath === '/config' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        worker.saveConfig(body);
        return sendResponse(res, 200, { ok: true, config: worker.config });
      } catch (e) {
        return sendResponse(res, 400, { ok: false, error: e.message });
      }
    }

    if (apiPath === '/cookies/import' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const result = await worker.importCookies(body);
        return sendResponse(res, result.ok ? 200 : 400, result);
      } catch (e) {
        return sendResponse(res, 400, { ok: false, error: e.message });
      }
    }

    if (apiPath === '/profile/import' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const newConfig = { ...worker.config };
        if (body.profile) newConfig.profile = body.profile;
        worker.saveConfig(newConfig);
        return sendResponse(res, 200, { ok: true });
      } catch (e) {
        return sendResponse(res, 400, { ok: false, error: e.message });
      }
    }

    // ── Health Check (for VPS Gateway) ──
    if (apiPath === '/health') {
      return sendResponse(res, 200, {
        ok: true,
        isRunning: worker.isRunning,
        uptimeSec: Math.floor(process.uptime()),
        mode: worker.config.mode,
      });
    }

    // ── VPS Gateway Status ──
    if (apiPath === '/vps-gateway-status' || apiPath === '/gateway-info') {
      const rawVpsUrl = process.env.VPS_URL || process.env.ORACLE_VPS_URL || req.headers['x-vps-url'];
      const vpsUrl = parseVpsUrl(rawVpsUrl);
      return sendResponse(res, 200, {
        ok: true,
        service: 'vercel-unified-gateway',
        vpsConfigured: Boolean(vpsUrl),
        vpsUrl: vpsUrl ? vpsUrl.replace(/:\/\/[^@]*@/, '://') : null,
        environment: process.env.NODE_ENV || 'production',
        timestamp: Date.now(),
      });
    }

    // ── Proxy to VPS if configured ──
    const rawVpsUrl = process.env.VPS_URL || process.env.ORACLE_VPS_URL || req.headers['x-vps-url'];
    const vpsUrl = parseVpsUrl(rawVpsUrl);

    if (vpsUrl) {
      const forwardQueryParams = new URLSearchParams(parsedReqUrl.searchParams);
      forwardQueryParams.delete('__path');
      const forwardQueryStr = forwardQueryParams.toString() ? '?' + forwardQueryParams.toString() : '';
      const targetEndpoint = `${vpsUrl}/api${apiPath}${forwardQueryStr}`;

      try {
        const targetParsed = new URL(targetEndpoint);
        const isHttps = targetParsed.protocol === 'https:';
        const client = isHttps ? https : http;

        const forwardHeaders = {};
        for (const [key, val] of Object.entries(req.headers || {})) {
          const lower = key.toLowerCase();
          if (!HOP_BY_HOP_HEADERS.has(lower)) {
            forwardHeaders[lower] = val;
          }
        }

        const apiSecret = process.env.VPS_API_SECRET || process.env.API_SECRET || req.headers['x-api-secret'] || req.headers['x-vps-key'];
        if (apiSecret) {
          forwardHeaders['x-api-secret'] = apiSecret;
        }

        let bodyBuffer = Buffer.alloc(0);
        if (['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
          bodyBuffer = await getRequestBody(req);
          if (bodyBuffer.length > 0) {
            forwardHeaders['content-length'] = bodyBuffer.length;
            if (!forwardHeaders['content-type']) {
              forwardHeaders['content-type'] = 'application/json';
            }
          } else {
            delete forwardHeaders['content-length'];
          }
        }

        const options = {
          method: req.method,
          hostname: targetParsed.hostname,
          port: targetParsed.port || (isHttps ? 443 : 80),
          path: targetParsed.pathname + targetParsed.search,
          headers: forwardHeaders,
          timeout: 25000,
        };

        const proxyReq = client.request(options, (proxyRes) => {
          if (typeof res.status === 'function') {
            res.status(proxyRes.statusCode || 200);
          } else {
            res.statusCode = proxyRes.statusCode || 200;
          }

          for (const [key, value] of Object.entries(proxyRes.headers)) {
            const lower = key.toLowerCase();
            if (!HOP_BY_HOP_HEADERS.has(lower) && !lower.startsWith('access-control-')) {
              try { res.setHeader(key, value); } catch (_) {}
            }
          }

          proxyRes.pipe(res);

          proxyRes.on('error', (err) => {
            if (!res.headersSent) {
              sendResponse(res, 502, { ok: false, error: 'Proxy stream error: ' + err.message });
            } else {
              try { res.end(); } catch (_) {}
            }
          });
        });

        req.on('close', () => {
          if (!proxyReq.destroyed) proxyReq.destroy();
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            sendResponse(res, 502, {
              ok: false,
              error: `Failed to reach VPS (${vpsUrl}): ${err.message}`,
              code: 'VPS_UNREACHABLE',
            });
          } else {
            try { res.end(); } catch (_) {}
          }
        });

        proxyReq.on('timeout', () => {
          proxyReq.destroy();
          if (!res.headersSent) {
            sendResponse(res, 504, {
              ok: false,
              error: `VPS at ${vpsUrl} timed out after 25s`,
              code: 'VPS_TIMEOUT'
            });
          } else {
            try { res.end(); } catch (_) {}
          }
        });

        if (bodyBuffer.length > 0) {
          proxyReq.write(bodyBuffer);
        }
        proxyReq.end();

      } catch (err) {
        return sendResponse(res, 500, {
          ok: false,
          error: 'Vercel API Gateway Error: ' + err.message
        });
      }
      return;
    }

    return sendResponse(res, 404, { ok: false, error: 'API endpoint not found' });
  }

  // ── 2. STATIC FILES ──
  let requestedFile = (pathname === '/' || pathname === '/index.html') ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.join(__dirname, requestedFile);

  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'public', requestedFile);
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'index.html');
  }

  try {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'text/html; charset=utf-8';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(content);
  } catch (e) {
    sendResponse(res, 404, 'File Not Found');
  }
};
