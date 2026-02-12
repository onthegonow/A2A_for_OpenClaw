#!/usr/bin/env node
/**
 * A2A Server
 * 
 * Routes A2A calls through a runtime adapter (OpenClaw or generic fallback).
 * Auto-adds contacts, generates summaries, notifies owner.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createRoutes } = require('./routes/a2a');
const { createDashboardApiRouter, createDashboardUiRouter } = require('./routes/dashboard');
const { TokenStore } = require('./lib/tokens');
const { createRuntimeAdapter } = require('./lib/runtime-adapter');
const { getTopicsForTier, formatTopicsForPrompt, loadManifest } = require('./lib/disclosure');
const {
  buildConnectionPrompt,
  buildAdaptiveConnectionPrompt,
  extractCollaborationState
} = require('./lib/prompt-template');
const { findAvailablePort } = require('./lib/port-scanner');

const DEFAULT_PORTS = [80, 3001, 8080, 8443, 9001];
const requestedPort = process.env.PORT ? parseInt(process.env.PORT, 10)
  : process.argv[2] ? parseInt(process.argv[2], 10)
  : null;
const workspaceDir = process.env.A2A_WORKSPACE || process.env.OPENCLAW_WORKSPACE || process.cwd();

// Load workspace context for agent identity
function loadAgentContext() {
  let context = {
    name: process.env.A2A_AGENT_NAME || process.env.AGENT_NAME || 'a2a-agent',
    owner: process.env.A2A_OWNER_NAME || process.env.USER || 'Agent Owner'
  };
  
  try {
    const userPath = path.join(workspaceDir, 'USER.md');
    if (fs.existsSync(userPath)) {
      const content = fs.readFileSync(userPath, 'utf8');
      const agentMatch = content.match(/\*\*Agent:\*\*\s*([^\n]+)/i);
      if (agentMatch && agentMatch[1]) {
        context.name = agentMatch[1].trim().slice(0, 80) || context.name;
      }
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
const runtime = createRuntimeAdapter({
  workspaceDir,
  agentContext
});
const VALID_PHASES = new Set(['handshake', 'explore', 'deep_dive', 'synthesize', 'close']);
const collaborationSessions = new Map();
const COLLAB_STATE_TTL_MS = readPositiveIntEnv('A2A_COLLAB_STATE_TTL_MS', 6 * 60 * 60 * 1000);
const MAX_COLLAB_SESSIONS = readPositiveIntEnv('A2A_COLLAB_MAX_SESSIONS', 500);

console.log(`[a2a] Agent: ${agentContext.name} (${agentContext.owner}'s agent)`);
console.log(`[a2a] Runtime: ${runtime.mode} (${runtime.reason})`);
if (runtime.warning) {
  console.warn(`[a2a] Runtime warning: ${runtime.warning}`);
}

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
    const contact = tokenStore.ensureInboundContact(caller, tokenId);
    if (contact) {
      console.log(`[a2a] 📇 Contact ensured: ${caller.name}${caller.owner ? ` (${caller.owner})` : ''}`);
    }
    return contact;
  } catch (err) {
    console.error('[a2a] Failed to ensure contact:', err.message);
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
    const rawResponse = await runtime.runTurn({
      sessionId,
      prompt,
      message,
      caller: a2aContext.caller || {},
      timeoutMs: 65000,
      context: {
        conversationId,
        tier: tierInfo,
        ownerName: agentContext.owner,
        allowedTopics: a2aContext.allowed_topics || []
      }
    });

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
    console.error('[a2a] Runtime turn handling failed:', err.message);
    return runtime.buildFallbackResponse(message, {
      caller: a2aContext.caller,
      ownerName: agentContext.owner,
      allowedTopics: a2aContext.allowed_topics || []
    }, err.message);
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
    return await runtime.summarize({
      sessionId: `summary-${Date.now()}`,
      prompt,
      messages,
      callerInfo
    });
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
  const messageText = String(message || '');
  
  console.log(`[a2a] 📞 Call from ${callerName}${callerOwner}`);
  console.log(`[a2a]    Token: ${token?.name || 'unknown'}`);
  if (messageText) {
    console.log(`[a2a]    Message: ${messageText.slice(0, 100)}...`);
  }

  await runtime.notify({
    level,
    token,
    caller,
    message: messageText,
    conversationId: conversation_id
  });
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

async function startServer() {
  let port;

  if (requestedPort) {
    // Explicit port requested — try it first, fall back to defaults if busy
    const { isPortAvailable } = require('./lib/port-scanner');
    if (await isPortAvailable(requestedPort)) {
      port = requestedPort;
    } else {
      console.warn(`[a2a] Requested port ${requestedPort} is in use, scanning for alternatives...`);
      port = await findAvailablePort(DEFAULT_PORTS);
    }
  } else {
    port = await findAvailablePort(DEFAULT_PORTS);
  }

  if (!port) {
    console.error(`[a2a] No available port found. Tried: ${requestedPort ? requestedPort + ', ' : ''}${DEFAULT_PORTS.join(', ')}`);
    console.error('[a2a] Set PORT env or free one of the default ports.');
    process.exit(1);
  }

  const server = app.listen(port, () => {
    console.log(`[a2a] A2A server listening on port ${port}`);
    console.log(`[a2a] Agent: ${agentContext.name} - LIVE`);
    console.log(`[a2a] Runtime mode: ${runtime.mode}${runtime.failoverEnabled ? ' (failover enabled)' : ''}`);
    console.log(`[a2a] Collaboration mode: ${resolveCollabMode()}`);
    console.log(`[a2a] Features: adaptive collaboration, auto-contacts, summaries, dashboard`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[a2a] Port ${port} became unavailable (EADDRINUSE). Exiting.`);
      process.exit(1);
    }
    throw err;
  });
}

startServer();
