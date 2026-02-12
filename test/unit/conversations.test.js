/**
 * Conversation Storage Tests
 *
 * Covers: SQLite initialization, conversation lifecycle,
 * message storage, summarization, listing, timeout,
 * compression, and context retrieval.
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  function freshStore() {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('conv');
    delete require.cache[require.resolve('../../src/lib/conversations')];
    const { ConversationStore } = require('../../src/lib/conversations');
    const store = new ConversationStore(tmp.dir);
    return store;
  }

  // ── Availability ──────────────────────────────────────────────

  test('isAvailable returns true when sqlite is installed', () => {
    const store = freshStore();
    // better-sqlite3 is in package.json dependencies
    assert.ok(store.isAvailable());
    store.close();
    tmp.cleanup();
  });

  // ── Conversation Lifecycle ────────────────────────────────────

  test('startConversation creates new conversation', () => {
    const store = freshStore();
    const result = store.startConversation({
      id: 'conv_test_001',
      contactId: 'tok_golda',
      contactName: 'Golda Deluxe',
      tokenId: 'tok_golda',
      direction: 'inbound'
    });

    assert.equal(result.id, 'conv_test_001');
    assert.equal(result.resumed, false);

    store.close();
    tmp.cleanup();
  });

  test('startConversation resumes existing conversation', () => {
    const store = freshStore();

    store.startConversation({ id: 'conv_resume', direction: 'inbound' });
    const result = store.startConversation({ id: 'conv_resume', direction: 'inbound' });

    assert.equal(result.id, 'conv_resume');
    assert.equal(result.resumed, true);

    store.close();
    tmp.cleanup();
  });

  test('startConversation generates ID when not provided', () => {
    const store = freshStore();
    const result = store.startConversation({ direction: 'outbound' });
    assert.match(result.id, /^conv_/);

    store.close();
    tmp.cleanup();
  });

  // ── Message Storage ───────────────────────────────────────────

  test('addMessage stores and increments message count', () => {
    const store = freshStore();

    store.startConversation({ id: 'conv_msg', direction: 'inbound' });

    const msg1 = store.addMessage('conv_msg', {
      direction: 'inbound',
      role: 'user',
      content: 'Hello from Golda Deluxe!'
    });
    assert.match(msg1.id, /^msg_/);
    assert.ok(msg1.timestamp);

    store.addMessage('conv_msg', {
      direction: 'outbound',
      role: 'assistant',
      content: 'Welcome, Golda! How can I help?'
    });

    const conv = store.getConversation('conv_msg');
    assert.equal(conv.message_count, 2);
    assert.equal(conv.messages.length, 2);
    const contents = conv.messages.map(m => m.content);
    assert.ok(contents.includes('Hello from Golda Deluxe!'));
    assert.ok(contents.includes('Welcome, Golda! How can I help?'));
    const roles = conv.messages.map(m => m.role);
    assert.ok(roles.includes('user'));
    assert.ok(roles.includes('assistant'));

    store.close();
    tmp.cleanup();
  });

  test('addMessage stores metadata as JSON', () => {
    const store = freshStore();
    store.startConversation({ id: 'conv_meta', direction: 'inbound' });

    store.addMessage('conv_meta', {
      direction: 'inbound',
      role: 'user',
      content: 'Test',
      metadata: { tier: 'friends', topic: 'market-analysis' }
    });

    const conv = store.getConversation('conv_meta');
    const meta = JSON.parse(conv.messages[0].metadata);
    assert.equal(meta.tier, 'friends');
    assert.equal(meta.topic, 'market-analysis');

    store.close();
    tmp.cleanup();
  });

  // ── Conversation Retrieval ────────────────────────────────────

  test('getConversation returns null for nonexistent', () => {
    const store = freshStore();
    assert.equal(store.getConversation('conv_nope'), null);
    store.close();
    tmp.cleanup();
  });

  test('getConversation respects messageLimit', () => {
    const store = freshStore();
    store.startConversation({ id: 'conv_limit', direction: 'inbound' });

    for (let i = 0; i < 10; i++) {
      store.addMessage('conv_limit', {
        direction: 'inbound',
        role: 'user',
        content: `Message ${i}`
      });
    }

    const conv = store.getConversation('conv_limit', { messageLimit: 3 });
    assert.equal(conv.messages.length, 3);
    // Total count should reflect all messages
    assert.equal(conv.message_count, 10);

    store.close();
    tmp.cleanup();
  });

  // ── Listing ───────────────────────────────────────────────────

  test('listConversations with filters', () => {
    const store = freshStore();

    store.startConversation({ id: 'conv_a', contactId: 'golda', direction: 'inbound' });
    store.startConversation({ id: 'conv_b', contactId: 'other', direction: 'outbound' });

    const all = store.listConversations();
    assert.equal(all.length, 2);

    const golda = store.listConversations({ contactId: 'golda' });
    assert.equal(golda.length, 1);
    assert.equal(golda[0].id, 'conv_a');

    store.close();
    tmp.cleanup();
  });

  test('listConversations filters by status', () => {
    const store = freshStore();

    store.startConversation({ id: 'conv_active', direction: 'inbound' });
    store.startConversation({ id: 'conv_done', direction: 'inbound' });
    store.timeoutConversation('conv_done');

    const active = store.listConversations({ status: 'active' });
    assert.equal(active.length, 1);
    assert.equal(active[0].id, 'conv_active');

    store.close();
    tmp.cleanup();
  });

  // ── Conclusion & Summarization ────────────────────────────────

  test('concludeConversation marks as concluded', async () => {
    const store = freshStore();
    store.startConversation({ id: 'conv_end', direction: 'inbound' });
    store.addMessage('conv_end', {
      direction: 'inbound', role: 'user', content: 'Hello'
    });

    const result = await store.concludeConversation('conv_end');
    assert.ok(result.success);
    assert.ok(result.endedAt);

    const conv = store.getConversation('conv_end');
    assert.equal(conv.status, 'concluded');

    store.close();
    tmp.cleanup();
  });

  test('concludeConversation with summarizer stores summary', async () => {
    const store = freshStore();
    store.startConversation({ id: 'conv_sum', contactName: 'Golda Deluxe', direction: 'inbound' });
    store.addMessage('conv_sum', {
      direction: 'inbound', role: 'user', content: 'Let us discuss markets'
    });
    store.addMessage('conv_sum', {
      direction: 'outbound', role: 'assistant', content: 'I agree, markets are fascinating'
    });

    const mockSummarizer = async (messages, ownerContext) => ({
      summary: 'Discussed market trends',
      ownerSummary: 'Golda wants to talk markets — potential lead',
      relevance: 'high',
      goalsTouched: ['market-analysis'],
      ownerActionItems: ['Research Golda\'s background'],
      callerActionItems: ['Send portfolio examples'],
      jointActionItems: ['Schedule follow-up call'],
      collaborationOpportunity: { level: 'HIGH', detail: 'Market analysis partnership' },
      followUp: 'Schedule 30-min deep dive next week',
      notes: 'Golda seems well-connected in luxury markets'
    });

    const result = await store.concludeConversation('conv_sum', {
      summarizer: mockSummarizer
    });

    assert.ok(result.success);
    assert.equal(result.summary, 'Discussed market trends');

    const conv = store.getConversation('conv_sum');
    assert.equal(conv.owner_summary, 'Golda wants to talk markets — potential lead');
    assert.equal(conv.owner_relevance, 'high');
    assert.deepEqual(conv.owner_goals_touched, ['market-analysis']);

    store.close();
    tmp.cleanup();
  });

  test('concludeConversation returns error for unknown id', async () => {
    const store = freshStore();
    const result = await store.concludeConversation('conv_nope');
    assert.equal(result.success, false);
    assert.equal(result.error, 'conversation_not_found');
    store.close();
    tmp.cleanup();
  });

  // ── Timeout ───────────────────────────────────────────────────

  test('timeoutConversation sets status to timeout', () => {
    const store = freshStore();
    store.startConversation({ id: 'conv_timeout', direction: 'inbound' });

    store.timeoutConversation('conv_timeout');
    const conv = store.getConversation('conv_timeout');
    assert.equal(conv.status, 'timeout');

    store.close();
    tmp.cleanup();
  });

  test('getActiveConversations finds stale conversations', () => {
    const store = freshStore();
    store.startConversation({ id: 'conv_stale', direction: 'inbound' });

    // Manually backdate last_message_at
    store.db.prepare(`
      UPDATE conversations SET last_message_at = datetime('now', '-5 minutes')
      WHERE id = ?
    `).run('conv_stale');

    const stale = store.getActiveConversations(60000); // 1 minute threshold
    assert.equal(stale.length, 1);
    assert.equal(stale[0].id, 'conv_stale');

    store.close();
    tmp.cleanup();
  });

  // ── Context Retrieval ─────────────────────────────────────────

  test('getConversationContext returns structured context', async () => {
    const store = freshStore();
    store.startConversation({
      id: 'conv_ctx',
      contactName: 'Golda Deluxe',
      direction: 'inbound'
    });
    store.addMessage('conv_ctx', {
      direction: 'inbound', role: 'user', content: 'Testing context retrieval'
    });

    await store.concludeConversation('conv_ctx', {
      summarizer: async () => ({
        summary: 'Context test',
        ownerSummary: 'Owner perspective',
        relevance: 'medium',
        goalsTouched: ['testing'],
        ownerActionItems: ['Review test results'],
        collaborationOpportunity: { level: 'MEDIUM', detail: 'Test' },
        followUp: 'Re-test next week'
      })
    });

    const ctx = store.getConversationContext('conv_ctx');
    assert.ok(ctx);
    assert.equal(ctx.contact, 'Golda Deluxe');
    assert.equal(ctx.summary, 'Context test');
    assert.ok(ctx.ownerContext);
    assert.equal(ctx.ownerContext.summary, 'Owner perspective');
    assert.equal(ctx.ownerContext.relevance, 'medium');
    assert.equal(ctx.status, 'concluded');

    store.close();
    tmp.cleanup();
  });

  test('getConversationContext returns null for unknown', () => {
    const store = freshStore();
    assert.equal(store.getConversationContext('nope'), null);
    store.close();
    tmp.cleanup();
  });

  // ── Compression ───────────────────────────────────────────────

  test('compressOldMessages compresses old content', () => {
    const store = freshStore();
    store.startConversation({ id: 'conv_compress', direction: 'inbound' });
    store.addMessage('conv_compress', {
      direction: 'inbound', role: 'user', content: 'Old message to compress'
    });

    // Backdate the message
    store.db.prepare(`
      UPDATE messages SET timestamp = datetime('now', '-30 days')
      WHERE conversation_id = ?
    `).run('conv_compress');

    const result = store.compressOldMessages(7);
    assert.equal(result.compressed, 1);
    assert.equal(result.total, 1);

    // Verify the message is marked as compressed
    const msg = store.db.prepare('SELECT * FROM messages WHERE conversation_id = ?').get('conv_compress');
    assert.equal(msg.compressed, 1);

    store.close();
    tmp.cleanup();
  });
};
