// ============================================================
//  ⚡ Vercel Serverless Worker API Gateway
//  Proxies requests from Vercel UI to the Oracle VPS Automation Engine
// ============================================================

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Headers that must never be proxied (RFC 2616 / RFC 7230)
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

function sendResponse(res, statusCode, body, headers = {}) {
  if (res.headersSent) return;
  for (const [k, v] of Object.entries(headers)) {
    try {
      res.setHeader(k, v);
    } catch (_) {}
  }
  if (typeof res.status === 'function') {
    res.status(statusCode);
  } else {
    res.statusCode = statusCode;
  }
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    try {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    } catch (_) {}
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

  // If stream is already completed, closed or unreadable, return empty buffer immediately
  if (req.readableEnded || req.complete || req.readable === false) {
    return Buffer.alloc(0);
  }

  // If streaming body, read with strict timeout to prevent infinite function hangs
  return new Promise((resolve) => {
    const chunks = [];
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(Buffer.concat(chunks));
      }
    }, 1500);

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve(Buffer.alloc(0));
      }
    });
  });
}

function parseVpsUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;
  // If it's just 'http:', 'http://', 'https:', 'https://', 'undefined', 'null'
  if (/^https?:\/*$/i.test(raw) || raw === 'undefined' || raw === 'null') {
    return null;
  }
  // Ensure http:// or https:// prefix
  if (!/^https?:\/\//i.test(raw)) {
    raw = 'http://' + raw;
  }
  // Remove trailing slashes
  raw = raw.replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    if (!u.hostname || u.hostname === 'http' || u.hostname === 'https' || u.hostname.length < 2) {
      return null;
    }
    return u.origin;
  } catch (_) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  // Enable CORS
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
    if (typeof res.status === 'function') {
      return res.status(200).end();
    }
    res.statusCode = 200;
    return res.end();
  }

  // 1. Determine Oracle VPS URL
  const rawVpsUrl = process.env.VPS_URL || process.env.ORACLE_VPS_URL || req.headers['x-vps-url'];
  const vpsUrl = parseVpsUrl(rawVpsUrl);

  // 2. Resolve Path from Vercel dynamic catch-all route (req.query.path) or req.url
  let parsedPath = '';
  if (req.query && req.query.path) {
    if (Array.isArray(req.query.path)) {
      parsedPath = '/' + req.query.path.join('/');
    } else {
      parsedPath = '/' + req.query.path;
    }
  } else {
    const rawPath = (req.url || '').split('?')[0];
    parsedPath = rawPath.replace(/^\/api(\/\[\.\.\.path\])?/, '') || '/';
    if (!parsedPath.startsWith('/')) parsedPath = '/' + parsedPath;
  }

  // Clean extra /api prefixes if present
  if (parsedPath.startsWith('/api/')) {
    parsedPath = parsedPath.replace(/^\/api/, '');
  }

  // Preserve query string (excluding Vercel's internal path parameter)
  let queryString = '';
  if (req.query) {
    const queryParams = new URLSearchParams();
    for (const [key, val] of Object.entries(req.query)) {
      if (key !== 'path') {
        if (Array.isArray(val)) {
          val.forEach((v) => queryParams.append(key, v));
        } else {
          queryParams.append(key, val);
        }
      }
    }
    const qs = queryParams.toString();
    if (qs) queryString = '?' + qs;
  }

  // Gateway Info Route
  if (parsedPath === '/vps-gateway-status' || parsedPath === '/gateway-info') {
    return sendResponse(res, 200, {
      ok: true,
      service: 'vercel-worker-api-gateway',
      vpsConfigured: Boolean(vpsUrl),
      vpsUrl: vpsUrl ? vpsUrl.replace(/:\/\/[^@]*@/, '://') : null,
      environment: process.env.NODE_ENV || 'production',
      timestamp: Date.now(),
    });
  }

  if (!vpsUrl) {
    return sendResponse(res, 503, {
      ok: false,
      error: `Oracle VPS URL not configured or invalid (received: "${rawVpsUrl || ''}"). Please enter your valid VPS IP or domain, e.g. http://123.45.67.89`,
      code: 'VPS_URL_MISSING',
      hint: 'Add VPS_URL=http://<YOUR_ORACLE_IP> to Vercel Environment Variables or click "⚙️ VPS Settings" in the dashboard.',
    });
  }

  // 3. Resolve Target Endpoint on Oracle VPS
  const targetEndpoint = `${vpsUrl}/api${parsedPath.startsWith('/') ? parsedPath : '/' + parsedPath}${queryString}`;

  try {
    const targetParsed = new URL(targetEndpoint);
    const isHttps = targetParsed.protocol === 'https:';
    const client = isHttps ? https : http;

    // 4. Prepare Headers to forward
    const forwardHeaders = {};
    for (const [key, val] of Object.entries(req.headers || {})) {
      const lower = key.toLowerCase();
      if (!HOP_BY_HOP_HEADERS.has(lower)) {
        forwardHeaders[lower] = val;
      }
    }

    // Attach secret if provided via env
    const apiSecret = process.env.VPS_API_SECRET || process.env.API_SECRET || req.headers['x-api-secret'] || req.headers['x-vps-key'];
    if (apiSecret) {
      forwardHeaders['x-api-secret'] = apiSecret;
    }

    // Read request body safely without hanging
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
      // Set response status
      if (typeof res.status === 'function') {
        res.status(proxyRes.statusCode || 200);
      } else {
        res.statusCode = proxyRes.statusCode || 200;
      }

      // Copy response headers (excluding hop-by-hop & CORS headers)
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        const lower = key.toLowerCase();
        if (!HOP_BY_HOP_HEADERS.has(lower) && !lower.startsWith('access-control-')) {
          try {
            res.setHeader(key, value);
          } catch (_) {}
        }
      }

      // Stream response chunks
      proxyRes.pipe(res);

      proxyRes.on('error', (err) => {
        console.error('Proxy response stream error:', err.message);
        if (!res.headersSent) {
          sendResponse(res, 502, { ok: false, error: 'Proxy stream error: ' + err.message });
        } else {
          try { res.end(); } catch (_) {}
        }
      });
    });

    req.on('close', () => {
      if (!proxyReq.destroyed) {
        proxyReq.destroy();
      }
    });

    proxyReq.on('error', (err) => {
      console.error('Error forwarding request to Oracle VPS:', err.message);
      if (!res.headersSent) {
        sendResponse(res, 502, {
          ok: false,
          error: `Failed to reach Oracle VPS (${vpsUrl}): ${err.message}`,
          code: 'VPS_UNREACHABLE',
          hint: 'Ensure your Oracle Cloud VPS security list allows ingress on port 80 (or 3000) and PM2 is running.'
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
    console.error('Proxy setup error:', err);
    return sendResponse(res, 500, {
      ok: false,
      error: 'Vercel API Gateway Error: ' + err.message
    });
  }
};
