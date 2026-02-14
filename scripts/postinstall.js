#!/usr/bin/env node

// ============================================================================
// npm postinstall hook — automatic onboarding launcher
//
// OBJECTIVE: When a user (or agent) runs `npm install -g a2acalling`, this
// script fires automatically and launches the full quickstart onboarding flow.
// The agent should never need a second command — install IS onboarding.
//
// KEY DESIGN DECISIONS:
//
//   1. No TTY gate. Agents are the primary users of this package and they
//      run in non-interactive (piped) environments. Every prompt in the
//      quickstart flow auto-accepts sensible defaults when there is no TTY,
//      so the full onboarding completes unattended: port selection, hostname
//      detection, server start, and disclosure prompt output.
//
//   2. stdio: 'inherit'. The onboarding output goes straight to whatever
//      called npm — if that's a terminal the user sees it; if it's an agent
//      the agent reads it. No /dev/tty tricks needed.
//
//   3. Never fail the install. If quickstart can't launch (e.g. missing node
//      binary edge case), we print a hint and exit 0. A broken postinstall
//      would prevent the package from installing at all.
//
//   4. Skip non-global installs, CI, and Docker builds. Local `npm install`
//      in a project shouldn't trigger onboarding. CI and Docker are build
//      environments, not runtime hosts.
// ============================================================================

if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);
if (process.env.DOCKER) process.exit(0);
if (process.env.npm_config_global !== 'true') process.exit(0);

const path = require('path');
const { spawnSync } = require('child_process');

const initCwd = process.env.INIT_CWD || process.env.HOME || process.cwd();
const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');

// Launch quickstart — prompts auto-accept defaults when there's no TTY.
const result = spawnSync(process.execPath, [cliPath, 'quickstart'], {
  stdio: 'inherit',
  cwd: initCwd,
  env: {
    ...process.env,
    A2A_WORKSPACE: process.env.A2A_WORKSPACE || initCwd
  }
});

if (result.error) {
  console.error('\nCould not auto-launch onboarding.');
  console.error(`Reason: ${result.error.message}`);
  console.error('\nRun manually: a2a quickstart\n');
  process.exit(0); // don't fail the install
}

process.exit(result.status || 0);
