/**
 * Conversation Driver — Outbound multi-turn orchestrator
 *
 * Drives a full multi-turn A2A conversation with a remote agent:
 *   1. Send message to remote via A2AClient.call()
 *   2. Store messages in DB
 *   3. Check close conditions
 *   4. Build prompt via buildAdaptiveConnectionPrompt()
 *   5. Call runtime.runTurn() to generate next message
 *   6. Extract collab state from response
 *   7. Persist collab state to DB
 *   8. Repeat until close conditions met
 *   9. Call A2AClient.end() and conclude locally
 */

const { A2AClient } = require('./client');
const {
  buildAdaptiveConnectionPrompt,
  extractCollaborationState
} = require('./prompt-template');
const { getTopicsForTier, formatTopicsForPrompt, loadManifest } = require('./disclosure');
const { createLogger } = require('./logger');

const logger = createLogger({ component: 'a2a.conversation-driver' });

class ConversationDriver {
  /**
   * @param {object} options
   * @param {object} options.runtime - Runtime adapter with runTurn()
   * @param {object} options.agentContext - { name, owner }
   * @param {object} options.caller - Caller identity { name, owner, instance }
   * @param {string|object} options.endpoint - a2a:// URL or {host, token}
   * @param {object} [options.convStore] - ConversationStore instance
   * @param {object} [options.disclosure] - Disclosure manifest override
   * @param {number} [options.minTurns=8] - Minimum turns before close
   * @param {number} [options.maxTurns=30] - Maximum turns
   * @param {function} [options.onTurn] - Callback per turn: (turnInfo) => void
   * @param {string} [options.tier='public'] - Access tier
   */
  constructor(options) {
    this.runtime = options.runtime;
    this.agentContext = options.agentContext;
    this.caller = options.caller || {};
    this.endpoint = options.endpoint;
    this.convStore = options.convStore || null;
    this.disclosure = options.disclosure || null;
    this.minTurns = options.minTurns || 8;
    this.maxTurns = options.maxTurns || 30;
    this.onTurn = options.onTurn || null;
    this.tier = options.tier || 'public';

    this.client = new A2AClient({ caller: this.caller, timeout: 65000 });
  }

  /**
   * Run the full multi-turn conversation
   *
   * @param {string} openingMessage - First message to send
   * @returns {Promise<{conversationId, turnCount, collabState, transcript}>}
   */
  async run(openingMessage) {
    const transcript = [];
    let conversationId = null;

    const collabState = {
      phase: 'handshake',
      turnCount: 0,
      overlapScore: 0.15,
      activeThreads: [],
      candidateCollaborations: [],
      openQuestions: [],
      closeSignal: false,
      confidence: 0.25
    };

    // Start conversation in DB if available
    if (this.convStore) {
      const convResult = this.convStore.startConversation({ direction: 'outbound' });
      conversationId = convResult.id;
    } else {
      conversationId = `conv_${Date.now()}_local`;
    }

    let nextMessage = openingMessage;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      // 1. Send message to remote
      let remoteResponse;
      try {
        remoteResponse = await this.client.call(this.endpoint, nextMessage, {
          conversationId
        });
      } catch (err) {
        logger.error('Remote call failed', {
          event: 'driver_remote_call_failed',
          error: err,
          data: { turn, conversationId }
        });
        break;
      }

      // Update conversation ID from remote if first turn
      if (turn === 0 && remoteResponse.conversation_id) {
        conversationId = remoteResponse.conversation_id;
      }

      const remoteText = remoteResponse.response || '';
      const remoteContinue = remoteResponse.can_continue !== false;

      // 2. Store messages in DB
      if (this.convStore) {
        this.convStore.addMessage(conversationId, {
          direction: 'outbound',
          role: 'user',
          content: nextMessage
        });
        this.convStore.addMessage(conversationId, {
          direction: 'inbound',
          role: 'assistant',
          content: remoteText
        });
      }

      transcript.push(
        { role: 'outbound', content: nextMessage },
        { role: 'inbound', content: remoteText }
      );

      collabState.turnCount = turn + 1;

      // 3. Check close conditions
      if (!remoteContinue) {
        logger.info('Remote signaled conversation end', {
          event: 'driver_remote_close',
          data: { turn: turn + 1, conversationId }
        });
        break;
      }

      if (collabState.closeSignal && collabState.turnCount >= this.minTurns) {
        logger.info('Local close signal met minimum turns', {
          event: 'driver_local_close',
          data: { turn: turn + 1, conversationId }
        });
        break;
      }

      // Don't generate a reply on the last possible turn
      if (turn + 1 >= this.maxTurns) {
        break;
      }

      // 4. Build prompt for our turn
      const manifest = this.disclosure || loadManifest();
      const tierTopics = getTopicsForTier(this.tier);
      const formattedTopics = formatTopicsForPrompt(tierTopics);

      const prompt = buildAdaptiveConnectionPrompt({
        agentName: this.agentContext.name,
        ownerName: this.agentContext.owner,
        otherAgentName: this.caller.name || 'Remote Agent',
        otherOwnerName: this.caller.owner || 'their owner',
        roleContext: 'You initiated this call.',
        accessTier: this.tier,
        tierTopics: formattedTopics,
        tierGoals: [],
        otherAgentGreeting: remoteText,
        personalityNotes: manifest.personality_notes || '',
        conversationState: collabState
      });

      // 5. Call runtime.runTurn() to generate next message
      const sessionId = `a2a-${conversationId}`;
      let rawResponse;
      try {
        rawResponse = await this.runtime.runTurn({
          sessionId,
          prompt,
          message: remoteText,
          caller: this.caller,
          timeoutMs: 65000,
          context: {
            conversationId,
            tier: this.tier,
            ownerName: this.agentContext.owner
          }
        });
      } catch (err) {
        logger.error('Runtime turn failed', {
          event: 'driver_runtime_failed',
          error: err,
          data: { turn: turn + 1, conversationId }
        });
        break;
      }

      // 6. Extract collab state from response
      const parsed = extractCollaborationState(rawResponse);
      nextMessage = parsed.cleanText || rawResponse;

      if (parsed.hasState && parsed.statePatch) {
        if (parsed.statePatch.phase) collabState.phase = parsed.statePatch.phase;
        if (parsed.statePatch.overlapScore != null) {
          collabState.overlapScore = Math.max(0, Math.min(1, parsed.statePatch.overlapScore));
        }
        if (Array.isArray(parsed.statePatch.activeThreads)) {
          collabState.activeThreads = parsed.statePatch.activeThreads.slice(0, 4);
        }
        if (Array.isArray(parsed.statePatch.candidateCollaborations)) {
          collabState.candidateCollaborations = parsed.statePatch.candidateCollaborations.slice(0, 4);
        }
        if (parsed.statePatch.closeSignal != null) {
          collabState.closeSignal = Boolean(parsed.statePatch.closeSignal);
        }
        if (parsed.statePatch.confidence != null) {
          collabState.confidence = Math.max(0, Math.min(1, parsed.statePatch.confidence));
        }
      }

      // 7. Persist collab state to DB
      if (this.convStore) {
        try {
          this.convStore.saveCollabState(conversationId, collabState);
        } catch (err) {
          // Best effort
        }
      }

      // onTurn callback for progress output
      if (this.onTurn) {
        try {
          this.onTurn({
            turn: turn + 1,
            phase: collabState.phase,
            overlapScore: collabState.overlapScore,
            closeSignal: collabState.closeSignal,
            messagePreview: nextMessage.slice(0, 80)
          });
        } catch (err) {
          // Don't let callback errors break the loop
        }
      }
    }

    // 9. End conversation remotely
    try {
      await this.client.end(this.endpoint, conversationId);
    } catch (err) {
      logger.warn('Failed to end remote conversation', {
        event: 'driver_end_failed',
        error: err,
        data: { conversationId }
      });
    }

    // Conclude locally
    if (this.convStore) {
      try {
        await this.convStore.concludeConversation(conversationId);
      } catch (err) {
        // Best effort
      }
    }

    return {
      conversationId,
      turnCount: collabState.turnCount,
      collabState,
      transcript
    };
  }
}

module.exports = { ConversationDriver };
