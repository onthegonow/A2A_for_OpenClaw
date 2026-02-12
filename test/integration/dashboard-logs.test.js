/**
 * Dashboard Logs API Integration Tests
 *
 * Verifies log listing, trace retrieval, and stats endpoints.
 */

module.exports = function (test, assert, helpers) {
  let tmp = null;
  let client = null;
  let loggerModule = null;

  async function setup() {
    tmp = helpers.tmpConfigDir('dash-logs');

    delete require.cache[require.resolve('../../src/routes/dashboard')];
    delete require.cache[require.resolve('../../src/lib/logger')];
    delete require.cache[require.resolve('../../src/lib/tokens')];

    const express = require('express');
    const { createDashboardApiRouter } = require('../../src/routes/dashboard');
    const { TokenStore } = require('../../src/lib/tokens');
    loggerModule = require('../../src/lib/logger');

    const logger = loggerModule.createLogger({
      component: 'test.dashboard',
      configDir: tmp.dir,
      stdout: false,
      minLevel: 'trace'
    });

    logger.info('dashboard test info', {
      event: 'dash_test',
      traceId: 'trace_dash_1',
      data: { idx: 1 }
    });
    logger.warn('dashboard test warn', {
      event: 'dash_test',
      traceId: 'trace_dash_1',
      data: { idx: 2 }
    });
    logger.error('dashboard test error', {
      event: 'dash_other',
      traceId: 'trace_dash_2',
      error_code: 'DASH_TEST_ERROR',
      status_code: 500,
      hint: 'Synthetic dashboard test failure.',
      error: Object.assign(new Error('synthetic failure'), { code: 'E_DASH_TEST' }),
      data: { idx: 3 }
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
  }

  test('GET /logs returns structured entries with filters', async () => {
    await setup();

    const all = await client.get('/api/a2a/dashboard/logs?limit=10');
    assert.equal(all.statusCode, 200);
    assert.equal(all.body.success, true);
    assert.equal(Array.isArray(all.body.logs), true);
    assert.greaterThan(all.body.logs.length, 0);

    const warns = await client.get('/api/a2a/dashboard/logs?level=warn&limit=10');
    assert.equal(warns.statusCode, 200);
    assert.equal(warns.body.logs.length, 1);
    assert.equal(warns.body.logs[0].level, 'warn');

    const byEvent = await client.get('/api/a2a/dashboard/logs?event=dash_test&limit=10');
    assert.equal(byEvent.statusCode, 200);
    assert.equal(byEvent.body.logs.length, 2);

    const byErrorCode = await client.get('/api/a2a/dashboard/logs?error_code=DASH_TEST_ERROR&limit=10');
    assert.equal(byErrorCode.statusCode, 200);
    assert.equal(byErrorCode.body.logs.length, 1);
    assert.equal(byErrorCode.body.logs[0].error_code, 'DASH_TEST_ERROR');
    assert.equal(byErrorCode.body.logs[0].status_code, 500);
    assert.equal(byErrorCode.body.logs[0].hint, 'Synthetic dashboard test failure.');

    await teardown();
  });

  test('GET /logs/trace and /logs/stats return trace timeline and aggregates', async () => {
    await setup();

    const trace = await client.get('/api/a2a/dashboard/logs/trace/trace_dash_1?limit=10');
    assert.equal(trace.statusCode, 200);
    assert.equal(trace.body.success, true);
    assert.equal(trace.body.trace_id, 'trace_dash_1');
    assert.equal(trace.body.logs.length, 2);
    assert.equal(trace.body.logs[0].trace_id, 'trace_dash_1');
    assert.equal(trace.body.logs[1].trace_id, 'trace_dash_1');

    const stats = await client.get('/api/a2a/dashboard/logs/stats');
    assert.equal(stats.statusCode, 200);
    assert.equal(stats.body.success, true);
    assert.equal(stats.body.stats.total, 3);
    assert.equal(stats.body.stats.by_level.info, 1);
    assert.equal(stats.body.stats.by_level.warn, 1);
    assert.equal(stats.body.stats.by_level.error, 1);

    await teardown();
  });
};
