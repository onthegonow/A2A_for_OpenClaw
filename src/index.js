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
 * const response = await client.call('a2a://host/token', 'Hello!');
 */

const { TokenStore } = require('./lib/tokens');
const { A2AClient, A2AError } = require('./lib/client');
const { createRoutes } = require('./routes/federation');

// Lazy load optional dependencies
let ConversationStore = null;
let summarizers = null;
let CallMonitor = null;
let openclawIntegration = null;

try {
  ConversationStore = require('./lib/conversations').ConversationStore;
  summarizers = require('./lib/summarizer');
  CallMonitor = require('./lib/call-monitor').CallMonitor;
  openclawIntegration = require('./lib/openclaw-integration');
} catch (err) {
  // Optional dependencies not installed
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
  
  // Call monitoring for auto-conclude
  CallMonitor,
  
  // Summarizers for conversation conclusion
  ...(summarizers || {}),
  
  // OpenClaw integration helpers
  ...(openclawIntegration || {}),
  
  // Version
  version: require('../package.json').version
};
