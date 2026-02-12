#!/usr/bin/env node
/**
 * A2A Federation Server
 * 
 * Routes federation calls to an LLM agent.
 * 
 * Usage:
 *   node src/server.js [--port 3001]
 *   PORT=3001 node src/server.js
 */

const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createRoutes } = require('./routes/federation');
const { TokenStore } = require('./lib/tokens');

const port = process.env.PORT || parseInt(process.argv[2]) || 3001;

// Load API key from various sources
function getApiKey() {
  // Check environment first
  if (process.env.OPENROUTER_API_KEY) {
    return { key: process.env.OPENROUTER_API_KEY, provider: 'openrouter' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { key: process.env.ANTHROPIC_API_KEY, provider: 'anthropic' };
  }
  
  // Try ~/.openclaw/.env
  try {
    const envPath = path.join(process.env.HOME || '/root', '.openclaw', '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      
      // Try OpenRouter first (more reliable)
      const orMatch = content.match(/OPENROUTER_API_KEY=(.+)/);
      if (orMatch && orMatch[1]) return { key: orMatch[1].trim(), provider: 'openrouter' };
      
      const anthropicMatch = content.match(/ANTHROPIC_API_KEY=(.+)/);
      if (anthropicMatch && anthropicMatch[1]) return { key: anthropicMatch[1].trim(), provider: 'anthropic' };
    }
  } catch (e) {}
  
  return null;
}

// Load workspace context for agent personality
function loadAgentContext() {
  const workspaceDir = process.env.OPENCLAW_WORKSPACE || '/root/clawd';
  let context = {
    name: 'bappybot',
    owner: 'Ben Pollack'
  };
  
  try {
    const userPath = path.join(workspaceDir, 'USER.md');
    if (fs.existsSync(userPath)) {
      const content = fs.readFileSync(userPath, 'utf8');
      const nameMatch = content.match(/\*\*Name:\*\*\s*([^\n]+)/);
      if (nameMatch) {
        const name = nameMatch[1].trim();
        if (name && !name.includes('_') && !name.includes('(')) {
          context.owner = name;
        }
      }
    }
  } catch (e) {}
  
  try {
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    if (fs.existsSync(soulPath)) {
      context.soul = fs.readFileSync(soulPath, 'utf8').slice(0, 2000);
    }
  } catch (e) {}
  
  return context;
}

const apiConfig = getApiKey();
const agentContext = loadAgentContext();

console.log(`[a2a] Agent: ${agentContext.name} (${agentContext.owner}'s agent)`);
console.log(`[a2a] API: ${apiConfig ? `${apiConfig.provider} ✓` : 'NOT FOUND ✗'}`);

/**
 * Call LLM via OpenRouter or Anthropic
 */
async function callAgent(message, federationContext) {
  if (!apiConfig) {
    return '[Agent configuration error: No API key available]';
  }
  
  const callerName = federationContext.caller?.name || 'Unknown Agent';
  const callerOwner = federationContext.caller?.owner || '';
  const ownerInfo = callerOwner ? ` (${callerOwner}'s agent)` : '';
  const tierInfo = federationContext.tier || 'public';
  
  const systemPrompt = `You are ${agentContext.name}, ${agentContext.owner}'s AI agent.

${agentContext.soul || 'Be helpful, concise, and friendly.'}

You're receiving a federated call from another AI agent: ${callerName}${ownerInfo}.

Their access level: ${tierInfo}
Topics they can discuss: ${federationContext.allowed_topics?.join(', ') || 'general chat'}
Disclosure level: ${federationContext.disclosure || 'minimal'}

Respond naturally as yourself. Be collaborative but protect your owner's private information based on the disclosure level. Keep responses concise.`;

  // Use OpenRouter or Anthropic based on config
  const isOpenRouter = apiConfig.provider === 'openrouter';
  const hostname = isOpenRouter ? 'openrouter.ai' : 'api.anthropic.com';
  const apiPath = isOpenRouter ? '/api/v1/chat/completions' : '/v1/messages';
  const model = isOpenRouter ? 'anthropic/claude-sonnet-4' : 'claude-sonnet-4-20250514';
  
  const body = isOpenRouter 
    ? JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      })
    : JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }]
      });

  const headers = isOpenRouter
    ? {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.key}`,
        'HTTP-Referer': 'https://openclaw.ai',
        'X-Title': 'A2A Federation'
      }
    : {
        'Content-Type': 'application/json',
        'x-api-key': apiConfig.key,
        'anthropic-version': '2023-06-01'
      };

  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path: apiPath,
      method: 'POST',
      headers,
      timeout: 55000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          
          // OpenRouter format
          if (json.choices && json.choices[0]?.message?.content) {
            resolve(json.choices[0].message.content);
            return;
          }
          
          // Anthropic format
          if (json.content && json.content[0]?.text) {
            resolve(json.content[0].text);
            return;
          }
          
          if (json.error) {
            console.error('[a2a] API error:', json.error);
            resolve(`[Agent error: ${json.error.message || JSON.stringify(json.error)}]`);
            return;
          }
          
          console.error('[a2a] Unexpected response:', JSON.stringify(json).slice(0, 200));
          resolve('[No response generated]');
        } catch (e) {
          console.error('[a2a] Parse error:', e.message, data.slice(0, 200));
          resolve('[Agent response parsing error]');
        }
      });
    });

    req.on('error', (e) => {
      console.error('[a2a] Request error:', e.message);
      resolve(`[Agent temporarily unavailable: ${e.message}]`);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve('[Agent response timeout]');
    });

    req.write(body);
    req.end();
  });
}

/**
 * Notify owner via console (Telegram notification handled by OpenClaw)
 */
async function notifyOwner({ level, token, caller, message, response, conversation_id }) {
  const callerName = caller?.name || 'Unknown';
  const callerOwner = caller?.owner ? ` (${caller.owner})` : '';
  
  console.log(`[a2a] 📞 Call from ${callerName}${callerOwner}`);
  console.log(`[a2a]    Token: ${token.name}`);
  console.log(`[a2a]    Message: ${message.slice(0, 100)}...`);
}

const app = express();
app.use(express.json());

// Initialize token store
const tokenStore = new TokenStore();

// Mount federation routes
app.use('/api/federation', createRoutes({
  tokenStore,
  
  async handleMessage(message, context, options) {
    console.log(`[a2a] 📞 Incoming from ${context.caller?.name || 'unknown'}`);
    
    const response = await callAgent(message, context);
    
    console.log(`[a2a] 📤 Response: ${response.slice(0, 100)}...`);
    
    return {
      text: response,
      canContinue: true
    };
  },
  
  notifyOwner
}));

// Health check at root
app.get('/', (req, res) => {
  res.json({ service: 'a2a-federation', status: 'ok', agent: agentContext.name });
});

app.listen(port, () => {
  console.log(`[a2a] Federation server listening on port ${port}`);
  console.log(`[a2a] Agent: ${agentContext.name} - LIVE`);
  console.log(`[a2a] Endpoints:`);
  console.log(`[a2a]   GET  /api/federation/status`);
  console.log(`[a2a]   GET  /api/federation/ping`);
  console.log(`[a2a]   POST /api/federation/invoke`);
});
