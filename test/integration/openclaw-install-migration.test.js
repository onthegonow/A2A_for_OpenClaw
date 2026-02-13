module.exports = function(test, assert, helpers) {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');

  test('installer migrates legacy a2a-dashboard-proxy backendUrl into config.backendUrl', () => {
    const tmp = helpers.tmpConfigDir('a2a-install-migrate');

    const installRoot = tmp.dir;
    const configPath = path.join(installRoot, 'openclaw.json');
    const skillsDir = path.join(installRoot, 'openclaw-skills');
    const extensionsDir = path.join(installRoot, 'openclaw-extensions');
    const a2aConfigDir = path.join(installRoot, 'a2a-config');

    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.mkdirSync(extensionsDir, { recursive: true });
      fs.mkdirSync(a2aConfigDir, { recursive: true });

      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            gateway: {},
            plugins: {
              entries: {
                'a2a-dashboard-proxy': {
                  enabled: true,
                  backendUrl: 'http://127.0.0.1:3001'
                }
              }
            },
            channels: {
              telegram: { enabled: true }
            }
          },
          null,
          2
        )
      );

      const output = execSync(
        `node ${path.join(process.cwd(), 'scripts/install-openclaw.js')} install --hostname test-host.local --port 3001 --no-quick-tunnel`,
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            OPENCLAW_CONFIG: configPath,
            OPENCLAW_SKILLS: skillsDir,
            OPENCLAW_EXTENSIONS: extensionsDir,
            A2A_CONFIG_DIR: a2aConfigDir,
            PATH: '/bin:/usr/bin'
          }
        }
      );

      assert.includes(output, 'a2a-dashboard-proxy config issue: legacy key detected');
      assert.includes(output, 'Auto-fixing legacy key: plugins.entries.a2a-dashboard-proxy.backendUrl');

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const entry = updated?.plugins?.entries?.['a2a-dashboard-proxy'];
      assert.ok(entry, 'a2a-dashboard-proxy entry exists');
      assert.equal(entry.enabled, true);
      assert.equal(typeof entry.config, 'object');
      assert.equal(entry.config.backendUrl, 'http://127.0.0.1:3001');
      assert.ok(!('backendUrl' in entry), 'legacy root backendUrl should be removed');

      const telegramCommand = updated?.channels?.telegram?.customCommands?.find((c) => c && c.command === 'a2a');
      assert.ok(telegramCommand, 'telegram /a2a command exists');
    } finally {
      tmp.cleanup();
    }
  });
};
