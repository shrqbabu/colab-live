# ⚡ Colab Pro VPS Manager (24/7 Playwright + Web Dashboard)

Google Colab ko VPS par **24/7 alive rakhne**, auto-reconnect karne, auto "Run All" (Ctrl+F9) chalane, aur **kisi bhi device se Web UI Dashboard** ke through monitor & control karne ka complete system.

---

## ✨ Features

- 🌐 **Modern Web UI Dashboard:** Kisi bhi phone, laptop ya PC se live VPS status dekhein.
- 🔐 **Password Protected Login:** Secure glassmorphic authentication system (Default: `admin@colab.pro` / `password123`).
- 🎮 **Full Remote Controls:**
  - `▶️ Start Worker` / `⏹️ Stop Worker` / `🔄 Restart Worker`
  - `⚡ Run All Cells (Ctrl+F9)` manually on demand
  - `🔌 Force Reconnect`
  - `📸 View Live Screen` (Playwright browser ka live screenshot dekhein)
- 📊 **Real-time Live Metrics:** Active session timer, total uptime, live Colab RAM & Disk utilization bars.
- 📟 **Live Streaming Terminal Logs:** Real-time console logs, error alerts, filter/search by keyword.
- 📥 **1-Click Extension Profile Import:** Chrome extension se exported JSON seedha web UI me paste karein.
- 🔄 **Auto-Reconnect & Keep-Alive:** Shadow DOM connect button clicker jo idle timeout aur runtime disconnect hone par khud reconnect karke cells run karta hai.

---

## 🚀 Setup & Run (VPS / Local)

### 1. Requirements Install Karein
```bash
npm install
npx playwright install chromium
```

### 2. Run Dashboard Server
```bash
npm start
```
Dashboard `http://YOUR_VPS_IP:3000` par start ho jayega.

---

## 🛡️ PM2 Ke Sath 24/7 Chalana (Recommended on VPS)

Agar aap chahte hain ki terminal band hone par ya VPS restart hone par bhi dashboard aur Playwright auto-chalta rahe:

```bash
# PM2 install (agar nahi hai)
npm install -g pm2

# 24/7 background me start karein
npm run vps

# Logs dekhne ke liye
pm2 logs colab-pro-vps

# Stop / Restart
pm2 restart colab-pro-vps
pm2 stop colab-pro-vps
```

---

## 🔑 Default Login Credentials
- **Email:** `admin@colab.pro`
- **Password:** `password123`
*(Aap dashboard ke settings panel se password kabhi bhi change kar sakte hain)*

---

## 📥 Chrome Extension Se Profile Kaise Daalein?
1. Chrome extension popup me **"📄 Save JSON"** button dabayein.
2. VPS Web Dashboard kholein aur **"📥 Import Chrome Profile JSON"** par click karein.
3. Download ki gayi JSON file ka text paste karke **Apply** karein.
4. Dashboard me **"▶️ Start Worker"** dabayein — Playwright usi profile aur notebook se connect ho jayega!
