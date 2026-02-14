#!/usr/bin/env node

// Only run for global installs; skip in CI, dev, and Docker builds.
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);
if (process.env.DOCKER) process.exit(0);
if (process.env.npm_config_global !== 'true') process.exit(0);

const { spawnSync } = require('child_process');

// Launch quickstart directly — stdio: 'inherit' forces foreground output
// even when npm v10+ suppresses postinstall stdout by default.
const result = spawnSync('a2a', ['quickstart'], {
  stdio: 'inherit',
  shell: true,
  cwd: process.env.HOME || process.cwd()
});

if (result.error || result.status === 127) {
  // spawn error or shell couldn't find the a2a binary
  const reason = result.error ? result.error.message : 'a2a not found in PATH';
  console.error('Could not auto-launch onboarding:', reason);
  console.log('\nRun manually: a2a quickstart');
  process.exit(0); // don't fail the install
}

process.exit(result.status || 0);
