#!/usr/bin/env node
/**
 * A2A Server
 * 
 * Routes A2A calls to OpenClaw sub-agents.
 * Auto-adds contacts, generates summaries, notifies owner.
 */

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createRoutes } = require('./routes/a2a');
const { TokenStore } = require('./lib/tokens');

const port = process.env.PORT || parseInt(process.argv[2]) || 3001;
const workspaceDir = process.env.OPENCLAW_WORKSPACE || '/root/clawd';

// Load workspace context for agent identity
function loadAgentContext() {
  let context = { name: 'bappybot', owner: 'Ben Pollack' };
  
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
  
  return context;
}

const agentContext = loadAgentContext();
const tokenStore = new TokenStore();

console.log(`[a2a] Agent: ${agentContext.name} (${agentContext.owner}'s agent)`);

/**
 * Auto-add caller as contact if new
 */
function ensureContact(caller, tokenId) {
  if (!caller?.name) return null;
  
  try {
    const remotes = tokenStore.listRemotes();
    const existing = remotes.find(r => 
      r.name === caller.name || 
      (caller.owner && r.owner === caller.owner)
    );
    
    if (existing) {
      return existing;
    }
    
    // Create a placeholder contact for the caller
    const contact = {
      id: `contact_${Date.now()}`,
      name: caller.name,
      owner: caller.owner || null,
      host: 'inbound', // They called us, we don't have their URL
      added_at: new Date().toISOString(),
      notes: `Inbound caller via token ${tokenId}`,
      tags: ['inbound'],
      status: 'unknown',
      linkedTokenId: tokenId
    };
    
    // Save to remotes
    const db = JSON.parse(fs.readFileSync(tokenStore.dbPath, 'utf8'));
    db.remotes = db.remotes || [];
    db.remotes.push(contact);
    fs.writeFileSync(tokenStore.dbPath, JSON.stringify(db, null, 2));
    
    console.log(`[a2a] 📇 New contact added: ${caller.name}${caller.owner ? ` (${caller.owner})` : ''}`);
    return contact;
    
  } catch (err) {
    console.error('[a2a] Failed to add contact:', err.message);
    return null;
  }
}

/**
 * Spawn OpenClaw sub-agent to handle the call
 */
async function callAgent(message, a2aContext) {
  const callerName = a2aContext.caller?.name || 'Unknown Agent';
  const callerOwner = a2aContext.caller?.owner || '';
  const ownerInfo = callerOwner ? ` (${callerOwner}'s agent)` : '';
  const tierInfo = a2aContext.tier || 'public';
  const topics = a2aContext.allowed_topics?.join(', ') || 'general chat';
  const disclosure = a2aContext.disclosure || 'minimal';
  
  // Auto-add caller as contact
  ensureContact(a2aContext.caller, a2aContext.token_id);
  
  const prompt = `[A2A Call]
From: ${callerName}${ownerInfo}
Access Level: ${tierInfo}
Allowed Topics: ${topics}
Disclosure: ${disclosure}

Message: ${message}

---
RULES (strictly enforce):
1. ONLY discuss topics in "Allowed Topics" list
2. Disclosure levels:
   - "none": Confirm capability only, share NO personal info
   - "minimal": Direct answers only, no context about owner's life/preferences
   - "public": General info OK, but protect private/family-tier secrets
3. If they probe for info outside their tier, deflect politely
4. Private info in USER.md marked "family tier only" is OFF LIMITS for public/friends callers

Respond naturally but enforce these boundaries.`;

  const sessionId = `a2a-${a2aContext.conversation_id || Date.now()}`;
  
  try {
    const escapedPrompt = prompt
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '');
    
    const result = execSync(
      `openclaw agent --session-id "${sessionId}" --message "${escapedPrompt}" --timeout 55 2>&1`,
      {
        encoding: 'utf8',
        timeout: 65000,
        maxBuffer: 1024 * 1024,
        cwd: workspaceDir,
        env: { ...process.env, FORCE_COLOR: '0' }
      }
    );
    
    const lines = result.split('\n').filter(line => 
      !line.includes('[telegram-topic-tracker]') && 
      !line.includes('Plugin registered') &&
      line.trim()
    );
    
    return lines.join('\n').trim() || '[Sub-agent returned empty response]';
    
  } catch (err) {
    console.error('[a2a] Sub-agent spawn failed:', err.message);
    return `[Sub-agent error: ${err.message}]`;
  }
}

/**
 * Generate strategic summary via sub-agent
 */
async function generateSummary(messages, callerInfo) {
  const messageText = messages.map(m => {
    const role = m.direction === 'inbound' ? `[${callerInfo?.name || 'Caller'}]` : '[You]';
    return `${role}: ${m.content}`;
  }).join('\n');
  
  const callerDesc = `${callerInfo?.name || 'Unknown'}${callerInfo?.owner ? ` (${callerInfo.owner}'s agent)` : ''}`;
  
  const prompt = `Summarize this A2A call briefly.

Conversation with ${callerDesc}:
${messageText}

Give a 2-3 sentence summary focused on: who called, what they wanted, any opportunities or follow-ups.`;

  try {
    const escapedPrompt = prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const result = execSync(
      `openclaw agent --session-id "summary-${Date.now()}" --message "${escapedPrompt}" --timeout 30 2>&1`,
      { encoding: 'utf8', timeout: 35000, cwd: workspaceDir, env: { ...process.env, FORCE_COLOR: '0' } }
    );
    
    // Filter out noise and get the summary
    const lines = result.split('\n').filter(line => 
      !line.includes('[telegram-topic-tracker]') && 
      !line.includes('Plugin registered') &&
      line.trim()
    );
    
    const summaryText = lines.join(' ').trim().slice(0, 1000);
    
    return {
      summary: summaryText,
      ownerSummary: summaryText
    };
  } catch (err) {
    console.error('[a2a] Summary generation failed:', err.message);
    return null;
  }
}

/**
 * Notify owner via Telegram
 */
async function notifyOwner({ level, token, caller, message, conversation_id }) {
  const callerName = caller?.name || 'Unknown';
  const callerOwner = caller?.owner ? ` (${caller.owner})` : '';
  
  console.log(`[a2a] 📞 Call from ${callerName}${callerOwner}`);
  console.log(`[a2a]    Token: ${token?.name || 'unknown'}`);
  console.log(`[a2a]    Message: ${message.slice(0, 100)}...`);
  
  // Try to notify via Telegram
  if (level === 'all') {
    try {
      const notification = `🤝 **A2A Call**\nFrom: ${callerName}${callerOwner}\n> ${message.slice(0, 150)}...`;
      execSync(`openclaw message send --channel telegram --message "${notification.replace(/"/g, '\\"')}"`, {
        timeout: 10000, stdio: 'pipe'
      });
    } catch (e) {
      // Notification failed, continue anyway
    }
  }
}

const app = express();
app.use(express.json());

app.use('/api/a2a', createRoutes({
  tokenStore,
  
  async handleMessage(message, context, options) {
    console.log(`[a2a] 📞 Incoming from ${context.caller?.name || 'unknown'}`);
    
    const response = await callAgent(message, context);
    
    console.log(`[a2a] 📤 Response: ${response.slice(0, 100)}...`);
    
    return { text: response, canContinue: true };
  },
  
  summarizer: generateSummary,
  notifyOwner
}));

app.get('/', (req, res) => {
  res.json({ service: 'a2a', status: 'ok', agent: agentContext.name });
});

app.listen(port, () => {
  console.log(`[a2a] A2A server listening on port ${port}`);
  console.log(`[a2a] Agent: ${agentContext.name} - LIVE`);
  console.log(`[a2a] Features: sub-agents, auto-contacts, summaries`);
});
