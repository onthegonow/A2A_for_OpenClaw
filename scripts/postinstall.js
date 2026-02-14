#!/usr/bin/env node

// Only show the banner for global installs; skip in CI, dev, and Docker builds.
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);
if (process.env.npm_config_global !== 'true') process.exit(0);

console.log(`
a2acalling installed successfully.

Next: run \`a2a quickstart\`
`);
