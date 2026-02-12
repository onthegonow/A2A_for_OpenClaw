#!/usr/bin/env node
/**
 * A2A Calling - OpenClaw Integration Installer
 * 
 * This script:
 * 1. Installs the a2a skill to the user's OpenClaw skills directory
 * 2. Adds /a2a as a custom command in OpenClaw config
 * 3. Sets up the federation server as a systemd service (optional)
 * 
 * Usage:
 *   npx a2acalling install
 *   npx a2acalling install --hostname myserver.com
 *   npx a2acalling install --port 3001
 *   npx a2acalling uninstall
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Paths
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || path.join(process.env.HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_SKILLS = process.env.OPENCLAW_SKILLS || path.join(process.env.HOME, '.openclaw', 'skills');
const SKILL_NAME = 'a2a';

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

// Skill content
const SKILL_MD = `---
name: a2a
description: "Agent-to-Agent federation. Handle /a2a commands to create tokens, manage connections, and call remote agents. Triggers on: /a2a, federation, agent token, a2a invite."
---

# A2A Federation

Handle agent-to-agent communication commands.

## Commands

### /a2a invite [name] [--expires X] [--permissions Y]

Create a federation token. Run:

\`\`\`bash
a2a create --name "NAME" --expires "DURATION" --permissions "LEVEL"
\`\`\`

Defaults: expires=1d, permissions=chat-only, max-calls=100

Reply with the full shareable invite block.

### /a2a list

List active tokens:

\`\`\`bash
a2a list
\`\`\`

### /a2a revoke <id>

Revoke a token:

\`\`\`bash
a2a revoke TOKEN_ID
\`\`\`

### /a2a add <invite_url> [name]

Add a remote agent:

\`\`\`bash
a2a add "INVITE_URL" "NAME"
\`\`\`

### /a2a remotes

List remote agents:

\`\`\`bash
a2a remotes
\`\`\`

### /a2a call <name_or_url> <message>

Call a remote agent:

\`\`\`bash
a2a call "URL_OR_NAME" "MESSAGE"
\`\`\`

## Server

The a2a server must be running to receive incoming calls:

\`\`\`bash
a2a server --port 3001
\`\`\`

Or as a service: \`systemctl start a2a\`
`;

function install() {
  log('Installing A2A Calling for OpenClaw...\n');

  // 1. Create skills directory if needed
  if (!fs.existsSync(OPENCLAW_SKILLS)) {
    fs.mkdirSync(OPENCLAW_SKILLS, { recursive: true });
    log(`Created skills directory: ${OPENCLAW_SKILLS}`);
  }

  // 2. Install skill
  const skillDir = path.join(OPENCLAW_SKILLS, SKILL_NAME);
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_MD);
  log(`Installed skill to: ${skillDir}`);

  // 3. Update OpenClaw config
  if (fs.existsSync(OPENCLAW_CONFIG)) {
    try {
      const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
      
      // Add custom command for each channel that supports it
      const channels = ['telegram', 'discord', 'slack'];
      let updated = false;
      
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
            updated = true;
            log(`Added /a2a command to ${channel} config`);
          } else {
            log(`/a2a command already exists in ${channel} config`);
          }
        }
      }
      
      if (updated) {
        // Backup original
        const backupPath = `${OPENCLAW_CONFIG}.backup.${Date.now()}`;
        fs.copyFileSync(OPENCLAW_CONFIG, backupPath);
        log(`Backed up config to: ${backupPath}`);
        
        // Write updated config
        fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2));
        log('Updated OpenClaw config');
        warn('Restart OpenClaw gateway to apply changes: openclaw gateway restart');
      }
    } catch (e) {
      warn(`Could not update OpenClaw config: ${e.message}`);
      warn('You may need to manually add the /a2a custom command');
    }
  } else {
    warn(`OpenClaw config not found at: ${OPENCLAW_CONFIG}`);
    warn('You may need to manually add the /a2a custom command');
  }

  // 4. Show server setup instructions
  const hostname = flags.hostname || process.env.HOSTNAME || 'localhost';
  const port = flags.port || '3001';
  
  console.log(`
${bold('━━━ Server Setup ━━━')}

To receive incoming calls, run the a2a server:

  ${green(`A2A_HOSTNAME="${hostname}:${port}" a2a server`)}

Or create a systemd service:

  ${green('sudo a2a service install')}

${bold('━━━ Usage ━━━')}

In your chat app, use:

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

  // Remove skill
  const skillDir = path.join(OPENCLAW_SKILLS, SKILL_NAME);
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true });
    log(`Removed skill from: ${skillDir}`);
  }

  // Note about config
  warn('Custom command in OpenClaw config was not removed.');
  warn('You can manually remove it if desired.');

  log('✅ Uninstall complete');
}

function showHelp() {
  console.log(`
${bold('A2A Calling - OpenClaw Integration')}

Usage:
  npx a2acalling install [options]    Install A2A for OpenClaw
  npx a2acalling uninstall            Remove A2A skill
  npx a2acalling server               Start federation server

Install Options:
  --hostname <host>    Hostname for invite URLs (default: system hostname)
  --port <port>        Server port (default: 3001)

Examples:
  npx a2acalling install --hostname myserver.com --port 443
  npx a2acalling server --port 3001
`);
}

// Main
switch (command) {
  case 'install':
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
