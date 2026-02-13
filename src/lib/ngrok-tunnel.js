/**
 * Tunnel Support (ngrok)
 *
 * This is intended for owners who want a more persistent tunnel setup (often with
 * a reserved domain) and are willing to provide an ngrok authtoken.
 *
 * Notes:
 * - We download the ngrok agent binary lazily on first use (like cloudflared).
 * - ngrok requires an authtoken (NGROK_AUTHTOKEN or A2A_NGROK_AUTHTOKEN).
 * - We discover the public URL via the local agent API (default 127.0.0.1:4040).
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
const NGROK_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'ngrok.exe' : 'ngrok');
const TUNNEL_STATE_FILE = path.join(CONFIG_DIR, 'a2a-ngrok-tunnel.json');

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

function resolveNgrokAssetName() {
  const arch = process.arch;
  const platform = process.platform;

  if (platform === 'linux') {
    if (arch === 'x64') return 'ngrok-v3-stable-linux-amd64.tgz';
    if (arch === 'arm64') return 'ngrok-v3-stable-linux-arm64.tgz';
    if (arch === 'arm') return 'ngrok-v3-stable-linux-arm.tgz';
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'ngrok-v3-stable-darwin-amd64.tgz';
    if (arch === 'arm64') return 'ngrok-v3-stable-darwin-arm64.tgz';
  }
  if (platform === 'win32' && arch === 'x64') {
    // We intentionally do not auto-extract zip on Windows here. Users can
    // provide A2A_NGROK_BIN or install ngrok in PATH.
    return 'ngrok-v3-stable-windows-amd64.zip';
  }

  throw new Error(`ngrok_unsupported_platform:${platform}-${arch}`);
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
        'User-Agent': 'a2acalling/ngrok-tunnel'
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
      const out = fs.createWriteStream(tmp, { mode: 0o600 });
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

async function ensureNgrokBinary() {
  const envPath = process.env.A2A_NGROK_BIN || process.env.NGROK_BIN;
  if (envPath && isExecutable(envPath)) {
    return { path: envPath, source: 'env' };
  }

  const systemPath = commandExists(process.platform === 'win32' ? 'ngrok.exe' : 'ngrok');
  if (systemPath) {
    return { path: systemPath, source: 'system' };
  }

  if (fs.existsSync(NGROK_BIN) && isExecutable(NGROK_BIN)) {
    return { path: NGROK_BIN, source: 'cached' };
  }

  ensureDir(BIN_DIR);
  const asset = resolveNgrokAssetName();
  const url = `https://bin.equinox.io/c/bNyj1mQVY4c/${asset}`;
  const downloadedPath = path.join(BIN_DIR, asset);

  await downloadFile(url, downloadedPath);

  if (asset.endsWith('.tgz')) {
    await extractTarGz(downloadedPath, BIN_DIR);
    try { fs.unlinkSync(downloadedPath); } catch (err) {}
  }

  if (!fs.existsSync(NGROK_BIN)) {
    // On Windows we don't unzip automatically; require an explicit binary path.
    if (asset.endsWith('.zip')) {
      throw new Error('ngrok_install_requires_manual_unzip');
    }
    throw new Error('ngrok_install_failed');
  }
  try { fs.chmodSync(NGROK_BIN, 0o755); } catch (err) {}

  return { path: NGROK_BIN, source: 'downloaded' };
}

function readNgrokTunnelState() {
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

function httpGetJson(urlText, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch (err) {
      reject(err);
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'a2acalling/ngrok-tunnel',
        'Accept': 'application/json'
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString('utf8'); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForNgrokPublicUrl({ localPort, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const apiBase = process.env.A2A_NGROK_API_URL || 'http://127.0.0.1:4040/api';
  const url = `${apiBase.replace(/\/+$/, '')}/tunnels`;

  while (Date.now() < deadline) {
    try {
      const body = await httpGetJson(url, 2000);
      const tunnels = Array.isArray(body.tunnels) ? body.tunnels : [];
      const candidates = tunnels
        .filter(t => typeof t?.public_url === 'string')
        .filter(t => t.public_url.startsWith('https://'));

      // Prefer tunnels targeting this port if addr is provided.
      const portMatch = candidates.find(t => {
        const addr = String(t?.config?.addr || '');
        return addr.includes(`:${localPort}`) || addr === String(localPort);
      });
      const chosen = portMatch || candidates[0] || null;
      if (chosen && chosen.public_url) {
        return chosen.public_url;
      }
    } catch (err) {
      // ignore until timeout
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error('ngrok_tunnel_timeout');
}

async function startNgrokTunnel(options = {}) {
  const localPort = Number.parseInt(String(options.localPort || 3001), 10) || 3001;
  const timeoutMs = Number.parseInt(String(options.timeoutMs || 25000), 10) || 25000;
  const binary = options.binaryPath || (await ensureNgrokBinary()).path;

  const authtoken = options.authtoken ||
    process.env.A2A_NGROK_AUTHTOKEN ||
    process.env.NGROK_AUTHTOKEN ||
    '';
  if (!authtoken) {
    throw new Error('ngrok_authtoken_required');
  }

  const tunnelUrl = options.url || process.env.A2A_NGROK_URL || '';

  const args = [
    'http',
    String(localPort),
    '--log',
    'stdout',
    '--log-format',
    'json',
    '--log-level',
    'info'
  ];
  if (tunnelUrl) {
    args.push('--url', tunnelUrl);
  }

  const child = spawn(binary, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NGROK_AUTHTOKEN: authtoken
    }
  });

  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { process.kill(child.pid); } catch (err) {}
      reject(new Error('ngrok_tunnel_timeout'));
    }, timeoutMs);

    function fail(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    }

    // ngrok is chatty; we ignore output and instead poll its local API.
    (async () => {
      try {
        const publicUrl = await waitForNgrokPublicUrl({ localPort, timeoutMs });
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        const host = normalizeHostFromUrl(publicUrl);
        const state = {
          pid: child.pid,
          url: publicUrl,
          host,
          local_port: localPort,
          started_at: new Date().toISOString(),
          binary,
          provider: 'ngrok'
        };
        writeJson(TUNNEL_STATE_FILE, state);

        child.unref();
        resolve({
          url: publicUrl,
          host,
          pid: child.pid,
          localPort,
          source: 'started'
        });
      } catch (err) {
        fail(err);
      }
    })();

    child.on('error', fail);
    child.on('exit', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`ngrok_tunnel_exit_${code}`));
    });
  });
}

async function ensureNgrokTunnel(options = {}) {
  const localPort = Number.parseInt(String(options.localPort || 3001), 10) || 3001;
  const state = readNgrokTunnelState();
  if (state && state.url && state.host && state.local_port === localPort && isProcessAlive(state.pid)) {
    return {
      url: state.url,
      host: state.host,
      pid: state.pid,
      localPort,
      source: 'state'
    };
  }

  return startNgrokTunnel({ ...options, localPort });
}

module.exports = {
  TUNNEL_STATE_FILE,
  ensureNgrokBinary,
  ensureNgrokTunnel,
  readNgrokTunnelState
};

