#!/usr/bin/env bash
# ============================================================
#  🚀 Google Cloud Shell 24/7 Automation — VPS Auto Installer
# ============================================================

set -e

echo "========================================================"
echo "  Google Cloud Shell 24/7 Automation Installer"
echo "========================================================"

# 1. Update & dependencies
echo "Updating packages..."
sudo apt-get update -y
sudo apt-get install -y curl wget git build-essential

# 2. Node.js 20.x setup
if ! command -v node &> /dev/null; then
    echo "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 3. PM2 installation
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2 process manager..."
    sudo npm install -g pm2
fi

# 4. Install Project dependencies & Playwright Chromium
echo "Installing project dependencies..."
npm install

echo "Installing Playwright Chromium and system dependencies..."
npx playwright install --with-deps chromium

# 5. Start with PM2
echo "Starting Cloud Shell Manager with PM2..."
pm2 start ecosystem.config.js
pm2 save

echo "========================================================"
echo "  ✅ Installation & Deployment Complete!"
echo "  Dashboard running on: http://<YOUR_VPS_IP>:8080"
echo "  Logs: pm2 logs cloudshell-omniroute-manager"
echo "========================================================"
