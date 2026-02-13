/**
 * Tunnel provider selection for internet-facing invites.
 *
 * Providers:
 * - cloudflare (quick tunnel, no account required) via ./quick-tunnel
 * - ngrok (requires authtoken) via ./ngrok-tunnel
 *
 * Selection:
 * - A2A_TUNNEL_PROVIDER=auto|cloudflare|ngrok (default: auto)
 * - auto chooses ngrok if an authtoken is present, otherwise cloudflare.
 */

function normalizeProvider(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === 'quick' || raw === 'quick_tunnel' || raw === 'cloudflared') return 'cloudflare';
  return raw;
}

function hasNgrokAuthtoken() {
  return Boolean(process.env.A2A_NGROK_AUTHTOKEN || process.env.NGROK_AUTHTOKEN);
}

function resolveProviderFromEnv() {
  return normalizeProvider(process.env.A2A_TUNNEL_PROVIDER || 'auto');
}

async function ensureTunnel(options = {}) {
  const requested = normalizeProvider(options.provider || resolveProviderFromEnv());

  if (requested === 'auto') {
    if (hasNgrokAuthtoken()) {
      try {
        const { ensureNgrokTunnel } = require('./ngrok-tunnel');
        const tunnel = await ensureNgrokTunnel(options);
        return { ...tunnel, provider: 'ngrok' };
      } catch (err) {
        const { ensureQuickTunnel } = require('./quick-tunnel');
        const tunnel = await ensureQuickTunnel(options);
        return {
          ...tunnel,
          provider: 'cloudflare',
          warnings: [`ngrok tunnel failed (${err.message}); falling back to cloudflare quick tunnel`]
        };
      }
    }
    const { ensureQuickTunnel } = require('./quick-tunnel');
    const tunnel = await ensureQuickTunnel(options);
    return { ...tunnel, provider: 'cloudflare' };
  }

  if (requested === 'ngrok') {
    const { ensureNgrokTunnel } = require('./ngrok-tunnel');
    const tunnel = await ensureNgrokTunnel(options);
    return { ...tunnel, provider: 'ngrok' };
  }

  if (requested === 'cloudflare') {
    const { ensureQuickTunnel } = require('./quick-tunnel');
    const tunnel = await ensureQuickTunnel(options);
    return { ...tunnel, provider: 'cloudflare' };
  }

  throw new Error(`unknown_tunnel_provider:${requested}`);
}

module.exports = {
  ensureTunnel,
  hasNgrokAuthtoken,
  resolveProviderFromEnv
};

