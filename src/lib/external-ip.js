/**
 * External IP Resolver (Cached)
 *
 * When generating invites, we want a host that other agents can reach.
 * This module fetches the machine's public (egress) IP from a few
 * "what is my IP" services and caches the result to avoid repeated
 * network calls.
 *
 * Cache file: ~/.config/openclaw/a2a-external-ip.json (or A2A_CONFIG_DIR)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');

const CONFIG_DIR = process.env.A2A_CONFIG_DIR ||
  process.env.OPENCLAW_CONFIG_DIR ||
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const EXTERNAL_IP_CACHE_FILE = path.join(CONFIG_DIR, 'a2a-external-ip.json');

const DEFAULT_SERVICES = [
  'https://ifconfig.me/ip',
  'https://api.ipify.org',
  'https://checkip.amazonaws.com/',
  'https://icanhazip.com/'
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    // Best effort.
  }
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function parseIp(text) {
  const candidate = String(text || '')
    .trim()
    .replace(/^"+|"+$/g, '')
    .split(/\s+/)[0];
  if (!candidate) return null;
  return net.isIP(candidate) ? candidate : null;
}

function requestText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error('invalid_url'));
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
        'User-Agent': `a2acalling/${process.env.npm_package_version || 'dev'} (external-ip)`
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 4096) {
          req.destroy(new Error('response_too_large'));
        }
      });

      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });

    req.end();
  });
}

async function fetchExternalIp(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2500;
  const services = Array.isArray(options.services) && options.services.length
    ? options.services
    : DEFAULT_SERVICES;

  const attempts = [];
  let lastError = null;
  for (const serviceUrl of services) {
    try {
      const res = await requestText(serviceUrl, timeoutMs);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`bad_status_${res.statusCode}`);
      }
      const ip = parseIp(res.body);
      if (!ip) {
        throw new Error('invalid_ip');
      }
      attempts.push({ service: serviceUrl, ok: true, statusCode: res.statusCode, ip });
      return { ip, source: serviceUrl, attempts };
    } catch (err) {
      lastError = err;
      attempts.push({ service: serviceUrl, ok: false, error: err && err.message ? err.message : 'request_failed' });
    }
  }

  const msg = lastError ? lastError.message : 'unavailable';
  const failure = new Error(`external_ip_unavailable:${msg}`);
  failure.attempts = attempts;
  throw failure;
}

/**
 * Get external IP, using cached result if not stale.
 *
 * Returns:
 *   { ip, checkedAt, source, fromCache, stale }
 * or:
 *   { ip: null, error }
 */
async function getExternalIp(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs)
    ? options.ttlMs
    : Number.parseInt(process.env.A2A_EXTERNAL_IP_TTL_MS || '', 10) || (6 * 60 * 60 * 1000);
  const cacheFile = options.cacheFile || EXTERNAL_IP_CACHE_FILE;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  const cached = readJson(cacheFile);
  if (cached && cached.ip && cached.checked_at) {
    const cachedIp = parseIp(cached.ip);
    const checkedAtMs = Date.parse(cached.checked_at);
    if (cachedIp && Number.isFinite(checkedAtMs)) {
      const ageMs = Math.max(0, nowMs - checkedAtMs);
      if (ageMs <= ttlMs && !options.forceRefresh) {
        return {
          ip: cachedIp,
          checkedAt: cached.checked_at,
          source: cached.source || 'cache',
          fromCache: true,
          stale: false
        };
      }
    }
  }

  try {
    const { ip, source, attempts } = await fetchExternalIp({
      timeoutMs: options.timeoutMs,
      services: options.services
    });
    const checkedAt = new Date(nowMs).toISOString();
    atomicWriteJson(cacheFile, { ip, checked_at: checkedAt, source });
    return { ip, checkedAt, source, fromCache: false, stale: false, attempts: Array.isArray(attempts) ? attempts : null };
  } catch (err) {
    if (cached && cached.ip) {
      const cachedIp = parseIp(cached.ip);
      if (cachedIp) {
        return {
          ip: cachedIp,
          checkedAt: cached.checked_at || null,
          source: cached.source || 'cache',
          fromCache: true,
          stale: true,
          error: err && err.message ? err.message : 'external_ip_unavailable',
          attempts: err && Array.isArray(err.attempts) ? err.attempts : null
        };
      }
    }
    return {
      ip: null,
      error: err && err.message ? err.message : 'external_ip_unavailable',
      attempts: err && Array.isArray(err.attempts) ? err.attempts : null
    };
  }
}

module.exports = {
  EXTERNAL_IP_CACHE_FILE,
  fetchExternalIp,
  getExternalIp
};
