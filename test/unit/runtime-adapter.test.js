/**
 * Runtime adapter tests
 *
 * Verifies platform auto-detection and generic fallback behavior.
 */

module.exports = function (test, assert) {
  async function withEnv(patch, fn) {
    const original = {};
    for (const [key, value] of Object.entries(patch)) {
      original[key] = Object.prototype.hasOwnProperty.call(process.env, key)
        ? process.env[key]
        : undefined;
      if (value === undefined || value === null) {
        delete process.env[key];
      } else {
        process.env[key] = String(value);
      }
    }

    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  function loadAdapterModule() {
    delete require.cache[require.resolve('../../src/lib/runtime-adapter')];
    return require('../../src/lib/runtime-adapter');
  }

  test('resolveRuntimeMode honors forced generic mode', async () => {
    await withEnv({ A2A_RUNTIME: 'generic' }, () => {
      const { resolveRuntimeMode } = loadAdapterModule();
      const mode = resolveRuntimeMode();
      assert.equal(mode.mode, 'generic');
      assert.equal(mode.requested, 'generic');
    });
  });

  test('forced openclaw mode falls back to generic when binary missing', async () => {
    await withEnv(
      {
        A2A_RUNTIME: 'openclaw',
        PATH: '/tmp/a2a-runtime-adapter-no-bin'
      },
      () => {
        const { resolveRuntimeMode } = loadAdapterModule();
        const mode = resolveRuntimeMode();
        assert.equal(mode.mode, 'generic');
        assert.equal(mode.requested, 'openclaw');
        assert.ok(Boolean(mode.warning));
      }
    );
  });

  test('generic runtime returns non-failing fallback response', async () => {
    await withEnv(
      {
        A2A_RUNTIME: 'generic',
        A2A_AGENT_COMMAND: undefined
      },
      async () => {
        const { createRuntimeAdapter } = loadAdapterModule();
        const runtime = createRuntimeAdapter({ workspaceDir: process.cwd() });
        const response = await runtime.runTurn({
          sessionId: 's1',
          prompt: 'prompt',
          message: 'Can we collaborate on integration?',
          caller: { name: 'Remote Agent' },
          context: {
            ownerName: 'Owner',
            allowedTopics: ['chat', 'integration']
          }
        });

        assert.type(response, 'string');
        assert.includes(response, 'Remote Agent');
        assert.match(response, /\?/);
      }
    );
  });

  test('generic runtime bridge command can supply response text', async () => {
    await withEnv(
      {
        A2A_RUNTIME: 'generic',
        A2A_AGENT_COMMAND: "printf '{\"response\":\"bridge response ok\"}'"
      },
      async () => {
        const { createRuntimeAdapter } = loadAdapterModule();
        const runtime = createRuntimeAdapter({ workspaceDir: process.cwd() });
        const response = await runtime.runTurn({
          sessionId: 's2',
          prompt: 'prompt',
          message: 'hello',
          caller: { name: 'Remote Agent' },
          context: {}
        });
        assert.equal(response, 'bridge response ok');
      }
    );
  });

  test('generic summary fallback always returns summary fields', async () => {
    await withEnv(
      {
        A2A_RUNTIME: 'generic',
        A2A_SUMMARY_COMMAND: undefined
      },
      async () => {
        const { createRuntimeAdapter } = loadAdapterModule();
        const runtime = createRuntimeAdapter({ workspaceDir: process.cwd() });
        const result = await runtime.summarize({
          sessionId: 'summary-1',
          prompt: 'prompt',
          callerInfo: { name: 'Remote Agent' },
          messages: [
            { direction: 'inbound', content: 'Can we collaborate?' },
            { direction: 'outbound', content: 'Yes, let us align on goals.' }
          ]
        });

        assert.ok(result && typeof result === 'object');
        assert.type(result.summary, 'string');
        assert.type(result.ownerSummary, 'string');
        assert.includes(result.summary, 'Remote Agent');
      }
    );
  });
};
