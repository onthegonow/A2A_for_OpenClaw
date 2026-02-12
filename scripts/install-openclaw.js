#!/usr/bin/env node
/**
 * A2A Calling Setup Installer
 *
 * Supports automatic setup:
 * - If OpenClaw gateway is detected, install a gateway HTTP proxy plugin
 *   so dashboard is accessible at /a2a on gateway.
 * - If gateway is not detected, dashboard runs on standalone A2A server.
 * - If OpenClaw is not installed, bootstrap standalone runtime templates.
 * - If no public hostname is configured, default to secure Quick Tunnel
 *   for internet-facing invite URLs (lazy cloudflared download).
 *
 * Usage:
 *   npx a2acalling install
 *   npx a2acalling setup
 *   npx a2acalling install --hostname myserver.com --port 3001
 *   npx a2acalling uninstall
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Paths
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || path.join(process.env.HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_SKILLS = process.env.OPENCLAW_SKILLS || path.join(process.env.HOME, '.openclaw', 'skills');
const OPENCLAW_EXTENSIONS = process.env.OPENCLAW_EXTENSIONS || path.join(process.env.HOME, '.openclaw', 'extensions');
const SKILL_NAME = 'a2a';
const DASHBOARD_PLUGIN_ID = 'a2a-dashboard-proxy';

// Parse args
const args = process.argv.slice(2);
const command = args[0];
const flags = {};
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
}

// Colors
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function log(msg) { console.log(`${green('[a2a]')} ${msg}`); }
function warn(msg) { console.log(`${yellow('[a2a]')} ${msg}`); }
function error(msg) { console.error(`${red('[a2a]')} ${msg}`); }

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function loadOpenClawConfig() {
  if (!fs.existsSync(OPENCLAW_CONFIG)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
  } catch (err) {
    warn(`OpenClaw config is unreadable: ${err.message}`);
    return null;
  }
}

function writeOpenClawConfig(config) {
  const backupPath = `${OPENCLAW_CONFIG}.backup.${Date.now()}`;
  fs.copyFileSync(OPENCLAW_CONFIG, backupPath);
  fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2));
  log(`Backed up config to: ${backupPath}`);
  log('Updated OpenClaw config');
}

function detectGateway(config) {
  const hasBinary = commandExists('openclaw');
  const hasGatewayBlock = Boolean(config?.gateway);
  return hasBinary && hasGatewayBlock;
}

function resolveGatewayBaseUrl() {
  if (flags['gateway-url']) {
    return String(flags['gateway-url']).replace(/\/+$/, '');
  }

  try {
    const output = execSync('openclaw dashboard --no-open', {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const match = output.match(/Dashboard URL:\s*(\S+)/);
    if (match && match[1]) {
      const parsed = new URL(match[1]);
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch (err) {
    // fall through to default
  }

  const fallbackPort = process.env.OPENCLAW_GATEWAY_PORT || '18789';
  return `http://127.0.0.1:${fallbackPort}`;
}

function resolveA2AConfigDir() {
  return process.env.A2A_CONFIG_DIR ||
    process.env.OPENCLAW_CONFIG_DIR ||
    path.join(process.env.HOME || '/tmp', '.config', 'openclaw');
}

function safeRead(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch (err) {
    return '';
  }
}

function writeExecutableFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  try {
    fs.chmodSync(filePath, 0o755);
  } catch (err) {
    // Non-fatal on platforms without chmod support.
  }
}

/**
 * Ensure config and disclosure manifest exist.
 * Called from both OpenClaw and standalone install paths.
 */
function ensureConfigAndManifest(inviteHost, port, options = {}) {
  const configDir = resolveA2AConfigDir();
  ensureDir(configDir);

  try {
    const { A2AConfig } = require('../src/lib/config');
    const { loadManifest, saveManifest, generateDefaultManifest, readContextFiles } = require('../src/lib/disclosure');

    const config = new A2AConfig();
    const defaults = config.getDefaults() || {};
    config.setDefaults(defaults);

    const agent = config.getAgent() || {};
    const desiredHost = String(inviteHost || '').trim();
    if ((desiredHost && !agent.hostname) || (desiredHost && options.forceHostname)) {
      config.setAgent({ hostname: desiredHost });
    }

    const manifest = loadManifest();
    if (!manifest || Object.keys(manifest).length === 0) {
      const contextFiles = readContextFiles(process.cwd());
      const generated = generateDefaultManifest(contextFiles);
      saveManifest(generated);
      const manifestFile = path.join(configDir, 'a2a-disclosure.json');
      log(`Generated default disclosure manifest: ${manifestFile}`);
    }
  } catch (err) {
    warn(`Config/manifest bootstrap failed: ${err.message}`);
  }

  return configDir;
}

function ensureStandaloneBootstrap(inviteHost, port, options = {}) {
  const configDir = ensureConfigAndManifest(inviteHost, port, options);

  const configFile = path.join(configDir, 'a2a-config.json');
  const manifestFile = path.join(configDir, 'a2a-disclosure.json');

  const bridgeDir = path.join(configDir, 'runtime-bridge');
  ensureDir(bridgeDir);
  const turnScript = path.join(bridgeDir, 'a2a-turn.sh');
  const summaryScript = path.join(bridgeDir, 'a2a-summary.sh');
  const notifyScript = path.join(bridgeDir, 'a2a-notify.sh');

  if (!fs.existsSync(turnScript)) {
    writeExecutableFile(turnScript, `#!/usr/bin/env bash
set -euo pipefail
payload="$(cat || true)"
echo '{"response":"Generic bridge placeholder: your agent bridge is active. I received your message and can continue the call. What collaboration outcome should we target?"}'
`);
  }

  if (!fs.existsSync(summaryScript)) {
    writeExecutableFile(summaryScript, `#!/usr/bin/env bash
set -euo pipefail
payload="$(cat || true)"
echo '{"summary":"Generic summary placeholder generated by standalone bridge.","ownerSummary":"Generic summary placeholder generated by standalone bridge."}'
`);
  }

  if (!fs.existsSync(notifyScript)) {
    writeExecutableFile(notifyScript, `#!/usr/bin/env bash
set -euo pipefail
payload="$(cat || true)"
echo "a2a notify: $payload" >&2
`);
  }

  // Install SKILL.md so standalone agents can discover it
  const skillsDir = path.join(configDir, 'skills', SKILL_NAME);
  ensureDir(skillsDir);
  const skillContent = loadSkillMd();
  if (skillContent) {
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), skillContent);
    log(`Installed skill to: ${skillsDir}`);
  }

  let generatedAdminToken = null;
  if (!process.env.A2A_ADMIN_TOKEN) {
    generatedAdminToken = crypto.randomBytes(24).toString('base64url');
  }

  return {
    configDir,
    configFile,
    manifestFile,
    skillsDir,
    bridgeDir,
    turnScript,
    summaryScript,
    notifyScript,
    generatedAdminToken
  };
}

const DASHBOARD_PLUGIN_MANIFEST = {
  id: DASHBOARD_PLUGIN_ID,
  name: 'A2A Dashboard Proxy',
  description: 'Proxy A2A dashboard routes through OpenClaw gateway',
  version: '1.0.0',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      backendUrl: {
        type: 'string',
        default: 'http://127.0.0.1:3001'
      }
    }
  }
};

const DASHBOARD_PLUGIN_TS = `import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";

const PLUGIN_ID = "a2a-dashboard-proxy";
const UI_PREFIX = "/a2a";
const API_PREFIX = "/api/a2a/dashboard";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function resolveBackendUrl(api: OpenClawPluginApi): URL {
  const fallback = process.env.A2A_DASHBOARD_BACKEND_URL || "http://127.0.0.1:3001";
  const pluginConfigRaw = (api as OpenClawPluginApi & { pluginConfig?: unknown }).pluginConfig;
  const pluginConfig = (pluginConfigRaw && typeof pluginConfigRaw === "object")
    ? (pluginConfigRaw as Record<string, unknown>)
    : {};
  const configuredUrl = typeof pluginConfig.backendUrl === "string" && pluginConfig.backendUrl
    ? pluginConfig.backendUrl
    : "";
  if (configuredUrl) {
    return new URL(configuredUrl);
  }
  try {
    const cfg = api.runtime.config.loadConfig() as Record<string, unknown>;
    const plugins = (cfg.plugins || {}) as Record<string, unknown>;
    const entries = (plugins.entries || {}) as Record<string, unknown>;
    const pluginEntry = (entries[PLUGIN_ID] || {}) as Record<string, unknown>;
    const entryConfig = (pluginEntry.config || {}) as Record<string, unknown>;
    const candidate = typeof entryConfig.backendUrl === "string" && entryConfig.backendUrl
      ? entryConfig.backendUrl
      : typeof pluginEntry.backendUrl === "string" && pluginEntry.backendUrl
      ? pluginEntry.backendUrl
      : fallback;
    return new URL(candidate);
  } catch {
    return new URL(fallback);
  }
}

function rewriteUiPath(pathname: string): string {
  if (pathname === UI_PREFIX || pathname === UI_PREFIX + "/") {
    return "/dashboard/";
  }
  if (pathname.startsWith(UI_PREFIX + "/")) {
    return "/dashboard/" + pathname.slice((UI_PREFIX + "/").length);
  }
  return pathname;
}

const plugin = {
  id: PLUGIN_ID,
  name: "A2A Dashboard Proxy",
  description: "Proxy A2A dashboard routes through OpenClaw gateway",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      backendUrl: {
        type: "string" as const,
        default: "http://127.0.0.1:3001"
      }
    }
  },
  register(api: OpenClawPluginApi) {
    api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse) => {
      const incoming = new URL(req.url ?? "/", \`http://\${req.headers.host ?? "localhost"}\`);
      const isUi = incoming.pathname === UI_PREFIX || incoming.pathname.startsWith(UI_PREFIX + "/");
      const isApi = incoming.pathname === API_PREFIX || incoming.pathname.startsWith(API_PREFIX + "/");
      if (!isUi && !isApi) {
        return false;
      }

      if (incoming.pathname === UI_PREFIX) {
        res.statusCode = 302;
        res.setHeader("Location", UI_PREFIX + "/");
        res.end();
        return true;
      }

      const backendBase = resolveBackendUrl(api);
      const rewrittenPath = isUi ? rewriteUiPath(incoming.pathname) : incoming.pathname;
      const target = new URL(rewrittenPath + (incoming.search || ""), backendBase);
      const client = target.protocol === "https:" ? https : http;

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value || key.toLowerCase() === "host") continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      headers["x-forwarded-by"] = "a2a-dashboard-proxy";

      const proxyReq = client.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers
      }, (proxyRes) => {
        res.statusCode = proxyRes.statusCode || 502;
        Object.entries(proxyRes.headers).forEach(([key, value]) => {
          if (value !== undefined) {
            res.setHeader(key, value as string | string[]);
          }
        });
        proxyRes.pipe(res);
      });

      proxyReq.on("error", (err) => {
        const backend = backendBase.toString();
        if (isApi) {
          sendJson(res, 502, {
            success: false,
            error: "dashboard_backend_unreachable",
            message: \`Could not reach A2A server at \${backend}: \${err.message}\`
          });
          return;
        }

        sendHtml(res, 502, \`<!doctype html>
<html><head><meta charset="utf-8"><title>A2A Dashboard</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <h1>A2A Dashboard Unavailable</h1>
  <p>The gateway proxy is active, but the A2A backend is not reachable.</p>
  <p>Expected backend: <code>\${backend}</code></p>
  <p>Start the backend with: <code>a2a server --port 3001</code></p>
</body></html>\`);
      });

      req.pipe(proxyReq);
      return true;
    });
  }
};

export default plugin;
`;

function installDashboardProxyPlugin(backendUrl) {
  ensureDir(OPENCLAW_EXTENSIONS);
  const pluginDir = path.join(OPENCLAW_EXTENSIONS, DASHBOARD_PLUGIN_ID);
  ensureDir(pluginDir);

  fs.writeFileSync(
    path.join(pluginDir, 'openclaw.plugin.json'),
    JSON.stringify(DASHBOARD_PLUGIN_MANIFEST, null, 2)
  );
  fs.writeFileSync(path.join(pluginDir, 'index.ts'), DASHBOARD_PLUGIN_TS);

  log(`Installed gateway dashboard plugin: ${pluginDir}`);
  log(`Dashboard proxy backend: ${backendUrl}`);
  return pluginDir;
}

// Skill content — read from the canonical SKILL.md that ships with the package.
// No embedded copy to drift out of sync.
const SKILL_MD_PATH = path.resolve(__dirname, '..', 'SKILL.md');

function loadSkillMd() {
  if (fs.existsSync(SKILL_MD_PATH)) {
    return fs.readFileSync(SKILL_MD_PATH, 'utf8');
  }
  warn(`SKILL.md not found at ${SKILL_MD_PATH}`);
  warn('The a2acalling package may be incomplete. Run: a2a update');
  return null;
}

function readExistingConfiguredInviteHost() {
  try {
    const { A2AConfig } = require('../src/lib/config');
    const { splitHostPort, isLocalOrUnroutableHost } = require('../src/lib/invite-host');
    const config = new A2AConfig();
    const existing = String((config.getAgent() || {}).hostname || '').trim();
    if (!existing) return '';
    const parsed = splitHostPort(existing);
    if (!parsed.hostname || isLocalOrUnroutableHost(parsed.hostname)) {
      return '';
    }
    return existing;
  } catch (err) {
    return '';
  }
}

async function maybeSetupQuickTunnel(port) {
  const disabled = Boolean(flags['no-quick-tunnel']) ||
    String(process.env.A2A_DISABLE_QUICK_TUNNEL || '').toLowerCase() === 'true';
  if (disabled) return null;

  try {
    const { ensureQuickTunnel } = require('../src/lib/quick-tunnel');
    const tunnel = await ensureQuickTunnel({ localPort: Number.parseInt(String(port), 10) || 3001 });
    if (!tunnel || !tunnel.host) return null;
    return {
      ...tunnel,
      inviteHost: `${tunnel.host}:443`
    };
  } catch (err) {
    warn(`Quick Tunnel setup failed: ${err.message}`);
    warn('Falling back to direct host invites (may require firewall/NAT config).');
    return null;
  }
}

async function install() {
  log('Installing A2A Calling...\n');

  const localHostname = process.env.HOSTNAME || 'localhost';

  // Port scanning: use explicit port or scan for available one
  let port;
  if (flags.port) {
    port = String(flags.port);
  } else if (process.env.A2A_PORT) {
    port = String(process.env.A2A_PORT);
  } else {
    try {
      const { findAvailablePort } = require('../src/lib/port-scanner');
      const available = await findAvailablePort([80, 3001, 8080, 8443, 9001]);
      port = available ? String(available) : '3001';
      if (available === 80) {
        log(`Port 80 is available (recommended for inbound A2A connections)`);
      } else if (available) {
        log(`Auto-detected available port: ${available}`);
      }
    } catch (e) {
      port = '3001';
    }
  }
  const backendUrl = flags['dashboard-backend'] || `http://127.0.0.1:${port}`;
  const explicitInviteHost = flags.hostname ||
    process.env.A2A_HOSTNAME ||
    process.env.OPENCLAW_HOSTNAME ||
    readExistingConfiguredInviteHost();
  const quickTunnel = explicitInviteHost ? null : await maybeSetupQuickTunnel(port);
  const inviteHost = explicitInviteHost || (quickTunnel && quickTunnel.inviteHost) || `${localHostname}:${port}`;
  const forceStandalone = Boolean(flags.standalone) || String(process.env.A2A_FORCE_STANDALONE || '').toLowerCase() === 'true';
  const hasOpenClawBinary = commandExists('openclaw');
  const hasOpenClawConfig = fs.existsSync(OPENCLAW_CONFIG);
  const hasOpenClaw = !forceStandalone && (hasOpenClawBinary || hasOpenClawConfig);
  let standaloneBootstrap = null;

  if (hasOpenClaw) {
    // 1. Create skills directory if needed
    ensureDir(OPENCLAW_SKILLS);

    // 2. Install skill
    const skillDir = path.join(OPENCLAW_SKILLS, SKILL_NAME);
    ensureDir(skillDir);
    const skillContent = loadSkillMd();
    if (skillContent) {
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);
    } else {
      warn('Skipped SKILL.md install — source file not found in package.');
    }
    log(`Installed skill to: ${skillDir}`);

    // Ensure config and manifest exist even in OpenClaw path
    ensureConfigAndManifest(inviteHost, port, {
      forceHostname: Boolean(flags.hostname || process.env.A2A_HOSTNAME || process.env.OPENCLAW_HOSTNAME || quickTunnel)
    });
  } else {
    warn('OpenClaw not detected. Enabling standalone A2A bootstrap.');
    standaloneBootstrap = ensureStandaloneBootstrap(inviteHost, port, {
      forceHostname: Boolean(flags.hostname || process.env.A2A_HOSTNAME || process.env.OPENCLAW_HOSTNAME || quickTunnel)
    });
  }

  // 3. Update OpenClaw config + gateway plugin setup (if available)
  let config = loadOpenClawConfig();
  let configUpdated = false;
  let gatewayDetected = false;
  let dashboardMode = 'standalone';
  let dashboardUrl = `http://${localHostname}:${port}/dashboard`;

  if (config) {
    // Add custom command for each enabled channel
    const channels = ['telegram', 'discord', 'slack'];
    for (const channel of channels) {
      if (config.channels?.[channel]?.enabled) {
        if (!config.channels[channel].customCommands) {
          config.channels[channel].customCommands = [];
        }
        const existing = config.channels[channel].customCommands.find(c => c.command === 'a2a');
        if (!existing) {
          config.channels[channel].customCommands.push({
            command: 'a2a',
            description: 'Agent-to-Agent: create invitations, manage connections'
          });
          configUpdated = true;
          log(`Added /a2a command to ${channel} config`);
        } else {
          log(`/a2a command already exists in ${channel} config`);
        }
      }
    }

    gatewayDetected = detectGateway(config);
    if (gatewayDetected) {
      dashboardMode = 'gateway';
      installDashboardProxyPlugin(backendUrl);
      const gatewayBaseUrl = resolveGatewayBaseUrl();
      dashboardUrl = `${gatewayBaseUrl.replace(/\/+$/, '')}/a2a`;

      config.plugins = config.plugins || {};
      config.plugins.entries = config.plugins.entries || {};
      const rawEntry = config.plugins.entries[DASHBOARD_PLUGIN_ID];
      const existingEntry = (rawEntry && typeof rawEntry === 'object') ? rawEntry : {};
      const existingConfig = (existingEntry.config && typeof existingEntry.config === 'object')
        ? existingEntry.config
        : {};
      if (typeof existingEntry.backendUrl === 'string' && existingEntry.backendUrl) {
        log(`Migrated legacy plugin key plugins.entries.${DASHBOARD_PLUGIN_ID}.backendUrl -> plugins.entries.${DASHBOARD_PLUGIN_ID}.config.backendUrl`);
      }
      config.plugins.entries[DASHBOARD_PLUGIN_ID] = {
        enabled: true,
        config: {
          ...existingConfig,
          backendUrl
        }
      };
      configUpdated = true;
      log(`Configured gateway plugin entry: ${DASHBOARD_PLUGIN_ID}`);
    }

    if (configUpdated) {
      writeOpenClawConfig(config);
      warn('Restart OpenClaw gateway to apply changes: openclaw gateway restart');
    }
  } else {
    warn(`OpenClaw config not found at: ${OPENCLAW_CONFIG}`);
    warn('Skipping OpenClaw command/plugin config updates');
  }

  const runtimeLine = forceStandalone
    ? 'Runtime forced to standalone mode for this setup run.'
    : hasOpenClawBinary
    ? 'Runtime auto-selects OpenClaw when available and falls back to generic if needed.'
    : 'Runtime defaults to generic fallback (no OpenClaw dependency required).';

  console.log(`
${bold('━━━ Server Setup ━━━')}

To receive incoming calls and host A2A APIs:

  ${green(`A2A_HOSTNAME="${inviteHost}" a2a server --port ${port}`)}

${bold('━━━ Dashboard Setup ━━━')}

Mode: ${dashboardMode === 'gateway' ? green('gateway') : yellow('standalone')}
Dashboard URL: ${green(dashboardUrl)}

${dashboardMode === 'gateway'
  ? `Gateway path /a2a is now proxied to ${backendUrl}.`
  : 'No gateway detected. Dashboard is served directly from the A2A server.'}

${bold('━━━ Runtime Setup ━━━')}

${runtimeLine}
${quickTunnel
  ? `Quick Tunnel enabled:
  ${green(quickTunnel.url)}
Invites will use: ${green(inviteHost)}
`
  : 'Quick Tunnel not enabled (using configured/direct invite host).'}
${standaloneBootstrap
  ? `Standalone bridge templates:
  ${green(standaloneBootstrap.turnScript)}
  ${green(standaloneBootstrap.summaryScript)}
  ${green(standaloneBootstrap.notifyScript)}

Optional bridge wiring:
  export A2A_RUNTIME=generic
  export A2A_AGENT_COMMAND="${standaloneBootstrap.turnScript}"
  export A2A_SUMMARY_COMMAND="${standaloneBootstrap.summaryScript}"
  export A2A_NOTIFY_COMMAND="${standaloneBootstrap.notifyScript}"
${standaloneBootstrap.generatedAdminToken ? `
Suggested dashboard admin token (set in env, do not commit):
  export A2A_ADMIN_TOKEN="${standaloneBootstrap.generatedAdminToken}"` : ''}`
  : 'No standalone bridge templates were created because OpenClaw was detected.'}

${bold('━━━ Usage ━━━')}

In your chat app, use:

  /a2a quickstart     REQUIRED first step: owner sets permission tiers
  /a2a invite         Create an invitation token
  /a2a list           List active tokens
  /a2a revoke <id>    Revoke a token
  /a2a add <url>      Add a remote agent
  /a2a call <url> <msg>  Call a remote agent

${bold('━━━ Done! ━━━')}

${green('✅ A2A Calling installed successfully!')}
`);
}

function uninstall() {
  log('Uninstalling A2A Calling...\n');

  const skillDir = path.join(OPENCLAW_SKILLS, SKILL_NAME);
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true });
    log(`Removed skill from: ${skillDir}`);
  }

  const pluginDir = path.join(OPENCLAW_EXTENSIONS, DASHBOARD_PLUGIN_ID);
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true });
    log(`Removed dashboard plugin: ${pluginDir}`);
  }

  warn('Custom command and plugin entries in OpenClaw config were not removed.');
  warn('You can remove them manually if desired.');

  log('✅ Uninstall complete');
}

function showHelp() {
  console.log(`
${bold('A2A Calling Setup')}

Usage:
  npx a2acalling install [options]    Install A2A (OpenClaw-aware + standalone)
  npx a2acalling setup [options]      Alias for install (auto runtime detection)
  npx a2acalling uninstall            Remove A2A skill + dashboard plugin
  npx a2acalling server               Start A2A server

Install Options:
  --hostname <host>          Hostname for invite URLs (skip quick tunnel when set)
  --port <port>              A2A server port (default: 3001)
  --gateway-url <url>        Force gateway base URL for printed dashboard link
  --dashboard-backend <url>  Backend URL used by gateway dashboard proxy
  --standalone               Force standalone bootstrap (ignore OpenClaw detection)
  --no-quick-tunnel          Disable auto quick tunnel for no-DNS environments

Examples:
  npx a2acalling install --hostname myserver.com --port 3001
  npx a2acalling setup --dashboard-backend http://127.0.0.1:3001
  npx a2acalling setup --standalone
  npx a2acalling uninstall
`);
}

// Main
switch (command) {
  case 'install':
  case 'setup':
    install().catch(err => {
      error(`Install failed: ${err.message}`);
      process.exit(1);
    });
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    if (command) {
      error(`Unknown command: ${command}`);
    }
    showHelp();
    process.exit(command ? 1 : 0);
}
