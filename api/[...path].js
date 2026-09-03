// ============================================================
//  ⚡ Vercel Serverless Route Handler — Forward to Unified index.js
// ============================================================

const rootHandler = require('../index.js');

module.exports = function handler(req, res) {
  return rootHandler(req, res);
};
