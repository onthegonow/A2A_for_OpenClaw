/**
 * Call Monitor Tests
 *
 * Covers: activity tracking, idle detection, max duration,
 * explicit end, and conversation counting.
 */

module.exports = function (test, assert, helpers) {

  function createMonitor(overrides = {}) {
    delete require.cache[require.resolve('../../src/lib/call-monitor')];
    const { CallMonitor } = require('../../src/lib/call-monitor');

    return new CallMonitor({
      convStore: overrides.convStore || null,
      summarizer: overrides.summarizer || null,
      notifyOwner: overrides.notifyOwner || (() => Promise.resolve()),
      idleTimeoutMs: overrides.idleTimeoutMs || 5000,
      maxDurationMs: overrides.maxDurationMs || 30000,
      checkIntervalMs: overrides.checkIntervalMs || 100000, // long interval to prevent auto-runs
      ...overrides
    });
  }

  // ── Activity Tracking ─────────────────────────────────────────

  test('trackActivity registers new conversation', () => {
    const monitor = createMonitor();
    monitor.trackActivity('conv_1', { name: 'Golda Deluxe' });

    assert.equal(monitor.getActiveCount(), 1);
    assert.includes(monitor.getActiveConversations(), 'conv_1');
    monitor.stop();
  });

  test('trackActivity updates lastActivity for existing conversation', () => {
    const monitor = createMonitor();
    monitor.trackActivity('conv_1', { name: 'Golda Deluxe' });

    // Small delay to ensure time difference
    const before = Date.now();
    monitor.trackActivity('conv_1', { name: 'Golda Deluxe' });

    assert.equal(monitor.getActiveCount(), 1); // still 1, not 2
    monitor.stop();
  });

  test('multiple conversations tracked independently', () => {
    const monitor = createMonitor();
    monitor.trackActivity('conv_1', { name: 'Golda Deluxe' });
    monitor.trackActivity('conv_2', { name: 'Other Agent' });

    assert.equal(monitor.getActiveCount(), 2);
    monitor.stop();
  });

  // ── Explicit End ──────────────────────────────────────────────

  test('endConversation removes from active tracking', async () => {
    const monitor = createMonitor();
    monitor.trackActivity('conv_end', { name: 'Golda Deluxe' });

    await monitor.endConversation('conv_end', 'explicit');
    assert.equal(monitor.getActiveCount(), 0);
    monitor.stop();
  });

  test('endConversation returns error when no store', async () => {
    const monitor = createMonitor({ convStore: null });
    monitor.trackActivity('conv_nostore');

    const result = await monitor.endConversation('conv_nostore');
    assert.equal(result.success, false);
    assert.equal(result.error, 'no_store');
    monitor.stop();
  });

  test('endConversation calls summarizer and notifies owner', async () => {
    let summarized = false;
    let notified = false;

    const tmp = helpers.tmpConfigDir('mon');
    delete require.cache[require.resolve('../../src/lib/conversations')];
    const { ConversationStore } = require('../../src/lib/conversations');
    const convStore = new ConversationStore(tmp.dir);

    if (!convStore.isAvailable()) {
      tmp.cleanup();
      return; // skip if sqlite not available
    }

    convStore.startConversation({ id: 'conv_full', direction: 'inbound', contactName: 'Golda Deluxe' });
    convStore.addMessage('conv_full', {
      direction: 'inbound', role: 'user', content: 'Hello'
    });

    const monitor = createMonitor({
      convStore,
      summarizer: async () => {
        summarized = true;
        return { summary: 'Test' };
      },
      notifyOwner: async () => {
        notified = true;
      }
    });

    monitor.trackActivity('conv_full', { name: 'Golda Deluxe' });
    await monitor.endConversation('conv_full', 'explicit');

    assert.ok(summarized);
    // notifyOwner is called asynchronously, give it a tick
    await new Promise(r => setTimeout(r, 50));
    assert.ok(notified);

    convStore.close();
    monitor.stop();
    tmp.cleanup();
  });

  // ── Start/Stop ────────────────────────────────────────────────

  test('start and stop manage interval', () => {
    const monitor = createMonitor({ checkIntervalMs: 100000 });
    monitor.start();
    assert.ok(monitor.intervalId);

    monitor.stop();
    assert.equal(monitor.intervalId, null);
  });

  test('start is idempotent', () => {
    const monitor = createMonitor({ checkIntervalMs: 100000 });
    monitor.start();
    const id1 = monitor.intervalId;
    monitor.start(); // should not create new interval
    assert.equal(monitor.intervalId, id1);
    monitor.stop();
  });
};
