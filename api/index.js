// Root API health endpoint
module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'colab-vps-vercel-gateway',
    status: 'online',
    timestamp: Date.now()
  });
};
