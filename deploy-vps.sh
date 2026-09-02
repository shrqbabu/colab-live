#!/usr/bin/env bash
# ============================================================
#  🚀 Oracle Cloud VPS Automated Setup Script
#  Installs Node.js 20, PM2, Playwright, Chromium & dependencies
# ============================================================

set -e

echo "========================================================"
echo "⚡ Setting up Colab Automation Engine on Oracle Cloud VPS"
echo "========================================================"

# 1. Update OS Packages
if command -v apt-get >/dev/null 2>&1; then
    echo "📦 Detected Ubuntu/Debian. Updating system packages..."
    sudo apt-get update -y && sudo apt-get upgrade -y
    sudo apt-get install -y curl wget git unzip xvfb libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 libcups2 libdrm2
elif command -v dnf >/dev/null 2>&1; then
    echo "📦 Detected Oracle Linux / RHEL / Fedora. Updating packages..."
    sudo dnf update -y
    sudo dnf install -y curl wget git unzip xorg-x11-server-Xvfb nss atk libXcomposite libXdamage libXrandr mesa-libgbm alsa-lib pango cups-libs
fi

# 2. Install Node.js 20 LTS if not present
if ! command -v node >/dev/null 2>&1; then
    echo "🟢 Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs || sudo dnf install -y nodejs
fi

echo "✅ Node.js Version: $(node -v)"
echo "✅ NPM Version: $(npm -v)"

# 3. Install PM2 Globally
if ! command -v pm2 >/dev/null 2>&1; then
    echo "🟢 Installing PM2 Process Manager..."
    sudo npm install -g pm2
fi

# 4. Install Project NPM Dependencies
echo "📦 Installing project dependencies..."
npm install

# 5. Install Playwright & Chromium with System Dependencies
echo "🌐 Installing Playwright Chromium & system libraries..."
npx playwright install --with-deps chromium

# 6. Configure Oracle Cloud Linux Firewall for Port 3000
echo "🛡️ Configuring firewall for port 3000..."
if command -v iptables >/dev/null 2>&1; then
    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT || true
    sudo netfilter-persistent save || true
fi
if command -v ufw >/dev/null 2>&1; then
    sudo ufw allow 3000/tcp || true
fi
if command -v firewall-cmd >/dev/null 2>&1; then
    sudo firewall-cmd --zone=public --add-port=3000/tcp --permanent || true
    sudo firewall-cmd --reload || true
fi

# 7. Start with PM2
echo "🚀 Starting server with PM2..."
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "========================================================"
echo "🎉 Setup Complete! Oracle VPS Automation Server is Running"
echo "========================================================"
echo "👉 Public API Endpoint: http://$(curl -s ifconfig.me):3000"
echo "👉 Health Check:        http://$(curl -s ifconfig.me):3000/api/health"
echo "👉 PM2 Status:          pm2 status"
echo "👉 PM2 Logs:            pm2 logs colab-pro-vps"
echo "========================================================"
echo "Next: Put this Public URL (http://<IP>:3000) into your Vercel Environment Variables as VPS_URL"
