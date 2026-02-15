/**
 * Conversation Driver Tests
 *
 * Covers: multi-turn conversation orchestration with mock runtime and mock A2AClient.
 * Verifies: driver completes a conversation, tracks state, calls end(), respects turn limits.
 */

module.exports = function (test, assert, helpers) {

  function createMockRuntime(responses) {
    let callIndex = 0;
    return {
      mode: 'mock',
      runTurn: async ({ sessionId, prompt, message }) => {
        const response = responses[callIndex] || 'Mock response';
        callIndex++;
        return response;
      }
    };
  }

  function createMockClient(remoteResponses) {
    let callIndex = 0;
    let endCalled = false;
    let endConversationId = null;

    return {
      callHistory: [],
      getEndCalled: () => endCalled,
      getEndConversationId: () => endConversationId,
      call: async (endpoint, message, options) => {
        const resp = remoteResponses[callIndex] || {
          response: 'Remote says hello',
          can_continue: true,
          conversation_id: options?.conversationId || 'conv_mock'
        };
        callIndex++;
        return resp;
      },
      end: async (endpoint, conversationId) => {
        endCalled = true;
        endConversationId = conversationId;
        return { success: true };
      }
    };
  }

  test('ConversationDriver exports correctly', () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');
    assert.ok(ConversationDriver);
    assert.type(ConversationDriver, 'function');
  });

  test('driver completes conversation with mock runtime', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    // Remote will respond 3 times then signal close
    const remoteResponses = [
      { response: 'Hello back!', can_continue: true, conversation_id: 'conv_test1' },
      { response: 'Interesting topic', can_continue: true, conversation_id: 'conv_test1' },
      { response: 'Lets wrap up', can_continue: false, conversation_id: 'conv_test1' }
    ];

    // Runtime generates our replies
    const runtimeResponses = [
      'Tell me about your capabilities',
      'That sounds promising'
    ];

    const mockRuntime = createMockRuntime(runtimeResponses);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 2,
      maxTurns: 10
    });

    // Override the client with our mock
    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');

    assert.ok(result.conversationId);
    assert.ok(result.turnCount >= 1);
    assert.ok(result.transcript.length > 0);
    assert.ok(mockClient.getEndCalled(), 'end() should be called');
  });

  test('driver respects maxTurns limit', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    // Remote always continues
    const remoteResponses = Array.from({ length: 10 }, (_, i) => ({
      response: `Turn ${i + 1} response`,
      can_continue: true,
      conversation_id: 'conv_max'
    }));

    const runtimeResponses = Array.from({ length: 10 }, (_, i) =>
      `My turn ${i + 1} message`
    );

    const mockRuntime = createMockRuntime(runtimeResponses);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 2,
      maxTurns: 4
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');

    // Should not exceed maxTurns
    assert.ok(result.turnCount <= 4, `turnCount ${result.turnCount} should be <= 4`);
    assert.ok(mockClient.getEndCalled());
  });

  test('driver calls onTurn callback', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const remoteResponses = [
      { response: 'Hello', can_continue: true, conversation_id: 'conv_cb' },
      { response: 'Bye', can_continue: false, conversation_id: 'conv_cb' }
    ];

    const runtimeResponses = ['My reply'];
    const mockRuntime = createMockRuntime(runtimeResponses);
    const turnCallbacks = [];

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 5,
      onTurn: (info) => turnCallbacks.push(info)
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    await driver.run('Hello!');

    // Should have at least one callback from the intermediate turns
    for (const cb of turnCallbacks) {
      assert.ok(cb.turn);
      assert.ok(cb.phase);
      assert.ok(cb.overlapScore != null);
    }
  });

  test('driver stores messages in convStore when provided', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const messages = [];
    const mockConvStore = {
      startConversation: () => ({ id: 'conv_store_test' }),
      addMessage: (convId, msg) => {
        messages.push({ convId, ...msg });
        return { id: 'msg_test' };
      },
      saveCollabState: () => ({ success: true }),
      concludeConversation: async () => ({ success: true })
    };

    const remoteResponses = [
      { response: 'Got it', can_continue: false, conversation_id: 'conv_store_test' }
    ];

    const mockRuntime = createMockRuntime([]);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      convStore: mockConvStore,
      minTurns: 1,
      maxTurns: 5
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    await driver.run('Hello!');

    // Should have stored outbound and inbound messages
    assert.ok(messages.length >= 2, `Expected at least 2 messages, got ${messages.length}`);
    const outbound = messages.find(m => m.direction === 'outbound');
    const inbound = messages.find(m => m.direction === 'inbound');
    assert.ok(outbound, 'Should have an outbound message');
    assert.ok(inbound, 'Should have an inbound message');
  });

  test('driver handles runtime failure gracefully', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const remoteResponses = [
      { response: 'Hello', can_continue: true, conversation_id: 'conv_fail' }
    ];

    const mockRuntime = {
      mode: 'mock',
      runTurn: async () => { throw new Error('Runtime exploded'); }
    };

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 5
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    // Should not throw — driver handles errors internally
    const result = await driver.run('Hello!');
    assert.ok(result.conversationId);
    assert.ok(result.turnCount >= 1);
    assert.ok(mockClient.getEndCalled());
  });
};
