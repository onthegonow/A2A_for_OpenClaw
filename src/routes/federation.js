/**
 * Federation API Routes
 * 
 * Mount at: /api/federation
 */

const { TokenStore } = require('../lib/tokens');

// Rate limiting state (in-memory)
const rateLimits = new Map();

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
      const status = validation.error === 'token_not_found' ? 401 : 403;
      return res.status(status).json({ 
        success: false, 
        error: validation.error, 
        message: `Token invalid: ${validation.error}` 
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

    // Extract request
    const { message, conversation_id, caller, context, timeout_seconds = 60 } = req.body;

    if (!message) {
      return res.status(400).json({ 
        success: false, 
        error: 'missing_message', 
        message: 'Message is required' 
      });
    }

    // Build federation context
    const federationContext = {
      mode: 'federation',
      token_id: validation.id,
      token_name: validation.name,
      permissions: validation.permissions,
      disclosure: validation.disclosure,
      caller: caller || {},
      conversation_id: conversation_id || `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    };

    try {
      // Handle the message
      const response = await handleMessage(message, federationContext, { timeout: timeout_seconds * 1000 });

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
