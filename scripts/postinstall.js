#!/usr/bin/env node

// Only run for global installs; skip in CI, dev, and Docker builds.
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);
if (process.env.npm_config_global !== 'true') process.exit(0);

console.log('\n  a2acalling installed successfully.\n');
console.log('  To get started, run:\n');
console.log('    a2a quickstart\n');
