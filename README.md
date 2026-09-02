# ⚡ Colab Pro Manager (Oracle VPS Automation Engine + Vercel Web UI & Worker API)

Google Colab ko **24/7 alive rakhne**, auto-reconnect karne, auto "Run All" (Ctrl+F9) chalane, aur **Vercel** se hosted modern Web Dashboard + Worker API ke through remote control karne ka complete hybrid system.

---

## 🏗️ Architecture Overview

Is system ko 2 layers me decouple kiya gaya hai:

```
┌─────────────────────────────────────────────────────────────┐
│                    ☁️ VERCEL (Frontend & API)               │
│                                                             │
│   [ Modern Web UI Dashboard ]   [ Worker API Gateway ]      │
│   (HTML/CSS/JS on Vercel CDN)   (/api/* Serverless Proxy)   │
└──────────────────────────────┬──────────────────────────────┘
                               │ Secure HTTP / HTTPS / SSE
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              🏢 ORACLE CLOUD VPS (Automation Backend)       │
│                                                             │
│   [ Playwright Chromium ] ──> [ Google Colab Session ]      │
│   [ Keep-Alive & Reconnect ]                                │
│   [ VPS Node API Server (Port 3000) (PM2 Daemon) ]          │
└─────────────────────────────────────────────────────────────┘
```

1. **🏢 Oracle Cloud VPS (Automation Engine)**:
   - Headless Playwright Chromium browser jo Google Colab session ko 24/7 continuously active rakhta hai.
   - Profile / Google Session Cookies, auto "Run All", keepalive clicks, DOM monitoring, aur live viewport screenshot generation.
   - PM2 daemon ke under port 3000 par fast, secure REST/SSE API provide karta hai.

2. **☁️ Vercel (Worker API & Web Dashboard)**:
   - Lightning-fast global CDN pe hosted modern Glassmorphism Dashboard UI.
   - Vercel Serverless Gateway (`/api/*`) jo secure tareeqe se Oracle VPS backend ko bridge karta hai.
   - UI me built-in **"🌐 VPS Node"** connection switcher aur live latency/status monitoring.

---

## 🚀 Part 1: Oracle VPS Setup (Backend Logic)

### Step 1: VPS me code clone ya upload karein
```bash
git clone <YOUR_REPO_URL> colab-playwright
cd colab-playwright
```

### Step 2: 1-Command Automated VPS Setup chalayein
Humne Oracle VPS ke liye auto-installer script banayi hai:
```bash
chmod +x deploy-vps.sh
./deploy-vps.sh
```
*Yeh script Node.js 20, PM2, Playwright Chromium dependencies, aur firewall port 3000 khud configure kar degi.*

### Step 3: Check VPS Server Status
```bash
# Check PM2 processes
pm2 status

# View live logs
pm2 logs colab-pro-vps

# Check Health endpoint
curl http://localhost:3000/api/health
```

> [!NOTE]
> **Oracle Cloud Ingress Security List:**
> Make sure Oracle Cloud Console me apne VCN Security List me **Port 3000 (TCP)** Ingress Rule add karein taaki Vercel aapke VPS ko connect kar sake.

---

## 🌐 Part 2: Vercel Setup (Worker API & Web UI)

### Option A: Vercel CLI se Deploy karein
```bash
# Vercel CLI install karein (agar nahi hai)
npm install -g vercel

# Deploy command chalayein
vercel
```

### Option B: GitHub Repo se Vercel Dashboard pe Deploy karein
1. Apne repo ko GitHub pe push karein.
2. [Vercel Dashboard](https://vercel.com/new) par jaakar repo import karein.
3. **Environment Variables** section me yeh daalein:
   - `VPS_URL`: `http://YOUR_ORACLE_VPS_PUBLIC_IP:3000` (e.g. `http://140.238.10.55:3000`)
   - `VPS_API_SECRET` *(Optional)*: Aapka custom secret token.
4. **Deploy** button click karein.

---

## 🎮 Part 3: Dashboard se Control Karna

1. Apne Vercel link (`https://your-app.vercel.app`) ko kisi bhi mobile ya computer browser me kholein.
2. **Login Credentials:**
   - **Email:** `admin@colab.pro`
   - **Password:** `password123` *(Settings me jaakar change kar sakte hain)*
3. Top Navbar me **"🌐 VPS Node"** indicator check karein. Agar green `Oracle VPS: Online` dikhe, toh Vercel aapke Oracle VPS se connected hai!
4. **Controls:**
   - `▶️ Start Worker` / `⏹️ Stop Worker` / `🔄 Restart Worker`
   - `⚡ Run All Cells (Ctrl+F9)` manually on demand
   - `📸 View Live Screen` (Playwright browser ka live snapshot dekhein)
   - `🍪 Google Session Cookies` (Cookie-Editor extension se JSON paste karein bina password Google login ke liye)

---

## 📁 File Structure

```
colab-playwright/
├── api/                    # ☁️ Vercel Serverless Worker API
│   ├── [...path].js        # Intelligent proxy gateway to Oracle VPS
│   └── index.js            # Root health handler
├── public/                 # 🌐 Web UI Dashboard (Hosted on Vercel)
│   ├── index.html          # Dashboard HTML + VPS settings modal
│   ├── style.css           # Modern Glassmorphism dark theme
│   └── app.js              # Client application & live VPS health monitor
├── worker.js               # 🤖 Playwright Automation Logic (Runs on Oracle VPS)
├── colab_keeper.js         # Standalone Playwright keeper script
├── server.js               # 🏢 Oracle VPS Node.js API Server
├── deploy-vps.sh           # 🚀 Automated Oracle VPS Setup & dependency script
├── ecosystem.config.js     # PM2 configuration for 24/7 daemon on VPS
├── vercel.json             # Vercel routing & serverless configuration
├── config.json             # Worker settings & parameters
└── .env.example            # Environment variables template
```

---

## 🔐 Security Best Practices
- VPS backend ko secure karne ke liye `.env` me `API_SECRET` set karein aur Vercel me `VPS_API_SECRET` same value daalein.
- Dashboard password ko pehle login ke baad Settings se zaroor badal lein.
