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
//   2. Bypassing npm's output capture. npm v7+ pipes lifecycle script stdout
//      AND stderr to an internal buffer, only showing them on failure. This
//      means normal console.log/console.error from postinstall is invisible.
//      To make onboarding output visible:
//
//      a) Run quickstart with piped stdio, capturing all its output.
//      b) Save the output to a2a-onboarding.txt in the config dir (reliable
//         fallback — agents can always read this file).
//      c) Try /proc/$PPID/fd/2 FIRST (Linux — writes directly to npm's
//         stderr fd, which IS the caller's output stream. Agents capture
//         via pipes, so this is the primary delivery path).
//      d) Try /dev/tty (macOS/non-Linux — interactive terminals).
//      e) Last resort: process.stderr.write (npm may still buffer this).
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

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const initCwd = process.env.INIT_CWD || process.env.HOME || process.cwd();
const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');

// Run quickstart with piped stdio so we capture all its output.
// stdin is piped (empty) so all prompts auto-accept their defaults.
const result = spawnSync(process.execPath, [cliPath, 'quickstart'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: initCwd,
  env: {
    ...process.env,
    A2A_WORKSPACE: process.env.A2A_WORKSPACE || initCwd
  }
});

if (result.error) {
  process.stderr.write('\nCould not auto-launch onboarding.\n');
  process.stderr.write(`Reason: ${result.error.message}\n`);
  process.stderr.write('\nRun manually: a2a quickstart\n\n');
  process.exit(0); // don't fail the install
}

const output = (result.stdout || '').toString() + (result.stderr || '').toString();

// ── Always save to file (reliable fallback) ──────────────────────────────
// Agents can read this after install regardless of output visibility.
try {
  const configDir = process.env.A2A_CONFIG_DIR
    || path.join(process.env.HOME || '/root', '.config', 'openclaw');
  if (fs.existsSync(configDir)) {
    fs.writeFileSync(path.join(configDir, 'a2a-onboarding.txt'), output);
  }
} catch (_) {}

// ── Make output visible to the caller ────────────────────────────────────
// npm pipes BOTH stdout and stderr of lifecycle scripts (v7+), so writing
// to our own fds goes into npm's buffer. We need to bypass npm entirely.

function tryWrite(output) {
  // Strategy 1: /proc/$PPID/fd/2 — Linux, write to npm's stderr directly.
  // npm's stderr IS the caller's stderr (the agent's output stream).
  // This bypasses npm's pipe buffer because we open the fd independently.
  // This is tried FIRST because agents are the primary users — their output
  // is captured via pipes, and /dev/tty would send output to a terminal
  // device they can't read from.
  try {
    const fd = fs.openSync(`/proc/${process.ppid}/fd/2`, 'w');
    fs.writeSync(fd, output);
    fs.closeSync(fd);
    return true;
  } catch (_) {}

  // Strategy 2: /dev/tty — interactive terminals (macOS, non-Linux).
  // Talks directly to the user's terminal, bypassing npm's pipe.
  try {
    const fd = fs.openSync('/dev/tty', 'w');
    fs.writeSync(fd, output);
    fs.closeSync(fd);
    return true;
  } catch (_) {}

  // Strategy 3: process.stderr — last resort, npm may still buffer this.
  try {
    process.stderr.write(output);
    return true;
  } catch (_) {}

  return false;
}

tryWrite(output);

process.exit(result.status || 0);
