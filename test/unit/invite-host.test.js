/**
 * Invite Host Resolution Tests
 *
 * Covers: resolveInviteHost behavior for env/config hostnames and
 * external IP substitution with caching.
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  test('resolveInviteHost prefers A2A_HOSTNAME env and preserves port', async () => {
    tmp = helpers.tmpConfigDir('invite-env');
    const prev = process.env.A2A_HOSTNAME;
    process.env.A2A_HOSTNAME = 'example.com:4444';

    delete require.cache[require.resolve('../../src/lib/invite-host')];
    const { resolveInviteHost } = require('../../src/lib/invite-host');
    const resolved = await resolveInviteHost({ defaultPort: 3001 });
    assert.equal(resolved.host, 'example.com:4444');

    if (prev === undefined) delete process.env.A2A_HOSTNAME;
    else process.env.A2A_HOSTNAME = prev;
    tmp.cleanup();
  });

  test('resolveInviteHost appends default port when missing', async () => {
    tmp = helpers.tmpConfigDir('invite-port');
    const prev = process.env.A2A_HOSTNAME;
    process.env.A2A_HOSTNAME = 'example.com';

    delete require.cache[require.resolve('../../src/lib/invite-host')];
    const { resolveInviteHost } = require('../../src/lib/invite-host');
    const resolved = await resolveInviteHost({ defaultPort: 3001 });
    assert.equal(resolved.host, 'example.com:3001');

    if (prev === undefined) delete process.env.A2A_HOSTNAME;
    else process.env.A2A_HOSTNAME = prev;
    tmp.cleanup();
  });

  test('resolveInviteHost replaces localhost with external IP (cached)', async () => {
    tmp = helpers.tmpConfigDir('invite-external');
    const http = require('http');
    const path = require('path');
    delete process.env.A2A_HOSTNAME;

    const server = http.createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('203.0.113.7\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const serviceUrl = `http://127.0.0.1:${addr.port}/`;

    // Config has localhost, so we should substitute external IP.
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();
    config.setAgent({ hostname: 'localhost:3001' });

    delete require.cache[require.resolve('../../src/lib/invite-host')];
    const { resolveInviteHost } = require('../../src/lib/invite-host');

    const first = await resolveInviteHost({
      config,
      defaultPort: 3001,
      externalIpServices: [serviceUrl],
      externalIpTimeoutMs: 1000,
      externalIpCacheFile: path.join(tmp.dir, 'a2a-external-ip.json')
    });
    assert.equal(first.host, '203.0.113.7:3001');

    // Close server to prove cache is used on subsequent calls.
    await new Promise((resolve) => server.close(resolve));

    const second = await resolveInviteHost({
      config,
      defaultPort: 3001,
      externalIpServices: [serviceUrl], // would now fail if called
      externalIpTimeoutMs: 1000,
      externalIpCacheFile: path.join(tmp.dir, 'a2a-external-ip.json'),
      externalIpTtlMs: 60 * 60 * 1000
    });
    assert.equal(second.host, '203.0.113.7:3001');

    tmp.cleanup();
  });

};
