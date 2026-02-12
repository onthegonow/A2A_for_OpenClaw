/**
 * Rate Limiting Integration Tests
 *
 * Covers: per-minute rate limits, retry-after headers,
 * and rate limiting function directly.
 */

module.exports = function (test, assert, helpers) {

  test('checkRateLimit allows requests under limit', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { checkRateLimit } = require('../../src/routes/a2a');

    const result = checkRateLimit('tok_test_ok', { minute: 10, hour: 100, day: 1000 });
    assert.equal(result.limited, false);
  });

  test('checkRateLimit blocks after exceeding minute limit', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { checkRateLimit } = require('../../src/routes/a2a');

    const tokenId = 'tok_rate_' + Date.now();
    for (let i = 0; i < 3; i++) {
      checkRateLimit(tokenId, { minute: 3, hour: 100, day: 1000 });
    }

    const result = checkRateLimit(tokenId, { minute: 3, hour: 100, day: 1000 });
    assert.ok(result.limited);
    assert.equal(result.error, 'rate_limited');
    assert.equal(result.retryAfter, 60);
  });

  test('checkRateLimit blocks after exceeding hour limit', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { checkRateLimit } = require('../../src/routes/a2a');

    const tokenId = 'tok_hour_' + Date.now();
    for (let i = 0; i < 5; i++) {
      checkRateLimit(tokenId, { minute: 100, hour: 5, day: 1000 });
    }

    const result = checkRateLimit(tokenId, { minute: 100, hour: 5, day: 1000 });
    assert.ok(result.limited);
    assert.equal(result.retryAfter, 3600);
  });

  test('rate limit returns 429 via HTTP', async () => {
    const appCtx = helpers.createTestApp();
    const client = helpers.request(appCtx.app);

    const { token } = appCtx.tokenStore.create({ name: 'RateLimited' });

    // Exhaust the per-minute limit (default is 10)
    for (let i = 0; i < 10; i++) {
      await client.post('/api/a2a/invoke', {
        headers: { Authorization: `Bearer ${token}` },
        body: { message: `Call ${i + 1}` }
      });
    }

    // 11th call should be rate limited
    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'One too many' }
    });

    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error, 'rate_limited');
    assert.ok(res.headers['retry-after']);

    await client.close();
    appCtx.cleanup();
  });
};
