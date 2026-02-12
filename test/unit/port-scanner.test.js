/**
 * Port Scanner Tests
 *
 * Covers: isPortAvailable, findAvailablePort
 */

module.exports = function (test, assert, helpers) {
  test('isPortAvailable returns true for unused port', async () => {
    const { isPortAvailable } = require('../../src/lib/port-scanner');
    // Use a high ephemeral port unlikely to be in use
    const available = await isPortAvailable(59123, '127.0.0.1');
    assert.equal(available, true);
  });

  test('isPortAvailable returns false for port in use', async () => {
    const net = require('net');
    const { isPortAvailable } = require('../../src/lib/port-scanner');

    // Bind a test server to a known port
    const server = net.createServer();
    await new Promise((resolve) => server.listen(59124, '127.0.0.1', resolve));

    try {
      const available = await isPortAvailable(59124, '127.0.0.1');
      assert.equal(available, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('findAvailablePort picks first available, skipping busy ones', async () => {
    const net = require('net');
    const { findAvailablePort } = require('../../src/lib/port-scanner');

    // Block the first port
    const server = net.createServer();
    await new Promise((resolve) => server.listen(59125, '127.0.0.1', resolve));

    try {
      const port = await findAvailablePort([59125, 59126, 59127], '127.0.0.1');
      assert.equal(port, 59126);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('findAvailablePort returns null when all busy', async () => {
    const net = require('net');
    const { findAvailablePort } = require('../../src/lib/port-scanner');

    // Block all candidate ports
    const servers = [];
    for (const p of [59128, 59129]) {
      const s = net.createServer();
      await new Promise((resolve) => s.listen(p, '127.0.0.1', resolve));
      servers.push(s);
    }

    try {
      const port = await findAvailablePort([59128, 59129], '127.0.0.1');
      assert.equal(port, null);
    } finally {
      for (const s of servers) {
        await new Promise((resolve) => s.close(resolve));
      }
    }
  });
};
