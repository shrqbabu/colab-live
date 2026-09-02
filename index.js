// ============================================================
//  ⚡ Vercel Serverless All-in-One Gateway & Dashboard Server
// ============================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
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

// Hop-by-hop headers to filter
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

  let pathname = '/';
  const matchedHeader = req.headers['x-matched-path'] || req.headers['x-forwarded-url'] || req.headers['x-original-url'];
  if (matchedHeader) {
    try {
      pathname = new URL(matchedHeader, 'http://localhost').pathname;
    } catch (_) {
      pathname = matchedHeader.split('?')[0];
    }
  } else if (req.url) {
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      pathname = req.url.split('?')[0];
    }
  }

  // If path is literally '/index.js' (and no matched-path header), treat as '/'
  if (pathname === '/index.js') {
    pathname = '/';
  }

  // ── 1. Handle API requests (/api/*) ──
  if (pathname.startsWith('/api/') || pathname === '/api') {
    const rawVpsUrl = process.env.VPS_URL || process.env.ORACLE_VPS_URL || req.headers['x-vps-url'];
    const vpsUrl = parseVpsUrl(rawVpsUrl);

    let parsedPath = pathname.replace(/^\/api/, '');
    if (!parsedPath.startsWith('/')) parsedPath = '/' + parsedPath;

    // Gateway Info Route
    if (parsedPath === '/vps-gateway-status' || parsedPath === '/gateway-info') {
      return sendResponse(res, 200, {
        ok: true,
        service: 'vercel-all-in-one-gateway',
        vpsConfigured: Boolean(vpsUrl),
        vpsUrl: vpsUrl ? vpsUrl.replace(/:\/\/[^@]*@/, '://') : null,
        environment: process.env.NODE_ENV || 'production',
        timestamp: Date.now(),
      });
    }

    if (!vpsUrl) {
      return sendResponse(res, 503, {
        ok: false,
        error: `Oracle VPS URL not configured or invalid (received: "${rawVpsUrl || ''}"). Please enter your valid VPS IP (e.g. http://68.233.113.7)`,
        code: 'VPS_URL_MISSING',
        hint: 'Add VPS_URL=http://68.233.113.7 to Vercel Environment Variables or configure it in "⚙️ VPS Settings" in the dashboard.',
      });
    }

    const queryString = parsedReqUrl.search || '';
    const targetEndpoint = `${vpsUrl}/api${parsedPath}${queryString}`;

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
            error: `Failed to reach Oracle VPS (${vpsUrl}): ${err.message}`,
            code: 'VPS_UNREACHABLE',
            hint: 'Ensure your Oracle Cloud VPS security list allows ingress on port 80 and PM2 is running.'
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
            error: `Oracle VPS at ${vpsUrl} timed out after 25s`,
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

  // ── 2. Handle Static Files (index.html, style.css, client.js) ──
  let requestedFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.join(__dirname, requestedFile);

  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'public', requestedFile);
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, 'public', 'index.html');
    }
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
