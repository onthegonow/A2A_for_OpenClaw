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

module.exports = {
  // Token management
  TokenStore,
  
  // Client for outbound calls
  A2AClient,
  A2AError,
  
  // Express routes for inbound calls
  createRoutes,
  
  // Version
  version: require('../package.json').version
};
