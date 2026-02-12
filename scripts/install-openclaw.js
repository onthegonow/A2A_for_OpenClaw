#!/usr/bin/env node
/**
 * A2A Calling - OpenClaw Integration Installer
 *
 * Supports automatic setup:
 * - If OpenClaw gateway is detected, install a gateway HTTP proxy plugin
 *   so dashboard is accessible at /a2a on gateway.
 * - If gateway is not detected, dashboard runs on standalone A2A server.
 *
 * Usage:
 *   npx a2acalling install
 *   npx a2acalling setup
 *   npx a2acalling install --hostname myserver.com --port 3001
 *   npx a2acalling uninstall
 */

const fs = require('fs');
const path = require('path');
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
  try {
    const cfg = api.runtime.config.loadConfig() as Record<string, unknown>;
    const plugins = (cfg.plugins || {}) as Record<string, unknown>;
    const entries = (plugins.entries || {}) as Record<string, unknown>;
    const pluginEntry = (entries[PLUGIN_ID] || {}) as Record<string, unknown>;
    const candidate = typeof pluginEntry.backendUrl === "string" && pluginEntry.backendUrl
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

// Skill content
const SKILL_MD = `---
name: a2a
description: "Agent-to-Agent a2a. Handle /a2a commands to create tokens, manage connections, and call remote agents. Triggers on: /a2a, a2a, agent token, a2a invite."
---

# A2A

Handle agent-to-agent communication with Telegram inline buttons + \`a2a\` CLI.

## CRITICAL: Forum Topic Threading

When sending messages with buttons in Telegram forum groups, **ALWAYS include threadId**:

1. Extract topic ID from message header (e.g., \`topic:567\`)
2. Include \`threadId: "TOPIC_ID"\` in ALL message tool calls

## Onboarding (First Run)

**BEFORE showing tiers, ALWAYS read and analyze user context:**
- HEARTBEAT.md - current tasks/interests
- USER.md - professional context, shareable bio
- SOUL.md - agent personality
- memory/*.md - stored context

**Extract:** Topics of interest, goals, professional context (job seeking?), sensitive areas.

**Personalize tiers based on findings** - not generic examples!

**Step 1:** Show analyzed topics grouped into Public/Friends/Private tiers
**Step 2:** Confirm default settings (expiration, rate limits)
**Step 3:** Confirm agent identity
**Step 4:** Complete - save config, show next steps

Settings saved to ~/.config/openclaw/a2a-config.json

## First-Call Requirement

Before any agent uses \`/a2a call\`, the human owner must complete onboarding and approve tier permissions.
If onboarding has not been completed yet, route them to \`/a2a quickstart\` first.

## Main Menu (Post-Onboarding)

\`\`\`javascript
message({
  action: "send",
  channel: "telegram",
  target: "CHAT_ID",
  threadId: "TOPIC_ID",  // REQUIRED for forum topics!
  message: "🤝 **A2A**\\n\\nWhat would you like to do?",
  buttons: [
    [{ text: "📝 Create Invite", callback_data: "/a2a invite" }, { text: "📋 List Tokens", callback_data: "/a2a list" }],
    [{ text: "🗑 Revoke Token", callback_data: "/a2a revoke" }, { text: "📡 Add Remote", callback_data: "/a2a add" }]
  ]
})
\`\`\`

## Commands

### /a2a invite
\`\`\`bash
a2a create --name "NAME" --expires "DURATION"
\`\`\`
Reply with full shareable invite block.

### /a2a list
\`\`\`bash
a2a list
\`\`\`

### /a2a revoke <id>
\`\`\`bash
a2a revoke TOKEN_ID
\`\`\`

### /a2a add <url> [name]
\`\`\`bash
a2a add "URL" "NAME"
\`\`\`

### /a2a call <url> <msg>
\`\`\`bash
a2a call "URL" "MESSAGE"
\`\`\`

## Server

\`\`\`bash
a2a server --port 3001
\`\`\`

## Defaults
- Expiration: 1 day
- Max calls: 100
- Rate limit: 10/min
`;

function install() {
  log('Installing A2A Calling for OpenClaw...\n');

  const hostname = flags.hostname || process.env.HOSTNAME || 'localhost';
  const port = String(flags.port || process.env.A2A_PORT || '3001');
  const backendUrl = flags['dashboard-backend'] || `http://127.0.0.1:${port}`;

  // 1. Create skills directory if needed
  ensureDir(OPENCLAW_SKILLS);

  // 2. Install skill
  const skillDir = path.join(OPENCLAW_SKILLS, SKILL_NAME);
  ensureDir(skillDir);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_MD);
  log(`Installed skill to: ${skillDir}`);

  // 3. Update OpenClaw config + gateway plugin setup (if available)
  let config = loadOpenClawConfig();
  let configUpdated = false;
  let gatewayDetected = false;
  let dashboardMode = 'standalone';
  let dashboardUrl = `http://${hostname}:${port}/dashboard`;

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
      const existingEntry = config.plugins.entries[DASHBOARD_PLUGIN_ID] || {};
      config.plugins.entries[DASHBOARD_PLUGIN_ID] = {
        ...existingEntry,
        enabled: true,
        backendUrl
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

  console.log(`
${bold('━━━ Server Setup ━━━')}

To receive incoming calls and host A2A APIs:

  ${green(`A2A_HOSTNAME="${hostname}:${port}" a2a server --port ${port}`)}

${bold('━━━ Dashboard Setup ━━━')}

Mode: ${dashboardMode === 'gateway' ? green('gateway') : yellow('standalone')}
Dashboard URL: ${green(dashboardUrl)}

${dashboardMode === 'gateway'
  ? `Gateway path /a2a is now proxied to ${backendUrl}.`
  : 'No gateway detected. Dashboard is served directly from the A2A server.'}

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
${bold('A2A Calling - OpenClaw Integration')}

Usage:
  npx a2acalling install [options]    Install A2A for OpenClaw
  npx a2acalling setup [options]      Alias for install (auto gateway/standalone)
  npx a2acalling uninstall            Remove A2A skill + dashboard plugin
  npx a2acalling server               Start A2A server

Install Options:
  --hostname <host>          Hostname for invite URLs (default: system hostname)
  --port <port>              A2A server port (default: 3001)
  --gateway-url <url>        Force gateway base URL for printed dashboard link
  --dashboard-backend <url>  Backend URL used by gateway dashboard proxy

Examples:
  npx a2acalling install --hostname myserver.com --port 3001
  npx a2acalling setup --dashboard-backend http://127.0.0.1:3001
  npx a2acalling uninstall
`);
}

// Main
switch (command) {
  case 'install':
  case 'setup':
    install();
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
