/**
 * A2A Calling - Agent-to-Agent Communication for OpenClaw
 * 
 * @example
 * // Server side - mount routes
 * const { createRoutes, TokenStore } = require('a2acalling');
 * const tokenStore = new TokenStore();
 * app.use('/api/federation', createRoutes({ tokenStore, handleMessage }));
 * 
 * @example
 * // Client side - call remote agent
 * const { A2AClient } = require('a2acalling');
 * const client = new A2AClient({ caller: { name: 'My Agent' } });
 * const response = await client.call('oclaw://host/token', 'Hello!');
 */

const { TokenStore } = require('./lib/tokens');
const { A2AClient, A2AError } = require('./lib/client');
const { createRoutes } = require('./routes/federation');

// Lazy load conversation store (optional dependency)
let ConversationStore = null;
let summarizers = null;
try {
  ConversationStore = require('./lib/conversations').ConversationStore;
  summarizers = require('./lib/summarizer');
} catch (err) {
  // better-sqlite3 not installed, conversation storage not available
}

module.exports = {
  // Token management
  TokenStore,
  
  // Client for outbound calls
  A2AClient,
  A2AError,
  
  // Express routes for inbound calls
  createRoutes,
  
  // Conversation storage (requires better-sqlite3)
  ConversationStore,
  
  // Summarizers for conversation conclusion
  ...(summarizers || {}),
  
  // Version
  version: require('../package.json').version
};
