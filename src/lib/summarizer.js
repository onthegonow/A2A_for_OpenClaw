/**
 * Conversation summarizer for A2A federation
 * 
 * Provides a default summarizer interface and a simple implementation.
 * OpenClaw installations can provide their own summarizer via config.
 */

/**
 * Default summarizer using simple extraction (no LLM)
 * Returns basic summary without owner context
 */
function defaultSummarizer(messages, ownerContext = {}) {
  if (!messages || messages.length === 0) {
    return { summary: null };
  }

  // Extract key information
  const messageCount = messages.length;
  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1];
  const inboundCount = messages.filter(m => m.direction === 'inbound').length;
  const outboundCount = messages.filter(m => m.direction === 'outbound').length;

  // Simple extractive summary (first message + last message)
  const summary = `${messageCount} messages exchanged. Started: "${truncate(firstMessage.content, 100)}". Ended: "${truncate(lastMessage.content, 100)}"`;

  return {
    summary,
    ownerSummary: null, // No owner context without LLM
    relevance: 'unknown',
    goalsTouched: [],
    actionItems: [],
    followUp: null,
    notes: null
  };
}

/**
 * Create a summarizer that uses an LLM via a callback
 * 
 * @param {function} llmCall - async function(prompt) => string
 * @returns {function} summarizer function
 */
function createLLMSummarizer(llmCall) {
  return async function(messages, ownerContext = {}) {
    if (!messages || messages.length === 0) {
      return { summary: null };
    }

    // Format messages for prompt
    const messageText = messages.map(m => {
      const role = m.direction === 'inbound' ? 'Caller' : 'You';
      return `${role}: ${m.content}`;
    }).join('\n');

    // Build owner context section
    let ownerSection = '';
    if (ownerContext.goals) {
      ownerSection += `\nOwner's current goals:\n${ownerContext.goals.join('\n- ')}`;
    }
    if (ownerContext.interests) {
      ownerSection += `\nOwner's interests:\n${ownerContext.interests.join('\n- ')}`;
    }
    if (ownerContext.context) {
      ownerSection += `\nAdditional context:\n${ownerContext.context}`;
    }

    const prompt = `You are summarizing a conversation between two AI agents for the receiving agent's owner.
${ownerSection}

Conversation:
${messageText}

Provide a JSON response with:
{
  "summary": "Brief neutral summary of what was discussed",
  "ownerSummary": "Summary from the owner's perspective - what does this mean for them?",
  "relevance": "low/medium/high - how relevant to owner's goals",
  "goalsTouched": ["list", "of", "goals", "this", "relates", "to"],
  "actionItems": ["any", "action", "items", "for", "owner"],
  "followUp": "Suggested follow-up if any",
  "notes": "Any other relevant notes for the owner"
}

JSON response:`;

    try {
      const response = await llmCall(prompt);
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      // Fallback if JSON extraction fails
      return {
        summary: response,
        ownerSummary: null,
        relevance: 'unknown',
        goalsTouched: [],
        actionItems: [],
        followUp: null,
        notes: null
      };
    } catch (err) {
      console.error('[a2a] LLM summarization failed:', err.message);
      return defaultSummarizer(messages, ownerContext);
    }
  };
}

/**
 * Summarizer that calls OpenClaw's sessions_send to use the main agent
 * This allows using the owner's configured model
 */
function createOpenClawSummarizer(openclawConfig = {}) {
  return async function(messages, ownerContext = {}) {
    // This would integrate with OpenClaw's internal APIs
    // For now, fall back to default
    console.warn('[a2a] OpenClaw summarizer not yet integrated, using default');
    return defaultSummarizer(messages, ownerContext);
  };
}

/**
 * Truncate string with ellipsis
 */
function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

module.exports = {
  defaultSummarizer,
  createLLMSummarizer,
  createOpenClawSummarizer
};
