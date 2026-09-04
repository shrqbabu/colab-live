// ============================================================
//  ⚡ Vercel Serverless Health Check
// ============================================================

module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'cloudshell-colab-vercel-gateway',
    status: 'online',
    timestamp: Date.now()
  });
};
