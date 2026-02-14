#!/usr/bin/env node

// Only run for global installs; skip in CI, dev, and Docker builds.
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);
if (process.env.DOCKER) process.exit(0);
if (process.env.npm_config_global !== 'true') process.exit(0);

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function openDevTty() {
  if (process.env.A2A_POSTINSTALL_DISABLE_TTY === '1') return null;
  if (process.platform === 'win32') return null;

  try {
    // npm may pipe lifecycle stdio even when the user ran npm in a terminal.
    // /dev/tty lets us talk to the actual interactive terminal when present.
    const fdIn = fs.openSync('/dev/tty', 'r');
    const fdOut = fs.openSync('/dev/tty', 'w');
    return { fdIn, fdOut };
  } catch (err) {
    return null;
  }
}

const initCwd = process.env.INIT_CWD || process.env.HOME || process.cwd();
const tty = openDevTty();

if (!tty) {
  // Do NOT auto-start a background server in non-interactive installs.
  console.warn('\n⚠️  A2A Calling installed.');
  console.warn('   Setup requires an interactive terminal.');
  console.warn('   Next: a2a quickstart\n');
  process.exit(0);
}

function writeTty(message) {
  try {
    fs.writeSync(tty.fdOut, String(message));
  } catch (err) {
    // ignore
  }
}

const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');

// Launch quickstart attached to /dev/tty so prompts and output are visible
// even when npm suppresses postinstall output.
const result = spawnSync(process.execPath, [cliPath, 'quickstart'], {
  stdio: [tty.fdIn, tty.fdOut, tty.fdOut],
  cwd: initCwd,
  env: {
    ...process.env,
    A2A_WORKSPACE: process.env.A2A_WORKSPACE || initCwd
  }
});

if (result.error) {
  writeTty('\nCould not auto-launch onboarding.\n');
  writeTty(`Reason: ${result.error.message}\n`);
  writeTty('\nRun manually: a2a quickstart\n');
  try {
    fs.closeSync(tty.fdIn);
    fs.closeSync(tty.fdOut);
  } catch (err) {}
  process.exit(0); // don't fail the install
}

try {
  fs.closeSync(tty.fdIn);
  fs.closeSync(tty.fdOut);
} catch (err) {
  // Best-effort cleanup.
}

process.exit(result.status || 0);
