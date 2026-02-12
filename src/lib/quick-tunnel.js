/**
 * Quick Tunnel Support (Cloudflare)
 *
 * Default behavior for no-DNS environments:
 * - lazily download cloudflared on first use (smallest viable binary path)
 * - start a quick tunnel to local A2A server
 * - persist tunnel metadata so invite generation can reuse it
 *
 * Intentionally minimal:
 * - no account-required managed tunnel flow yet
 * - no domain routing automation yet
 *
 * If owners need fixed hostnames or custom ingress, they can wire their own
 * proxy/tunnel and set A2A_HOSTNAME to that endpoint.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const CONFIG_DIR = process.env.A2A_CONFIG_DIR ||
  process.env.OPENCLAW_CONFIG_DIR ||
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const BIN_DIR = path.join(CONFIG_DIR, 'bin');
const CLOUDFLARED_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const TUNNEL_STATE_FILE = path.join(CONFIG_DIR, 'a2a-quick-tunnel.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (err) {
    return false;
  }
}

function commandExists(name) {
  const paths = String(process.env.PATH || '').split(path.delimiter);
  for (const p of paths) {
    const full = path.join(p, name);
    if (fs.existsSync(full) && isExecutable(full)) return full;
    if (process.platform === 'win32') {
      const exe = `${full}.exe`;
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    // Best effort.
  }
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

function resolveCloudflaredAssetName() {
  const arch = process.arch;
  const platform = process.platform;

  if (platform === 'linux') {
    if (arch === 'x64') return 'cloudflared-linux-amd64';
    if (arch === 'arm64') return 'cloudflared-linux-arm64';
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'cloudflared-darwin-amd64.tgz';
    if (arch === 'arm64') return 'cloudflared-darwin-arm64.tgz';
  }
  if (platform === 'win32' && arch === 'x64') {
    return 'cloudflared-windows-amd64.exe';
  }

  throw new Error(`cloudflared_unsupported_platform:${platform}-${arch}`);
}

function downloadFile(url, destination, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error('invalid_download_url'));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'a2acalling/quick-tunnel'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        downloadFile(res.headers.location, destination, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`download_failed_status_${status}`));
        return;
      }

      const tmp = `${destination}.download`;
      const out = fs.createWriteStream(tmp, { mode: 0o755 });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          fs.renameSync(tmp, destination);
          resolve(destination);
        });
      });
      out.on('error', (err) => {
        reject(err);
      });
    });

    req.on('error', reject);
  });
}

function extractTarGz(archivePath, outputDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', outputDir], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar_extract_failed:${stderr || code}`));
    });
  });
}

async function ensureCloudflaredBinary() {
  if (process.env.A2A_CLOUDFLARED_BIN && isExecutable(process.env.A2A_CLOUDFLARED_BIN)) {
    return { path: process.env.A2A_CLOUDFLARED_BIN, source: 'env' };
  }

  const systemPath = commandExists(process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (systemPath) {
    return { path: systemPath, source: 'system' };
  }

  if (fs.existsSync(CLOUDFLARED_BIN) && isExecutable(CLOUDFLARED_BIN)) {
    return { path: CLOUDFLARED_BIN, source: 'cached' };
  }

  ensureDir(BIN_DIR);
  const asset = resolveCloudflaredAssetName();
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  const downloadedPath = path.join(BIN_DIR, asset);

  await downloadFile(url, downloadedPath);

  if (asset.endsWith('.tgz')) {
    await extractTarGz(downloadedPath, BIN_DIR);
    try {
      fs.unlinkSync(downloadedPath);
    } catch (err) {
      // Best effort.
    }
  } else if (downloadedPath !== CLOUDFLARED_BIN) {
    fs.renameSync(downloadedPath, CLOUDFLARED_BIN);
  }

  if (!fs.existsSync(CLOUDFLARED_BIN)) {
    throw new Error('cloudflared_install_failed');
  }
  try {
    fs.chmodSync(CLOUDFLARED_BIN, 0o755);
  } catch (err) {
    // Best effort.
  }

  return { path: CLOUDFLARED_BIN, source: 'downloaded' };
}

function parseTryCloudflareUrl(line) {
  const match = String(line || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : null;
}

function readQuickTunnelState() {
  return readJson(TUNNEL_STATE_FILE);
}

function normalizeHostFromUrl(urlText) {
  try {
    const parsed = new URL(urlText);
    return parsed.host;
  } catch (err) {
    return '';
  }
}

async function startQuickTunnel(options = {}) {
  const localPort = Number.parseInt(String(options.localPort || 3001), 10) || 3001;
  const targetUrl = options.targetUrl || `http://127.0.0.1:${localPort}`;
  const timeoutMs = Number.parseInt(String(options.timeoutMs || 25000), 10) || 25000;
  const binary = options.binaryPath || (await ensureCloudflaredBinary()).path;

  const args = [
    'tunnel',
    '--url',
    targetUrl,
    '--no-autoupdate',
    '--protocol',
    'http2'
  ];

  const child = spawn(binary, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { process.kill(child.pid); } catch (err) {}
      reject(new Error('quick_tunnel_timeout'));
    }, timeoutMs);

    function handleLine(line) {
      const url = parseTryCloudflareUrl(line);
      if (!url || finished) return;
      finished = true;
      clearTimeout(timer);

      const host = normalizeHostFromUrl(url);
      const state = {
        pid: child.pid,
        url,
        host,
        local_port: localPort,
        target_url: targetUrl,
        started_at: new Date().toISOString(),
        binary
      };
      writeJson(TUNNEL_STATE_FILE, state);

      // Keep tunnel alive independently from caller process.
      child.unref();
      resolve({
        url,
        host,
        pid: child.pid,
        localPort,
        source: 'started'
      });
    }

    child.stdout.on('data', (chunk) => handleLine(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => handleLine(chunk.toString('utf8')));
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`quick_tunnel_exit_${code}`));
    });
  });
}

async function ensureQuickTunnel(options = {}) {
  const localPort = Number.parseInt(String(options.localPort || 3001), 10) || 3001;
  const state = readQuickTunnelState();
  if (state && state.url && state.host && state.local_port === localPort && isProcessAlive(state.pid)) {
    return {
      url: state.url,
      host: state.host,
      pid: state.pid,
      localPort,
      source: 'state'
    };
  }

  return startQuickTunnel({ ...options, localPort });
}

module.exports = {
  TUNNEL_STATE_FILE,
  ensureCloudflaredBinary,
  ensureQuickTunnel,
  readQuickTunnelState
};
