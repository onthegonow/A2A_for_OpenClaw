#!/usr/bin/env node

// Only run for global installs; skip in CI, dev, and Docker builds.
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
