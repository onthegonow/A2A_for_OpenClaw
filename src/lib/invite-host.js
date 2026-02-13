/**
 * Invite Host Resolution
 *
 * Goal: produce a host:port that other agents can reach, even when the
 * local machine's hostname is not publicly resolvable.
 *
 * Strategy:
 * - Prefer explicit env `A2A_HOSTNAME`
 * - Else use config agent.hostname if present
 * - Else fall back to OS/env hostname
 *
 * If the selected hostname is clearly local/private/unroutable, replace
 * it with the machine's external IP (cached with TTL).
 */

const net = require('net');
const { getExternalIp } = require('./external-ip');

function readIntEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHostInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  // Accept accidental `http(s)://host:port` input.
  if (raw.includes('://')) {
    try {
      const parsed = new URL(raw);
      return parsed.host;
    } catch (err) {
      // fall through
    }
  }

  return raw.replace(/\/+$/, '');
}

function splitHostPort(rawHost) {
  const host = normalizeHostInput(rawHost);
  if (!host) return { hostname: '', port: null };

  // IPv6 in brackets: [::1]:3001
  const bracketed = host.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return {
      hostname: bracketed[1],
      port: bracketed[2] ? Number.parseInt(bracketed[2], 10) : null
    };
  }

  const lastColon = host.lastIndexOf(':');
  if (lastColon !== -1 && host.indexOf(':') === lastColon) {
    const maybePort = host.slice(lastColon + 1);
    if (/^\d+$/.test(maybePort)) {
      return {
        hostname: host.slice(0, lastColon),
        port: Number.parseInt(maybePort, 10)
      };
    }
  }

  return { hostname: host, port: null };
}

function formatHostPort(hostname, port) {
  const host = String(hostname || '').trim();
  const p = Number.isFinite(port) ? port : null;

  if (!host) return '';
  const needsBrackets = net.isIP(host) === 6;
  const hostPart = needsBrackets ? `[${host}]` : host;
  return p ? `${hostPart}:${p}` : hostPart;
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(n => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this" network
  if (a === 169 && b === 254) return true; // link-local
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // CGNAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isLocalOrUnroutableHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '0.0.0.0') return true;
  if (host === '::' || host === '::1') return true;
  if (host.endsWith('.local') || host.endsWith('.lan')) return true;

  const ipType = net.isIP(host);
  if (ipType === 4) return isPrivateIpv4(host);
  if (ipType === 6) {
    // Unique local (fc00::/7), link-local (fe80::/10), loopback.
    if (host === '::1') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    if (host.startsWith('fe80:')) return true;
    return false;
  }

  // Heuristic: bare hostnames without a dot are commonly local-only.
  if (!host.includes('.')) return true;

  return false;
}

function isPublicIpHostname(hostname) {
  const host = String(hostname || '').trim();
  const type = net.isIP(host);
  if (type === 4) return !isPrivateIpv4(host);
  // For IPv6: if it's a real v6 and not local per heuristic, treat as public.
  if (type === 6) return !isLocalOrUnroutableHost(host);
  return false;
}

function isEphemeralTunnelHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  // Quick tunnels (cloudflared) are not stable across restarts.
  if (host.endsWith('.trycloudflare.com')) return true;
  return false;
}

async function resolveInviteHost(options = {}) {
  const config = options.config || null;

  const envHost = normalizeHostInput(process.env.A2A_HOSTNAME);
  const cfgHost = normalizeHostInput(config && config.getAgent ? (config.getAgent().hostname || '') : '');
  const fallbackHost = normalizeHostInput(options.fallbackHost);
  const openclawHost = normalizeHostInput(process.env.OPENCLAW_HOSTNAME);
  const osHost = normalizeHostInput(process.env.HOSTNAME);

  const candidate = envHost || cfgHost || openclawHost || fallbackHost || osHost || 'localhost';
  const candidateSource = envHost
    ? 'env'
    : cfgHost
    ? 'config'
    : openclawHost
    ? 'openclaw_env'
    : fallbackHost
    ? 'fallback'
    : osHost
    ? 'os'
    : 'default';

  const parsed = splitHostPort(candidate);
  const desiredPort = parsed.port ||
    Number.parseInt(String(options.defaultPort || ''), 10) ||
    readIntEnv('PORT') ||
    readIntEnv('A2A_PORT') ||
    3001;

  const candidateHostWithPort = formatHostPort(parsed.hostname, desiredPort);

  const warnings = [];

  const ttlMs = Number.isFinite(options.externalIpTtlMs)
    ? options.externalIpTtlMs
    : undefined;

  const preferQuickTunnel = Boolean(options.preferQuickTunnel) ||
    String(process.env.A2A_PREFER_QUICK_TUNNEL || '').toLowerCase() === 'true';
  const quickTunnelDisabled = Boolean(options.disableQuickTunnel) ||
    String(process.env.A2A_DISABLE_QUICK_TUNNEL || '').toLowerCase() === 'true';

  // If a previous run persisted an ephemeral tunnel hostname into config (e.g. trycloudflare),
  // treat it like "unroutable" so we always refresh via tunnel/external IP instead of returning
  // a stale endpoint.
  const candidateIsEphemeralTunnel = candidateSource !== 'env' && isEphemeralTunnelHostname(parsed.hostname);

  const shouldReplaceWithExternalIp = isLocalOrUnroutableHost(parsed.hostname) ||
    candidateIsEphemeralTunnel || (
      options.refreshExternalIp && isPublicIpHostname(parsed.hostname)
    );

  if (!shouldReplaceWithExternalIp) {
    return {
      host: candidateHostWithPort,
      source: candidateSource,
      originalHost: candidateHostWithPort,
      warnings
    };
  }

  if (preferQuickTunnel && !quickTunnelDisabled) {
    try {
      const { ensureQuickTunnel } = require('./quick-tunnel');
      const tunnel = await ensureQuickTunnel({
        localPort: desiredPort
      });
      if (tunnel && tunnel.host) {
        const tunnelParsed = splitHostPort(tunnel.host);
        const finalHost = formatHostPort(tunnelParsed.hostname, tunnelParsed.port || 443);
        warnings.push(`Using secure Quick Tunnel endpoint "${finalHost}" for internet-facing invites.`);
        return {
          host: finalHost,
          source: 'quick_tunnel',
          originalHost: candidateHostWithPort,
          warnings
        };
      }
    } catch (err) {
      warnings.push(`Quick Tunnel unavailable (${err.message}). Falling back to external IP host detection.`);
    }
  }

  const external = await getExternalIp({
    ttlMs,
    timeoutMs: options.externalIpTimeoutMs,
    services: options.externalIpServices,
    cacheFile: options.externalIpCacheFile,
    forceRefresh: Boolean(options.forceRefreshExternalIp)
  });

  if (external && external.ip) {
    const finalHost = formatHostPort(external.ip, desiredPort);
    if (finalHost !== candidateHostWithPort) {
      warnings.push(
        `Invite host "${candidateHostWithPort}" looks local/unroutable. Using external IP "${finalHost}" instead.`
      );
    }
    return {
      host: finalHost,
      source: 'external_ip',
      originalHost: candidateHostWithPort,
      externalIp: external.ip,
      warnings
    };
  }

  warnings.push(
    `Invite host "${candidateHostWithPort}" may not be reachable from other machines, and external IP lookup failed. Set A2A_HOSTNAME="your-public-host:port".`
  );
  return {
    host: candidateHostWithPort,
    source: candidateSource,
    originalHost: candidateHostWithPort,
    warnings
  };
}

module.exports = {
  normalizeHostInput,
  splitHostPort,
  formatHostPort,
  isLocalOrUnroutableHost,
  resolveInviteHost
};
