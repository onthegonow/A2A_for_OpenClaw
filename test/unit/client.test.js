/**
 * A2A Client Tests
 *
 * Covers: invite URL parsing, protocol detection,
 * localhost handling, and error types.
 */

module.exports = function (test, assert, helpers) {

  // ── URL Parsing ───────────────────────────────────────────────

  test('parseInvite extracts host and token from a2a:// URL', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const { host, token } = A2AClient.parseInvite('a2a://myhost.com/fed_abc123');
    assert.equal(host, 'myhost.com');
    assert.equal(token, 'fed_abc123');
  });

  test('parseInvite rejects non-a2a schemes', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    assert.throws(() => A2AClient.parseInvite('oclaw://legacy.host/fed_token456'));
    assert.throws(() => A2AClient.parseInvite('https://example.com/fed_token456'));
  });

  test('parseInvite handles host with port', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const { host, token } = A2AClient.parseInvite('a2a://localhost:3001/fed_xyz');
    assert.equal(host, 'localhost:3001');
    assert.equal(token, 'fed_xyz');
  });

  test('parseInvite throws on invalid URL', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    assert.throws(() => A2AClient.parseInvite('https://bad.com/nope'));
    assert.throws(() => A2AClient.parseInvite('not-a-url'));
    assert.throws(() => A2AClient.parseInvite('a2a://'));
  });

  test('parseInvite handles long base64url tokens', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const longToken = 'fed_' + 'A'.repeat(100);
    const { token } = A2AClient.parseInvite(`a2a://host.com/${longToken}`);
    assert.equal(token, longToken);
  });

  // ── A2AError ──────────────────────────────────────────────────

  test('A2AError has code, message, and statusCode', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AError } = require('../../src/lib/client');

    const err = new A2AError('network_error', 'Connection refused', 503);
    assert.equal(err.code, 'network_error');
    assert.equal(err.message, 'Connection refused');
    assert.equal(err.statusCode, 503);
    assert.equal(err.name, 'A2AError');
    assert.ok(err instanceof Error);
  });

  test('A2AError statusCode defaults to null', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AError } = require('../../src/lib/client');

    const err = new A2AError('timeout', 'Request timed out');
    assert.equal(err.statusCode, null);
  });

  // ── Client Construction ───────────────────────────────────────

  test('client stores caller info', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const profile = helpers.goldaDeluxeProfile();
    const client = new A2AClient({
      caller: profile.callScenarios.claudebotCall.caller,
      timeout: 30000
    });

    assert.equal(client.caller.name, 'Golda Deluxe');
    assert.equal(client.timeout, 30000);
  });

  test('client defaults to empty caller and 60s timeout', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const client = new A2AClient();
    assert.deepEqual(client.caller, {});
    assert.equal(client.timeout, 60000);
  });

  // ── End method validation ─────────────────────────────────────

  test('end throws when conversationId missing', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const client = new A2AClient();
    await assert.rejects(() => client.end('a2a://host/fed_tok', null));
  });
};
