import os
import sys
import time
import atexit
import threading
import subprocess
import urllib.request
import urllib.error
import json
import shutil
from contextlib import asynccontextmanager

# ==========================================
# 0. ZeroGPU Compatibility Check
# ==========================================
try:
    import spaces

    @spaces.GPU
    def _hf_zerogpu_stub():
        return "gpu_ready"

    _ = _hf_zerogpu_stub()
except Exception:
    pass


def log(msg):
    print(f"🌐 [CloudShell-Colab HF Gateway] {msg}", flush=True)


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(CURRENT_DIR)

# 1. Environment config
NODE_PORT = 8080
os.environ["PORT"] = str(NODE_PORT)
os.environ["HOST"] = "0.0.0.0"
os.environ["HOSTNAME"] = "0.0.0.0"
os.environ["NODE_ENV"] = os.environ.get("NODE_ENV", "production")
os.environ["GRADIO_SSR_MODE"] = "false"
os.environ["HEADLESS"] = "true"

# 2. Check / Install Node.js
node_bin = shutil.which("node")
npm_bin = shutil.which("npm")
npx_bin = shutil.which("npx")

if not node_bin or not npm_bin:
    NODE_DIR = os.path.expanduser("~/nodejs")
    CUSTOM_BIN = os.path.join(NODE_DIR, "bin")
    node_bin = os.path.join(CUSTOM_BIN, "node")
    npm_bin = os.path.join(CUSTOM_BIN, "npm")
    npx_bin = os.path.join(CUSTOM_BIN, "npx")

    if not os.path.exists(node_bin):
        log("Downloading portable Node.js 20 LTS for Linux x64...")
        url = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz"
        tar_path = "/tmp/node.tar.xz"
        urllib.request.urlretrieve(url, tar_path)
        os.makedirs(NODE_DIR, exist_ok=True)
        subprocess.run(
            ["tar", "-xf", tar_path, "--strip-components=1", "-C", NODE_DIR],
            check=True,
        )
        log("Node.js 20 LTS installed!")

    os.environ["PATH"] = f"{CUSTOM_BIN}:{os.environ.get('PATH', '')}"

log(f"Using Node: {node_bin}")

# 3. Install npm dependencies
node_modules_path = os.path.join(CURRENT_DIR, "node_modules")
if not os.path.exists(node_modules_path):
    log("Installing npm dependencies...")
    subprocess.run([npm_bin, "install", "--omit=dev"], cwd=CURRENT_DIR, check=True)
    log("npm dependencies installed!")

# 4. Install Playwright Chromium browser
playwright_marker = os.path.join(CURRENT_DIR, ".playwright_installed")
if not os.path.exists(playwright_marker):
    log("Installing Playwright Chromium browser...")
    subprocess.run(
        [npx_bin, "playwright", "install", "--with-deps", "chromium"],
        cwd=CURRENT_DIR,
        check=True,
    )
    # Mark as installed so we don't re-download on every restart
    with open(playwright_marker, "w") as f:
        f.write("installed")
    log("Playwright Chromium installed!")

# 5. Inject Google cookies from HF Secret (GOOGLE_COOKIES) into cookies_saved.json
cookies_saved_path = os.path.join(CURRENT_DIR, "cookies_saved.json")
env_cookies = os.environ.get("GOOGLE_COOKIES", "").strip()
if env_cookies and not os.path.exists(cookies_saved_path):
    try:
        parsed = json.loads(env_cookies)
        if isinstance(parsed, list) and len(parsed) > 0:
            with open(cookies_saved_path, "w", encoding="utf-8") as f:
                json.dump(parsed, f, indent=2)
            log(f"Wrote {len(parsed)} cookies from GOOGLE_COOKIES secret to cookies_saved.json")
    except Exception as e:
        log(f"Warning: Could not parse GOOGLE_COOKIES env: {e}")

# 6. Start Node.js server on internal port 8080
server_script = os.path.join(CURRENT_DIR, "server.js")
node_process = None
_shutting_down = False


def start_node():
    global node_process
    log(f"Starting Node.js server on 127.0.0.1:{NODE_PORT}...")
    node_process = subprocess.Popen(
        [node_bin, server_script],
        cwd=CURRENT_DIR,
        env={**os.environ, "PORT": str(NODE_PORT)},
    )
    return node_process


def wait_for_node(retries=30):
    for _ in range(retries):
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{NODE_PORT}/api/health", timeout=2
            ):
                return True
        except urllib.error.HTTPError:
            return True
        except Exception:
            time.sleep(2)
    return False


def watch_node():
    while not _shutting_down:
        time.sleep(5)
        if _shutting_down:
            break
        if node_process is not None and node_process.poll() is not None:
            log(f"Node.js exited with code {node_process.returncode}, restarting...")
            try:
                start_node()
            except Exception as e:
                log(f"Failed to restart Node.js: {e}")


def stop_node():
    global _shutting_down
    _shutting_down = True
    if node_process is not None and node_process.poll() is None:
        log("Stopping Node.js backend...")
        node_process.terminate()
        try:
            node_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            node_process.kill()


atexit.register(stop_node)

start_node()
if wait_for_node():
    log("✅ Node.js backend is active and responding!")
else:
    log("⚠️ Node.js backend did not respond in time (watchdog will keep monitoring).")

threading.Thread(target=watch_node, daemon=True).start()

# 7. FastAPI Reverse Proxy (7860 -> 8080)
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import httpx
import uvicorn

NODE_BASE_URL = f"http://127.0.0.1:{NODE_PORT}"

_http_client = None


def get_client():
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=180.0,
            limits=httpx.Limits(max_keepalive_connections=50, max_connections=200),
        )
    return _http_client


async def proxy_to_node(request: Request):
    path = request.url.path
    query = request.url.query
    target_url = f"{NODE_BASE_URL}{path}"
    if query:
        target_url += f"?{query}"

    req_headers = dict(request.headers)
    original_host = request.headers.get("host") or "localhost"
    req_headers["x-forwarded-host"] = original_host
    req_headers["x-forwarded-proto"] = "https"
    req_headers.pop("host", None)
    req_headers.pop("content-length", None)

    client = get_client()
    try:
        body = await request.body()
        node_req = client.build_request(
            method=request.method,
            url=target_url,
            headers=req_headers,
            content=body,
        )
        node_resp = await client.send(node_req, stream=True)
        resp_headers = dict(node_resp.headers)
        # Remove hop-by-hop headers that cause issues
        for h in ["transfer-encoding", "content-encoding", "content-length"]:
            resp_headers.pop(h, None)
        return StreamingResponse(
            node_resp.aiter_raw(),
            status_code=node_resp.status_code,
            headers=resp_headers,
            background=node_resp.aclose,
        )
    except Exception as e:
        return Response(
            content=json.dumps({"error": f"Backend proxy error: {str(e)}"}),
            status_code=502,
            media_type="application/json",
        )


@asynccontextmanager
async def lifespan_handler(app: FastAPI):
    yield
    stop_node()
    if _http_client is not None and not _http_client.is_closed:
        await _http_client.aclose()


fastapi_app = FastAPI(
    title="CloudShell-Colab Automation Gateway",
    lifespan=lifespan_handler,
)

# Proxy ALL routes to Node.js (dashboard, API, static files, SSE)
fastapi_app.add_api_route(
    "/{full_path:path}",
    proxy_to_node,
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"],
)

# Also handle root path "/"
fastapi_app.add_api_route(
    "/",
    proxy_to_node,
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"],
)

if __name__ == "__main__":
    log("🚀 Starting HF Gateway on 0.0.0.0:7860 -> Node.js 8080...")
    uvicorn.run(
        fastapi_app,
        host="0.0.0.0",
        port=7860,
        log_level="info",
        lifespan="on",
    )
