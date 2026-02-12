/**
 * Call Monitor - Auto-concludes idle conversations
 * 
 * Monitors active conversations and triggers summarization when:
 * - No messages for 60 seconds (configurable)
 * - Explicit end signal received
 * - Max duration exceeded
 */

const { createLogger } = require('./logger');

class CallMonitor {
  constructor(options = {}) {
    this.convStore = options.convStore;
    this.summarizer = options.summarizer;
    this.notifyOwner = options.notifyOwner || (() => {});
    this.ownerContext = options.ownerContext || {};
    this.logger = options.logger || createLogger({ component: 'a2a.call-monitor' });
    
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
    
    this.logger.info('Call monitor started', {
      event: 'call_monitor_started',
      data: {
        idle_timeout_ms: this.idleTimeoutMs,
        max_duration_ms: this.maxDurationMs,
        check_interval_ms: this.checkIntervalMs
      }
    });
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.logger.info('Call monitor stopped', { event: 'call_monitor_stopped' });
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
      this.logger.debug('Tracking new conversation activity', {
        event: 'call_monitor_track_new',
        conversationId,
        traceId: callerInfo?.trace_id || callerInfo?.traceId,
        data: {
          caller_name: callerInfo?.name || null
        }
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
      this.logger.info('Concluding conversation', {
        event: 'call_monitor_end_conversation',
        conversationId,
        traceId: convData?.callerInfo?.trace_id || convData?.callerInfo?.traceId,
        data: {
          reason
        }
      });
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
          this.logger.error('Failed to notify owner after conversation conclusion', {
            event: 'call_monitor_owner_notify_failed',
            conversationId,
            traceId: convData?.callerInfo?.trace_id || convData?.callerInfo?.traceId,
            error_code: 'CALL_MONITOR_OWNER_NOTIFY_FAILED',
            hint: 'Check notification runtime and owner notification handler reliability.',
            error: err,
            data: {
              reason
            }
          });
        });
      }
      
      return result;
    } catch (err) {
      this.logger.error('Failed to conclude conversation', {
        event: 'call_monitor_conclude_failed',
        conversationId,
        traceId: convData?.callerInfo?.trace_id || convData?.callerInfo?.traceId,
        error_code: 'CALL_MONITOR_CONCLUDE_FAILED',
        hint: 'Check conversation store write access and summarizer function stability.',
        error: err,
        data: {
          reason
        }
      });
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
        this.logger.info('Conversation exceeded max duration; concluding', {
          event: 'call_monitor_max_duration',
          conversationId: convId,
          traceId: data?.callerInfo?.trace_id || data?.callerInfo?.traceId,
          data: {
            duration_ms: duration,
            max_duration_ms: this.maxDurationMs
          }
        });
        await this.endConversation(convId, 'max_duration');
        continue;
      }
      
      // Check idle timeout
      if (idleTime > this.idleTimeoutMs) {
        this.logger.info('Conversation idle timeout reached; concluding', {
          event: 'call_monitor_idle_timeout',
          conversationId: convId,
          traceId: data?.callerInfo?.trace_id || data?.callerInfo?.traceId,
          data: {
            idle_ms: idleTime,
            idle_timeout_ms: this.idleTimeoutMs
          }
        });
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
