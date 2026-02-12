/**
 * Summarizer Tests
 *
 * Covers: default extractive summarizer, LLM summarizer creation,
 * and edge cases.
 */

module.exports = function (test, assert, helpers) {

  test('defaultSummarizer returns null for empty messages', () => {
    delete require.cache[require.resolve('../../src/lib/summarizer')];
    const { defaultSummarizer } = require('../../src/lib/summarizer');

    const result = defaultSummarizer([]);
    assert.equal(result.summary, null);
  });

  test('defaultSummarizer returns null for null messages', () => {
    delete require.cache[require.resolve('../../src/lib/summarizer')];
    const { defaultSummarizer } = require('../../src/lib/summarizer');

    const result = defaultSummarizer(null);
    assert.equal(result.summary, null);
  });

  test('defaultSummarizer extracts first and last message', () => {
    delete require.cache[require.resolve('../../src/lib/summarizer')];
    const { defaultSummarizer } = require('../../src/lib/summarizer');

    const messages = [
      { direction: 'inbound', role: 'user', content: 'Hello from Golda Deluxe' },
      { direction: 'outbound', role: 'assistant', content: 'Welcome Golda!' },
      { direction: 'inbound', role: 'user', content: 'Let us discuss markets' },
      { direction: 'outbound', role: 'assistant', content: 'Sounds great, goodbye' }
    ];

    const result = defaultSummarizer(messages);
    assert.includes(result.summary, '4 messages');
    assert.includes(result.summary, 'Hello from Golda Deluxe');
    assert.includes(result.summary, 'goodbye');
    assert.equal(result.relevance, 'unknown');
    assert.deepEqual(result.goalsTouched, []);
  });

  test('createLLMSummarizer calls LLM with formatted prompt', async () => {
    delete require.cache[require.resolve('../../src/lib/summarizer')];
    const { createLLMSummarizer } = require('../../src/lib/summarizer');

    let capturedPrompt = null;
    const mockLLM = async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        summary: 'Test summary',
        ownerSummary: 'Owner view',
        relevance: 'high',
        goalsTouched: ['market-analysis'],
        actionItems: ['Follow up'],
        followUp: 'Next week',
        notes: 'Good lead'
      });
    };

    const summarizer = createLLMSummarizer(mockLLM);
    const result = await summarizer(
      [
        { direction: 'inbound', role: 'user', content: 'Hello' },
        { direction: 'outbound', role: 'assistant', content: 'Hi there' }
      ],
      { goals: ['market-analysis'], interests: ['luxury goods'] }
    );

    assert.equal(result.summary, 'Test summary');
    assert.equal(result.relevance, 'high');
    assert.ok(capturedPrompt.includes('market-analysis'));
    assert.ok(capturedPrompt.includes('luxury goods'));
  });

  test('createLLMSummarizer falls back on JSON parse failure', async () => {
    delete require.cache[require.resolve('../../src/lib/summarizer')];
    const { createLLMSummarizer } = require('../../src/lib/summarizer');

    const summarizer = createLLMSummarizer(async () => 'Not JSON at all');
    const result = await summarizer([
      { direction: 'inbound', role: 'user', content: 'Test' }
    ]);

    // Should fall back to using the raw response as summary
    assert.equal(result.summary, 'Not JSON at all');
  });

  test('createLLMSummarizer falls back to default on error', async () => {
    delete require.cache[require.resolve('../../src/lib/summarizer')];
    const { createLLMSummarizer } = require('../../src/lib/summarizer');

    const summarizer = createLLMSummarizer(async () => {
      throw new Error('LLM unavailable');
    });

    const result = await summarizer([
      { direction: 'inbound', role: 'user', content: 'Hello' },
      { direction: 'outbound', role: 'assistant', content: 'Bye' }
    ]);

    // Falls back to defaultSummarizer
    assert.includes(result.summary, '2 messages');
  });
};
