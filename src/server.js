#!/usr/bin/env node
/**
 * A2A Federation Server
 * 
 * Standalone server for testing or running alongside OpenClaw.
 * 
 * Usage:
 *   node src/server.js [--port 3001]
 *   PORT=3001 node src/server.js
 */

const express = require('express');
const { createRoutes } = require('./routes/federation');
const { TokenStore } = require('./lib/tokens');

const port = process.env.PORT || parseInt(process.argv[2]) || 3001;

const app = express();
app.use(express.json());

// Initialize token store
const tokenStore = new TokenStore();

// Mount federation routes
app.use('/api/federation', createRoutes({
  tokenStore,
  
  // Default message handler - in production, this connects to the agent
  async handleMessage(message, context, options) {
    console.log(`[a2a] Received message from ${context.caller?.name || 'unknown'}: ${message}`);
    return {
      text: `[A2A Federation Active] Received: "${message}". Full agent integration pending.`,
      canContinue: true
    };
  },
  
  // Default owner notification - in production, this sends to chat
  async notifyOwner({ level, token, caller, message, response }) {
    console.log(`[a2a] Notification (${level}): ${caller?.name || 'unknown'} called via token "${token.name}"`);
    console.log(`[a2a]   Message: ${message}`);
    console.log(`[a2a]   Response: ${response}`);
  }
}));

// Health check at root
app.get('/', (req, res) => {
  res.json({ service: 'a2a-federation', status: 'ok' });
});

app.listen(port, () => {
  console.log(`[a2a] Federation server listening on port ${port}`);
  console.log(`[a2a] Endpoints:`);
  console.log(`[a2a]   GET  /api/federation/status`);
  console.log(`[a2a]   GET  /api/federation/ping`);
  console.log(`[a2a]   POST /api/federation/invoke`);
});
