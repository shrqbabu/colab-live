// ============================================================
//  ⚡ Vercel Serverless Worker API Gateway
//  Proxies requests from Vercel UI to the Oracle VPS Automation Engine
// ============================================================

const http = require('http');
const https = require('https');
const { URL } = require('url');

module.exports = async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, X-VPS-URL, X-API-Secret, X-VPS-Key'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. Determine Oracle VPS URL
  let vpsUrl = process.env.VPS_URL || process.env.ORACLE_VPS_URL || req.headers['x-vps-url'];

  // Clean trailing slashes
  if (vpsUrl) {
    vpsUrl = vpsUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(vpsUrl)) {
      vpsUrl = 'http://' + vpsUrl;
    }
  }

  // 2. Gateway Health / Connection Config Info Route
  const rawUrl = req.url || '';
  const parsedPath = rawUrl.replace(/^\/api/, '') || '/';

  if (parsedPath === '/vps-gateway-status' || parsedPath === '/gateway-info') {
    return res.status(200).json({
      ok: true,
      service: 'vercel-worker-api-gateway',
      vpsConfigured: Boolean(vpsUrl),
      vpsUrl: vpsUrl ? vpsUrl.replace(/:\/\/[^@]*@/, '://') : null, // Mask any inline credentials
      environment: process.env.NODE_ENV || 'production',
      timestamp: Date.now()
    });
  }

  if (!vpsUrl) {
    return res.status(503).json({
      ok: false,
      error: 'Oracle VPS URL not configured. Set VPS_URL environment variable in Vercel or configure it in the Dashboard UI settings.',
      code: 'VPS_URL_MISSING',
      hint: 'Add VPS_URL=http://<YOUR_ORACLE_IP>:3000 to Vercel Environment Variables or click "⚙️ VPS Settings" in the dashboard.'
    });
  }

  // 3. Resolve Target Endpoint on Oracle VPS
  const targetEndpoint = `${vpsUrl}/api${parsedPath.startsWith('/') ? parsedPath : '/' + parsedPath}`;

  try {
    const targetParsed = new URL(targetEndpoint);
    const isHttps = targetParsed.protocol === 'https:';
    const client = isHttps ? https : http;

    // 4. Prepare Headers to forward
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders['x-vps-url']; // Do not leak custom header downstream
    
    // Attach secret if provided via env
    const apiSecret = process.env.VPS_API_SECRET || process.env.API_SECRET || req.headers['x-api-secret'] || req.headers['x-vps-key'];
    if (apiSecret) {
      forwardHeaders['x-api-secret'] = apiSecret;
    }

    // Read request body if present
    let bodyBuffer = null;
    if (['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
      if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
        bodyBuffer = Buffer.from(JSON.stringify(req.body));
        forwardHeaders['content-type'] = 'application/json';
        forwardHeaders['content-length'] = Buffer.byteLength(bodyBuffer);
      } else if (typeof req.body === 'string') {
        bodyBuffer = Buffer.from(req.body);
        forwardHeaders['content-length'] = Buffer.byteLength(bodyBuffer);
      } else if (Buffer.isBuffer(req.body)) {
        bodyBuffer = req.body;
        forwardHeaders['content-length'] = req.body.length;
      }
    }

    const options = {
      method: req.method,
      hostname: targetParsed.hostname,
      port: targetParsed.port || (isHttps ? 443 : 80),
      path: targetParsed.pathname + targetParsed.search,
      headers: forwardHeaders,
      timeout: 25000, // Vercel function safety timeout
    };

    const proxyReq = client.request(options, (proxyRes) => {
      // Set response status
      res.status(proxyRes.statusCode || 200);

      // Copy response headers
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        // Keep CORS controlled by Vercel
        if (!key.toLowerCase().startsWith('access-control-')) {
          res.setHeader(key, value);
        }
      }

      // Stream response chunks
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('Error forwarding request to Oracle VPS:', err.message);
      if (!res.headersSent) {
        res.status(502).json({
          ok: false,
          error: `Failed to reach Oracle VPS (${vpsUrl}): ${err.message}`,
          code: 'VPS_UNREACHABLE',
          hint: 'Ensure your Oracle Cloud VPS security list allows ingress on port 3000 and PM2 is running.'
        });
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({
          ok: false,
          error: `Oracle VPS at ${vpsUrl} timed out after 25s`,
          code: 'VPS_TIMEOUT'
        });
      }
    });

    if (bodyBuffer) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();

  } catch (err) {
    console.error('Proxy setup error:', err);
    return res.status(500).json({
      ok: false,
      error: 'Vercel API Gateway Error: ' + err.message
    });
  }
};
