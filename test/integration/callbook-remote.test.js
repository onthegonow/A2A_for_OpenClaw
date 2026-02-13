/**
 * Callbook Remote Integration Test
 *
 * Verifies:
 * - provisioning link creation
 * - one-time exchange -> Set-Cookie
 * - cookie session can access protected endpoints
 * - reuse of provisioning code is rejected
 * - device revoke invalidates the session
 */

module.exports = function (test, assert, helpers) {
  let tmp = null;
  let client = null;
  let loggerModule = null;

  async function setup() {
    tmp = helpers.tmpConfigDir('callbook');
    process.env.A2A_ADMIN_TOKEN = 'adm_test_token';
    // Avoid external IP lookups during tests.
    process.env.A2A_HOSTNAME = 'public.example:3001';

    delete require.cache[require.resolve('../../src/routes/dashboard')];
    delete require.cache[require.resolve('../../src/lib/logger')];
    delete require.cache[require.resolve('../../src/lib/tokens')];
    delete require.cache[require.resolve('../../src/lib/callbook')];

    const express = require('express');
    const { createDashboardApiRouter } = require('../../src/routes/dashboard');
    const { TokenStore } = require('../../src/lib/tokens');
    loggerModule = require('../../src/lib/logger');

    const logger = loggerModule.createLogger({
      component: 'test.callbook',
      configDir: tmp.dir,
      stdout: false,
      minLevel: 'trace'
    });

    const app = express();
    app.use('/api/a2a/dashboard', createDashboardApiRouter({
      tokenStore: new TokenStore(tmp.dir),
      logger
    }));
    client = helpers.request(app);
  }

  async function teardown() {
    if (client) await client.close();
    client = null;
    if (loggerModule && typeof loggerModule.closeAllLoggerStores === 'function') {
      loggerModule.closeAllLoggerStores();
    }
    loggerModule = null;
    if (tmp) tmp.cleanup();
    tmp = null;
    delete process.env.A2A_ADMIN_TOKEN;
    delete process.env.A2A_HOSTNAME;
  }

  function cookieFromSetCookieHeader(setCookie) {
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) return '';
    return String(raw).split(';')[0];
  }

  test('provision -> exchange -> cookie access -> revoke invalidates session', async () => {
    await setup();

    const remoteAdminHeaders = {
      'x-forwarded-for': '1.2.3.4',
      'x-admin-token': process.env.A2A_ADMIN_TOKEN
    };

    const provision = await client.post('/api/a2a/dashboard/callbook/provision', {
      headers: remoteAdminHeaders,
      body: { label: 'Test Mac', ttl_hours: 24 }
    });
    assert.equal(provision.statusCode, 200);
    assert.equal(provision.body.success, true);
    assert.ok(provision.body.install_url);
    assert.match(provision.body.install_url, /#code=cbk_/);

    const code = String(provision.body.install_url).split('#code=')[1];
    assert.ok(code);

    const exchange = await client.post('/api/a2a/dashboard/callbook/exchange', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
      body: { code, label: 'Test Mac' }
    });
    assert.equal(exchange.statusCode, 200);
    assert.equal(exchange.body.success, true);
    assert.ok(exchange.headers['set-cookie']);

    const cookie = cookieFromSetCookieHeader(exchange.headers['set-cookie']);
    assert.match(cookie, /^a2a_callbook_session=/);

    const settings = await client.get('/api/a2a/dashboard/settings', {
      headers: { 'x-forwarded-for': '1.2.3.4', 'cookie': cookie }
    });
    assert.equal(settings.statusCode, 200);
    assert.equal(settings.body.success, true);

    const exchangeAgain = await client.post('/api/a2a/dashboard/callbook/exchange', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
      body: { code, label: 'Second try' }
    });
    assert.equal(exchangeAgain.statusCode, 401);
    assert.equal(exchangeAgain.body.success, false);

    const devices = await client.get('/api/a2a/dashboard/callbook/devices?include_revoked=true', {
      headers: { 'x-forwarded-for': '1.2.3.4', 'cookie': cookie }
    });
    assert.equal(devices.statusCode, 200);
    assert.equal(devices.body.success, true);
    assert.equal(Array.isArray(devices.body.devices), true);
    assert.greaterThan(devices.body.devices.length, 0);

    const deviceId = devices.body.devices[0].id;
    assert.ok(deviceId);

    const revoke = await client.post(`/api/a2a/dashboard/callbook/devices/${encodeURIComponent(deviceId)}/revoke`, {
      headers: { 'x-forwarded-for': '1.2.3.4', 'cookie': cookie },
      body: {}
    });
    assert.equal(revoke.statusCode, 200);
    assert.equal(revoke.body.success, true);

    const settingsAfter = await client.get('/api/a2a/dashboard/settings', {
      headers: { 'x-forwarded-for': '1.2.3.4', 'cookie': cookie }
    });
    assert.equal(settingsAfter.statusCode, 401);
    assert.equal(settingsAfter.body.success, false);

    await teardown();
  });
};

