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
const { createDashboardApiRouter, createDashboardUiRouter } = require('./routes/dashboard');
const { TokenStore } = require('./lib/tokens');
const { getTopicsForTier, formatTopicsForPrompt, loadManifest } = require('./lib/disclosure');
const {
  buildConnectionPrompt,
  buildAdaptiveConnectionPrompt,
  extractCollaborationState
} = require('./lib/prompt-template');

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
const VALID_PHASES = new Set(['handshake', 'explore', 'deep_dive', 'synthesize', 'close']);
const collaborationSessions = new Map();
const COLLAB_STATE_TTL_MS = readPositiveIntEnv('A2A_COLLAB_STATE_TTL_MS', 6 * 60 * 60 * 1000);
const MAX_COLLAB_SESSIONS = readPositiveIntEnv('A2A_COLLAB_MAX_SESSIONS', 500);

console.log(`[a2a] Agent: ${agentContext.name} (${agentContext.owner}'s agent)`);

function readPositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveCollabMode() {
  const raw = String(process.env.A2A_COLLAB_MODE || 'adaptive').trim().toLowerCase();
  if (raw === 'deep_dive' || raw === 'deep-dive') {
    return 'deep_dive';
  }
  return 'adaptive';
}

function cleanText(value, maxLength = 160) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function sanitizeList(values, maxItems = 4, itemMaxLength = 160) {
  if (!Array.isArray(values)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const item = cleanText(value, itemMaxLength);
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function mergeUnique(baseList, newList, maxItems = 4) {
  const merged = [];
  const seen = new Set();
  for (const item of [...sanitizeList(baseList, maxItems), ...sanitizeList(newList, maxItems)]) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    merged.push(item);
    if (merged.length >= maxItems) {
      break;
    }
  }
  return merged;
}

function extractSignalPhrases(text, pattern, maxItems = 3) {
  if (!text) {
    return [];
  }
  const chunks = String(text)
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[.!?])\s+/));

  const picked = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const cleaned = cleanText(chunk, 180);
    if (!cleaned || cleaned.length < 8) {
      continue;
    }
    if (!pattern.test(cleaned)) {
      continue;
    }
    if (seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    picked.push(cleaned);
    if (picked.length >= maxItems) {
      break;
    }
  }
  return picked;
}

function collectTopicKeywords(tierTopics) {
  const keywords = new Set();
  const sourceLists = ['lead_with', 'discuss_freely'];

  for (const listName of sourceLists) {
    for (const item of tierTopics?.[listName] || []) {
      for (const part of [item?.topic, item?.detail]) {
        if (!part) {
          continue;
        }
        const terms = String(part)
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(term => term.length >= 4);
        for (const term of terms.slice(0, 6)) {
          keywords.add(term);
          if (keywords.size >= 48) {
            return Array.from(keywords);
          }
        }
      }
    }
  }

  return Array.from(keywords);
}

function pruneCollaborationSessions() {
  const now = Date.now();
  for (const [conversationId, state] of collaborationSessions.entries()) {
    const updatedAt = Number(state?.updatedAt || 0);
    if (!updatedAt || now - updatedAt > COLLAB_STATE_TTL_MS) {
      collaborationSessions.delete(conversationId);
    }
  }

  if (collaborationSessions.size <= MAX_COLLAB_SESSIONS) {
    return;
  }

  const oldest = Array.from(collaborationSessions.entries())
    .sort((a, b) => (a[1]?.updatedAt || 0) - (b[1]?.updatedAt || 0));
  const toDelete = collaborationSessions.size - MAX_COLLAB_SESSIONS;
  for (let i = 0; i < toDelete; i++) {
    collaborationSessions.delete(oldest[i][0]);
  }
}

function getOrCreateCollaborationState(conversationId, context = {}) {
  pruneCollaborationSessions();

  const existing = collaborationSessions.get(conversationId);
  if (existing) {
    existing.updatedAt = Date.now();
    return existing;
  }

  const now = Date.now();
  const state = {
    conversationId,
    phase: 'handshake',
    turnCount: 0,
    overlapScore: 0.15,
    activeThreads: [],
    candidateCollaborations: [],
    openQuestions: [],
    closeSignal: false,
    confidence: 0.25,
    callerName: cleanText(context.callerName, 80),
    callerOwner: cleanText(context.callerOwner, 80),
    tier: context.tier || 'public',
    createdAt: now,
    updatedAt: now
  };

  collaborationSessions.set(conversationId, state);
  return state;
}

function inferPhaseFromState(state, signals) {
  if (signals.closeSignal && state.turnCount >= 5) {
    return 'close';
  }
  if (state.turnCount >= 5 && (state.candidateCollaborations.length > 0 || state.overlapScore >= 0.65)) {
    return 'synthesize';
  }
  if (state.turnCount >= 3 && state.overlapScore >= 0.4) {
    return 'deep_dive';
  }
  if (state.turnCount >= 1) {
    return 'explore';
  }
  return 'handshake';
}

function applyCollaborationPatch(state, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return false;
  }

  let applied = false;

  if (typeof patch.phase === 'string') {
    const phase = patch.phase.trim();
    if (VALID_PHASES.has(phase)) {
      state.phase = phase;
      applied = true;
    }
  }

  if (patch.turnCount !== undefined) {
    const nextTurn = clampNumber(patch.turnCount, 0, 500, state.turnCount + 1);
    state.turnCount = Math.max(state.turnCount + 1, nextTurn);
    applied = true;
  }

  if (patch.overlapScore !== undefined) {
    state.overlapScore = Number(clampNumber(
      patch.overlapScore,
      0,
      1,
      state.overlapScore
    ).toFixed(2));
    applied = true;
  }

  const activeThreads = sanitizeList(patch.activeThreads, 4);
  if (activeThreads.length > 0) {
    state.activeThreads = activeThreads;
    applied = true;
  }

  const candidateCollaborations = sanitizeList(patch.candidateCollaborations, 4);
  if (candidateCollaborations.length > 0) {
    state.candidateCollaborations = candidateCollaborations;
    applied = true;
  }

  const openQuestions = sanitizeList(patch.openQuestions, 4);
  if (openQuestions.length > 0) {
    state.openQuestions = openQuestions;
    applied = true;
  }

  if (patch.closeSignal !== undefined) {
    state.closeSignal = Boolean(patch.closeSignal);
    applied = true;
  } else if (patch.shouldClose !== undefined) {
    state.closeSignal = Boolean(patch.shouldClose);
    applied = true;
  }

  if (patch.confidence !== undefined) {
    state.confidence = Number(clampNumber(
      patch.confidence,
      0,
      1,
      state.confidence
    ).toFixed(2));
    applied = true;
  }

  state.updatedAt = Date.now();
  return applied;
}

function fallbackCollaborationUpdate(state, inboundMessage, responseText, tierTopics) {
  const inbound = String(inboundMessage || '');
  const outbound = String(responseText || '');
  const combined = `${inbound}\n${outbound}`.toLowerCase();

  const keywordList = collectTopicKeywords(tierTopics);
  let keywordHits = 0;
  for (const keyword of keywordList) {
    if (combined.includes(keyword)) {
      keywordHits += 1;
    }
  }

  const collaborationSignal =
    /(collaborat|partner|integrat|co-?build|joint|pilot|next step|follow[ -]?up|introduc)/i.test(combined);
  const depthSignal =
    /(constraint|timeline|resource|owner|deliverable|scope|risk|tradeoff|metric)/i.test(combined);
  const closeSignal =
    /(wrap up|summary|conclude|close this|next call|owners should connect|handoff)/i.test(combined);

  const questionCount = (outbound.match(/\?/g) || []).length;
  const keywordScore = keywordList.length ? keywordHits / Math.max(keywordList.length, 8) : 0.05;
  const overlapDelta =
    (keywordScore * 0.45) +
    (collaborationSignal ? 0.12 : 0) +
    (depthSignal ? 0.08 : 0) +
    (questionCount > 0 ? 0.03 : -0.03);

  state.turnCount += 1;
  state.overlapScore = Number(clampNumber(
    state.overlapScore + overlapDelta,
    0,
    1,
    state.overlapScore
  ).toFixed(2));

  const threadSeeds = mergeUnique(
    extractSignalPhrases(
      `${inbound}\n${outbound}`,
      /(working|building|focus|interested|goal|problem|need|challenge|opportunit)/i,
      4
    ),
    state.activeThreads,
    4
  );
  state.activeThreads = threadSeeds;

  const candidateIdeas = extractSignalPhrases(
    outbound,
    /(collaborat|integrat|pilot|joint|co-?build|follow[ -]?up|introduc|next step)/i,
    4
  );
  state.candidateCollaborations = mergeUnique(state.candidateCollaborations, candidateIdeas, 4);

  const questionPhrases = extractSignalPhrases(outbound, /\?/, 4).map(q => {
    return q.endsWith('?') ? q : `${q}?`;
  });
  state.openQuestions = mergeUnique(state.openQuestions, questionPhrases, 4);

  state.closeSignal = Boolean(state.closeSignal || closeSignal);
  state.phase = inferPhaseFromState(state, { closeSignal });
  state.updatedAt = Date.now();
}

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
  const tierInfo = a2aContext.tier || 'public';
  const conversationId = a2aContext.conversation_id || `conv_${Date.now()}`;
  const collabMode = resolveCollabMode();
  const collabState = getOrCreateCollaborationState(conversationId, {
    callerName,
    callerOwner,
    tier: tierInfo
  });

  // Auto-add caller as contact
  ensureContact(a2aContext.caller, a2aContext.token_id);

  // Build prompt from disclosure manifest
  const manifest = loadManifest();
  const tierTopics = getTopicsForTier(tierInfo);
  const formattedTopics = formatTopicsForPrompt(tierTopics);

  // Load tier goals from config (merged up the hierarchy like disclosure topics)
  let tierGoals = [];
  try {
    const configDir = process.env.A2A_CONFIG_DIR || process.env.OPENCLAW_CONFIG_DIR ||
      path.join(process.env.HOME || '/tmp', '.config', 'openclaw');
    const configPath = path.join(configDir, 'a2a-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const tierHierarchy = ['public', 'friends', 'family'];
      const tierIndex = tierHierarchy.indexOf(tierInfo);
      const tiersToMerge = tierIndex >= 0
        ? tierHierarchy.slice(0, tierIndex + 1)
        : ['public'];
      for (const t of tiersToMerge) {
        const tGoals = config.tiers?.[t]?.goals || [];
        tierGoals.push(...tGoals);
      }
      tierGoals = [...new Set(tierGoals)];
    }
  } catch (e) {}

  const promptOptions = {
    agentName: agentContext.name,
    ownerName: agentContext.owner,
    otherAgentName: callerName,
    otherOwnerName: callerOwner || 'their owner',
    roleContext: 'They called you.',
    accessTier: tierInfo,
    tierTopics: formattedTopics,
    tierGoals,
    otherAgentGreeting: message,
    personalityNotes: manifest.personality_notes || ''
  };

  const prompt = collabMode === 'adaptive'
    ? buildAdaptiveConnectionPrompt({
      ...promptOptions,
      conversationState: collabState
    })
    : buildConnectionPrompt(promptOptions);

  const sessionId = `a2a-${conversationId}`;
  
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
    
    const rawResponse = lines.join('\n').trim() || '[Sub-agent returned empty response]';

    if (collabMode !== 'adaptive') {
      return rawResponse;
    }

    const parsed = extractCollaborationState(rawResponse);
    const cleanResponse = parsed.cleanText || rawResponse;
    const beforeTurn = collabState.turnCount;
    let usedMetadata = false;

    if (parsed.hasState && parsed.statePatch) {
      usedMetadata = applyCollaborationPatch(collabState, parsed.statePatch);
      if (!usedMetadata) {
        console.warn(`[a2a] Invalid collaboration patch for ${conversationId}; using fallback heuristics`);
      }
    } else if (parsed.parseError) {
      console.warn(`[a2a] Could not parse collaboration metadata for ${conversationId}: ${parsed.parseError}`);
    }

    if (!usedMetadata) {
      fallbackCollaborationUpdate(collabState, message, cleanResponse, tierTopics);
    }

    if (collabState.turnCount <= beforeTurn) {
      collabState.turnCount = beforeTurn + 1;
    }

    if (!VALID_PHASES.has(collabState.phase)) {
      collabState.phase = inferPhaseFromState(collabState, { closeSignal: collabState.closeSignal });
    }
    collabState.updatedAt = Date.now();
    collaborationSessions.set(conversationId, collabState);

    return cleanResponse || '[Sub-agent returned empty response]';
    
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

  const prompt = `Summarize this A2A call for the owner. Write from the owner's perspective.

Conversation with ${callerDesc}:
${messageText}

Structure your summary with these sections:

**Who:** Who called, who they represent, key facts about them.
**Key Discoveries:** What was learned about the other side — capabilities, interests, blind spots.
**Collaboration Potential:** Rate HIGH/MEDIUM/LOW. List specific opportunities identified.
**What We Learned vs Shared:** Brief information exchange audit — what did we get, what did we give.
**Recommended Follow-Up:**
- [ ] Actionable item 1
- [ ] Actionable item 2
**Assessment:** One-sentence strategic value judgment.

Be concise but specific. No filler.`;

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

// Minimal owner dashboard (local by default unless A2A_ADMIN_TOKEN is provided)
app.use('/api/a2a/dashboard', createDashboardApiRouter({
  tokenStore
}));
app.use('/dashboard', createDashboardUiRouter({
  tokenStore
}));

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
  console.log(`[a2a] Collaboration mode: ${resolveCollabMode()}`);
  console.log(`[a2a] Features: sub-agents, auto-contacts, summaries`);
});
