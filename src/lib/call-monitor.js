/**
 * Call Monitor - Auto-concludes idle conversations
 * 
 * Monitors active conversations and triggers summarization when:
 * - No messages for 60 seconds (configurable)
 * - Explicit end signal received
 * - Max duration exceeded
 */

class CallMonitor {
  constructor(options = {}) {
    this.convStore = options.convStore;
    this.summarizer = options.summarizer;
    this.notifyOwner = options.notifyOwner || (() => {});
    this.ownerContext = options.ownerContext || {};
    
    // Timing config
    this.idleTimeoutMs = options.idleTimeoutMs || 60000;      // 60s idle
    this.maxDurationMs = options.maxDurationMs || 300000;     // 5min max
    this.checkIntervalMs = options.checkIntervalMs || 10000;  // Check every 10s
    
    this.intervalId = null;
    this.activeConversations = new Map(); // conversationId -> { startTime, lastActivity, callerInfo }
  }

  /**
   * Start monitoring
   */
  start() {
    if (this.intervalId) return;
    
    this.intervalId = setInterval(() => {
      this._checkIdleConversations();
    }, this.checkIntervalMs);
    
    console.log('[a2a] Call monitor started');
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[a2a] Call monitor stopped');
    }
  }

  /**
   * Track a new or continuing conversation
   */
  trackActivity(conversationId, callerInfo = {}) {
    const now = Date.now();
    const existing = this.activeConversations.get(conversationId);
    
    if (existing) {
      existing.lastActivity = now;
    } else {
      this.activeConversations.set(conversationId, {
        startTime: now,
        lastActivity: now,
        callerInfo
      });
    }
  }

  /**
   * Explicitly end a conversation
   */
  async endConversation(conversationId, reason = 'explicit') {
    const convData = this.activeConversations.get(conversationId);
    this.activeConversations.delete(conversationId);
    
    if (!this.convStore) return { success: false, error: 'no_store' };
    
    try {
      const result = await this.convStore.concludeConversation(conversationId, {
        summarizer: this.summarizer,
        ownerContext: this.ownerContext
      });
      
      if (result.success) {
        // Notify owner
        const context = this.convStore.getConversationContext(conversationId);
        this.notifyOwner({
          type: 'conversation_concluded',
          reason,
          conversation: context,
          callerInfo: convData?.callerInfo
        }).catch(err => {
          console.error('[a2a] Failed to notify owner:', err.message);
        });
      }
      
      return result;
    } catch (err) {
      console.error('[a2a] Failed to conclude conversation:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Check for idle conversations
   */
  async _checkIdleConversations() {
    const now = Date.now();
    
    for (const [convId, data] of this.activeConversations) {
      const idleTime = now - data.lastActivity;
      const duration = now - data.startTime;
      
      // Check max duration
      if (duration > this.maxDurationMs) {
        console.log(`[a2a] Conversation ${convId} exceeded max duration, concluding...`);
        await this.endConversation(convId, 'max_duration');
        continue;
      }
      
      // Check idle timeout
      if (idleTime > this.idleTimeoutMs) {
        console.log(`[a2a] Conversation ${convId} idle for ${Math.round(idleTime / 1000)}s, concluding...`);
        await this.endConversation(convId, 'idle_timeout');
      }
    }
  }

  /**
   * Get active conversation count
   */
  getActiveCount() {
    return this.activeConversations.size;
  }

  /**
   * Get all active conversation IDs
   */
  getActiveConversations() {
    return Array.from(this.activeConversations.keys());
  }
}

module.exports = { CallMonitor };
