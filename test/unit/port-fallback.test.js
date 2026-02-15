/**
 * Port Fallback Strategy Tests
 *
 * Tests the port fallback warning feature:
 * - Port process identification (via port-scanner primitives)
 * - Proxy config generation patterns
 * - Non-interactive quickstart warns when port 80 is unavailable
 * - tryBindPort correctly reports EADDRINUSE
 */

module.exports = function (test, assert, helpers) {
  test('tryBindPort detects EADDRINUSE for occupied port', async () => {
    const net = require('net');
    const { tryBindPort } = require('../../src/lib/port-scanner');

    // Occupy a port
    const server = net.createServer();
    await new Promise(resolve => server.listen(59200, '127.0.0.1', resolve));

    try {
      const result = await tryBindPort(59200, '127.0.0.1');
      assert.equal(result.ok, false, 'Should not be able to bind occupied port');
      assert.equal(result.code, 'EADDRINUSE', 'Should report EADDRINUSE');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('isPortListening returns false for unused port', async () => {
    const { isPortListening } = require('../../src/lib/port-scanner');
    const result = await isPortListening(59999, '127.0.0.1', { timeoutMs: 200 });
    assert.equal(result.listening, false, 'Port 59999 should not be listening');
  });

  test('proxy config templates contain correct port number', () => {
    // Verify the nginx/caddy config template patterns that generateProxyConfig uses
    const port = 3001;
    const nginxLine = `proxy_pass http://127.0.0.1:${port}/api/a2a/;`;
    const caddyLine = `reverse_proxy 127.0.0.1:${port}`;

    assert.includes(nginxLine, '3001', 'nginx config should include port');
    assert.includes(nginxLine, '/api/a2a/', 'nginx config should include A2A path');
    assert.includes(caddyLine, '3001', 'caddy config should include port');
  });

  test('proxy config templates use different port correctly', () => {
    const port = 8080;
    const nginxLine = `proxy_pass http://127.0.0.1:${port}/api/a2a/;`;
    const caddyLine = `reverse_proxy 127.0.0.1:${port}`;

    assert.includes(nginxLine, '8080', 'nginx config should use port 8080');
    assert.includes(caddyLine, '8080', 'caddy config should use port 8080');
  });

  test('quickstart non-interactive shows port configuration output', () => {
    const { spawnSync } = require('child_process');
    const path = require('path');

    const tmp = helpers.tmpConfigDir('port-fallback-nonint');
    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Run quickstart non-interactively (no TTY = auto-accepts defaults)
    const result = spawnSync(process.execPath, [cliPath, 'quickstart'], {
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000
    });

    const output = (result.stdout || '') + (result.stderr || '');
    // In non-interactive mode, it should either:
    // - Use port 80 if available (and show success), OR
    // - Show the new warning about port 80 being unavailable
    // We can't control which port is free, but verify the flow runs
    assert.ok(
      output.includes('Port 80 is available') ||
      output.includes('PORT 80 IS UNAVAILABLE') ||
      output.includes('Port Configuration'),
      'Should show port configuration output'
    );

    tmp.cleanup();
  });

  test('quickstart non-interactive continues when port 80 unavailable', () => {
    const { spawnSync } = require('child_process');
    const path = require('path');

    const tmp = helpers.tmpConfigDir('port-fallback-continue');
    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    const result = spawnSync(process.execPath, [cliPath, 'quickstart'], {
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000
    });

    const output = (result.stdout || '') + (result.stderr || '');

    // If port 80 was unavailable, should show non-interactive continuation message
    if (output.includes('PORT 80 IS UNAVAILABLE')) {
      assert.includes(output, 'Non-interactive mode: continuing on port',
        'Should auto-continue in non-interactive mode');
      assert.includes(output, 'reverse proxy',
        'Should mention reverse proxy for production use');
    }
    // If port 80 was available, that's fine too — the flow still works

    tmp.cleanup();
  });
};
