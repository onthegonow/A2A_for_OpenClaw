/**
 * Federation API Routes
 * 
 * Mount at: /api/federation
 * 
 * Security notes:
 * - Rate limiting is in-memory (resets on restart) - for production, use Redis
 * - Body size should be limited by Express middleware (e.g., express.json({ limit: '100kb' }))
 */

const { TokenStore } = require('../lib/tokens');
const crypto = require('crypto');

// Lazy-load conversation store (optional dependency)
let ConversationStore = null;
let conversationStore = null;
function getConversationStore() {
  if (!ConversationStore) {
    try {
      ConversationStore = require('../lib/conversations').ConversationStore;
      conversationStore = new ConversationStore();
    } catch (err) {
      // Conversation storage not available
      return null;
    }
  }
  return conversationStore;
}

// Rate limiting state (in-memory - resets on restart)
// For production: use Redis or persistent store
const rateLimits = new Map();

// Constants
const MAX_MESSAGE_LENGTH = 10000;  // 10KB max message
const MAX_TIMEOUT_SECONDS = 300;   // 5 min max timeout
const MIN_TIMEOUT_SECONDS = 5;     // 5 sec min timeout

function checkRateLimit(tokenId, limits = { minute: 10, hour: 100, day: 1000 }) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const hour = Math.floor(now / 3600000);
  const day = Math.floor(now / 86400000);

  let state = rateLimits.get(tokenId);
  if (!state) {
    state = { 
      minute: { count: 0, bucket: minute }, 
      hour: { count: 0, bucket: hour }, 
      day: { count: 0, bucket: day } 
    };
    rateLimits.set(tokenId, state);
  }

  // Reset buckets if needed
  if (state.minute.bucket !== minute) state.minute = { count: 0, bucket: minute };
  if (state.hour.bucket !== hour) state.hour = { count: 0, bucket: hour };
  if (state.day.bucket !== day) state.day = { count: 0, bucket: day };

  // Check limits
  if (state.minute.count >= limits.minute) {
    return { limited: true, error: 'rate_limited', message: 'Too many requests per minute', retryAfter: 60 };
  }
  if (state.hour.count >= limits.hour) {
    return { limited: true, error: 'rate_limited', message: 'Too many requests per hour', retryAfter: 3600 };
  }
  if (state.day.count >= limits.day) {
    return { limited: true, error: 'rate_limited', message: 'Too many requests per day', retryAfter: 86400 };
  }

  // Increment
  state.minute.count++;
  state.hour.count++;
  state.day.count++;

  return { limited: false };
}

/**
 * Create federation routes
 * 
 * @param {object} options
 * @param {TokenStore} options.tokenStore - Token store instance
 * @param {function} options.handleMessage - Async function to handle incoming messages
 * @param {function} options.notifyOwner - Async function to notify owner of calls
 * @param {object} options.rateLimits - Custom rate limits { minute, hour, day }
 */
function createRoutes(options = {}) {
  const express = require('express');
  const router = express.Router();

  const tokenStore = options.tokenStore || new TokenStore();
  const handleMessage = options.handleMessage || defaultMessageHandler;
  const notifyOwner = options.notifyOwner || (() => {});
  const limits = options.rateLimits || { minute: 10, hour: 100, day: 1000 };

  /**
   * GET /status
   * Check if federation is enabled
   */
  router.get('/status', (req, res) => {
    res.json({
      federation: true,
      version: require('../../package.json').version,
      capabilities: ['invoke', 'multi-turn'],
      rate_limits: limits
    });
  });

  /**
   * GET /ping
   * Simple health check
   */
  router.get('/ping', (req, res) => {
    res.json({ pong: true, timestamp: new Date().toISOString() });
  });

  /**
   * POST /invoke
   * Call the agent
   */
  router.post('/invoke', async (req, res) => {
    // Extract token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'missing_token', 
        message: 'Authorization header required' 
      });
    }

    const token = authHeader.slice(7);

    // Validate token
    const validation = tokenStore.validate(token);
    if (!validation.valid) {
      // Use generic error to prevent token enumeration
      // All invalid token states return same response
      return res.status(401).json({ 
        success: false, 
        error: 'unauthorized', 
        message: 'Invalid or expired token' 
      });
    }

    // Check rate limit
    const rateCheck = checkRateLimit(validation.id, limits);
    if (rateCheck.limited) {
      res.set('Retry-After', rateCheck.retryAfter);
      return res.status(429).json({ 
        success: false, 
        error: rateCheck.error, 
        message: rateCheck.message 
      });
    }

    // Extract and validate request
    const { message, conversation_id, caller, context, timeout_seconds = 60 } = req.body;

    if (!message) {
      return res.status(400).json({ 
        success: false, 
        error: 'missing_message', 
        message: 'Message is required' 
      });
    }

    // Validate message length
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        error: 'invalid_message',
        message: `Message must be a string under ${MAX_MESSAGE_LENGTH} characters`
      });
    }

    // Validate and bound timeout
    const boundedTimeout = Math.max(MIN_TIMEOUT_SECONDS, Math.min(MAX_TIMEOUT_SECONDS, Number(timeout_seconds) || 60));

    // Sanitize caller data (only allow expected fields)
    const sanitizedCaller = caller ? {
      name: String(caller.name || '').slice(0, 100),
      instance: String(caller.instance || '').slice(0, 200),
      context: String(caller.context || '').slice(0, 500)
    } : {};

    // Build federation context with secure conversation ID
    const isNewConversation = !conversation_id;
    const federationContext = {
      mode: 'federation',
      token_id: validation.id,
      token_name: validation.name,
      tier: validation.tier,
      allowed_topics: validation.allowed_topics,
      disclosure: validation.disclosure,
      caller: sanitizedCaller,
      conversation_id: conversation_id || `conv_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
    };

    // Track conversation if store available
    const convStore = getConversationStore();
    if (convStore) {
      try {
        convStore.startConversation({
          id: federationContext.conversation_id,
          contactId: validation.id,
          contactName: sanitizedCaller.name || validation.name,
          tokenId: validation.id,
          direction: 'inbound'
        });
        
        // Store incoming message
        convStore.addMessage(federationContext.conversation_id, {
          direction: 'inbound',
          role: 'user',
          content: message
        });
      } catch (err) {
        console.error('[a2a] Conversation tracking error:', err.message);
      }
    }

    try {
      // Handle the message
      const response = await handleMessage(message, federationContext, { timeout: boundedTimeout * 1000 });
      
      // Store outgoing response
      if (convStore) {
        try {
          convStore.addMessage(federationContext.conversation_id, {
            direction: 'outbound',
            role: 'assistant',
            content: response.text
          });
        } catch (err) {
          console.error('[a2a] Message storage error:', err.message);
        }
      }

      // Notify owner if configured
      if (validation.notify !== 'none') {
        notifyOwner({
          level: validation.notify,
          token: validation,
          caller,
          context,
          message,
          response: response.text,
          conversation_id: federationContext.conversation_id
        }).catch(err => {
          console.error('[a2a] Failed to notify owner:', err.message);
        });
      }

      res.json({
        success: true,
        conversation_id: federationContext.conversation_id,
        response: response.text,
        can_continue: response.canContinue !== false,
        tokens_remaining: validation.calls_remaining
      });

    } catch (err) {
      console.error('[a2a] Message handling error:', err);
      res.status(500).json({
        success: false,
        error: 'internal_error',
        message: 'Failed to process message'
      });
    }
  });

  /**
   * POST /end
   * End a conversation and trigger summary generation
   */
  router.post('/end', async (req, res) => {
    // Extract token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'unauthorized', 
        message: 'Authorization header required' 
      });
    }

    const token = authHeader.slice(7);
    const validation = tokenStore.validate(token);
    if (!validation.valid) {
      return res.status(401).json({ 
        success: false, 
        error: 'unauthorized', 
        message: 'Invalid or expired token' 
      });
    }

    const { conversation_id } = req.body;
    if (!conversation_id) {
      return res.status(400).json({
        success: false,
        error: 'missing_conversation_id',
        message: 'conversation_id is required'
      });
    }

    const convStore = getConversationStore();
    if (!convStore) {
      return res.json({ success: true, message: 'Conversation storage not enabled' });
    }

    try {
      // Conclude with summarizer if available
      const summarizer = options.summarizer || null;
      const ownerContext = options.ownerContext || {};
      
      const result = await convStore.concludeConversation(conversation_id, {
        summarizer,
        ownerContext
      });

      // Notify owner of conversation conclusion
      if (validation.notify !== 'none' && result.success) {
        const conv = convStore.getConversationContext(conversation_id);
        notifyOwner({
          level: validation.notify,
          type: 'conversation_concluded',
          token: validation,
          conversation: conv
        }).catch(err => {
          console.error('[a2a] Failed to notify owner:', err.message);
        });
      }

      res.json({
        success: true,
        conversation_id,
        status: 'concluded',
        summary: result.summary
      });
    } catch (err) {
      console.error('[a2a] End conversation error:', err);
      res.status(500).json({
        success: false,
        error: 'internal_error',
        message: 'Failed to end conversation'
      });
    }
  });

  /**
   * GET /conversations
   * List conversations (requires auth)
   * This is for the agent owner, not federated callers
   */
  router.get('/conversations', (req, res) => {
    // This endpoint should be protected by local auth, not federation tokens
    // For now, require an admin token or local access
    const adminToken = req.headers['x-admin-token'];
    if (adminToken !== process.env.A2A_ADMIN_TOKEN && req.ip !== '127.0.0.1') {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const convStore = getConversationStore();
    if (!convStore) {
      return res.json({ conversations: [], message: 'Conversation storage not enabled' });
    }

    const { contact_id, status, limit = 20 } = req.query;
    
    const conversations = convStore.listConversations({
      contactId: contact_id,
      status,
      limit: parseInt(limit),
      includeMessages: false
    });

    res.json({ conversations });
  });

  /**
   * GET /conversations/:id
   * Get conversation details with context
   */
  router.get('/conversations/:id', (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (adminToken !== process.env.A2A_ADMIN_TOKEN && req.ip !== '127.0.0.1') {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const convStore = getConversationStore();
    if (!convStore) {
      return res.status(404).json({ error: 'conversation_storage_disabled' });
    }

    const { recent_messages = 10 } = req.query;
    const context = convStore.getConversationContext(
      req.params.id, 
      parseInt(recent_messages)
    );

    if (!context) {
      return res.status(404).json({ error: 'conversation_not_found' });
    }

    res.json(context);
  });

  return router;
}

/**
 * Default message handler (placeholder)
 */
async function defaultMessageHandler(message, context, options) {
  return {
    text: `[A2A Federation Active] Received message from ${context.caller?.name || 'unknown'}. Agent integration pending.`,
    canContinue: true
  };
}

module.exports = { createRoutes, checkRateLimit };
