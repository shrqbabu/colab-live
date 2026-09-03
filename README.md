# 🌐 Google Cloud Shell & Colab 24/7 Automation Manager

Playwright-based automation system to keep **Google Cloud Shell** and **Google Colab** running 24/7 with persistent profiles, dynamic links, and real-time dashboard controls.

---

## ✨ Features

1. **Dual Workspace Support (Colab & Cloud Shell)**:
   - **Cloud Shell Mode**: Opens dynamic Cloud Shell link, waits 1 minute (60s), sends `docker start omniroute`, remains in passive mode with **ZERO clicks** during active session, checks every 10 minutes, and auto-reconnects on disconnection.
   - **Colab Mode**: Opens dynamic Colab notebook link, dismisses Google Drive / modal dialogs, clicks connect, runs all cells (`Ctrl+F9`), extracts RAM & Disk metrics, and sends keep-alive signals to prevent idle timeouts.

2. **Persistent Profile & Single-Time Cookies**:
   - Enter your Google cookies **only once**.
   - Cookies and browser context are permanently saved to `profile/` and `cookies_saved.json`.
   - Even when you stop the browser or restart the VPS, it **automatically continues using your saved profile** without prompting again.

3. **Dynamic Links**:
   - Easily change and save the target URL directly from the Web Dashboard.

4. **Web Dashboard & REST API**:
   - Switch between **Google Cloud Shell** and **Google Colab** with one click.
   - Live SSE log streaming, real-time screenshots, and terminal command sender.

---

## 🚀 Quick Setup

### 1. Install Dependencies
```bash
cd cloudshell-playwright
npm install
npx playwright install chromium
```

### 2. Import Cookies (Only Once!)
1. Open Chrome and log into your Google account on [Google Cloud Shell](https://shell.cloud.google.com/) or [Google Colab](https://colab.research.google.com/).
2. Use the **Cookie-Editor** Chrome extension ➔ Click **Export** ➔ **Export as JSON**.
3. Save to `cookies.json` and run:
```bash
node import-cookies.js cookies.json
```
*(You can also paste the JSON directly into the "Cookies & Profile" button on the Web Dashboard!)*

---

## 🎯 Running the Manager

### Web Dashboard & Server (Recommended):
```bash
npm start
```
Open **`http://localhost:8080`** in your browser.

### Standalone CLI Keeper:
```bash
npm run keeper
```

### 24/7 Background Service (VPS / Server):
```bash
npm run vps
# or
pm2 start ecosystem.config.js
```
