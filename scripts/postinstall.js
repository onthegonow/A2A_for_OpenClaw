#!/usr/bin/env node

// Only run for global installs; skip in CI, dev, and Docker builds.
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);
if (process.env.npm_config_global !== 'true') process.exit(0);

console.log('\na2acalling installed. Starting onboarding...\n');

const { spawnSync } = require('child_process');
const result = spawnSync('a2a', ['quickstart'], { stdio: 'inherit' });

if (result.error) {
  // a2a binary not in PATH yet (rare) — tell the agent what to run
  console.log('Could not auto-launch onboarding.\n');
  console.log('Next: run `a2a quickstart`\n');
}

process.exit(result.status || 0);
