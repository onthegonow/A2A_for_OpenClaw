/**
 * A2A Dashboard Routes
 *
 * Provides a minimal management dashboard for:
 * - contacts and per-contact call summaries
 * - call history with contact context
 * - tier/topic/goal settings management
 * - invite generation and revocation
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { TokenStore } = require('../lib/tokens');
const { ConversationStore } = require('../lib/conversations');
const { A2AConfig } = require('../lib/config');
const { loadManifest, saveManifest } = require('../lib/disclosure');
const { resolveInviteHost } = require('../lib/invite-host');
const { createLogger } = require('../lib/logger');

const DASHBOARD_STATIC_DIR = path.join(__dirname, '..', 'dashboard', 'public');

function isLoopbackAddress(ip) {
  if (!ip) return false;
  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
    return true;
  }
  return ip.startsWith('::ffff:127.');
}

function sanitizeString(value, maxLength = 200) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeTierId(value) {
  return sanitizeString(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizeStringArray(values, maxItems = 100, itemMaxLength = 200) {
  if (!Array.isArray(values)) {
    return [];
  }
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const item = sanitizeString(value, itemMaxLength);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
    if (unique.length >= maxItems) break;
  }
  return unique;
}

function parseTopicObjects(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const cleaned = [];
  const seen = new Set();
  for (const entry of values) {
    let topic = '';
    let detail = '';

    if (typeof entry === 'string') {
      const parts = entry.split(':');
      topic = sanitizeString(parts[0], 120);
      detail = sanitizeString(parts.slice(1).join(':') || parts[0], 250);
    } else if (entry && typeof entry === 'object') {
      topic = sanitizeString(entry.topic, 120);
      detail = sanitizeString(entry.detail || entry.topic, 250);
    }

    if (!topic) continue;
    if (seen.has(topic)) continue;
    seen.add(topic);
    cleaned.push({ topic, detail: detail || topic });
    if (cleaned.length >= 100) break;
  }
  return cleaned;
}

function formatInviteMessage({ owner, agentName, inviteUrl, topics, goals, expiresText }) {
  const ownerText = owner || 'Someone';
  const topicsList = topics.length > 0 ? topics.join(' · ') : 'chat';
  const goalsList = (goals || []).join(' · ');
  const expirationLine = expiresText === 'never' ? '' : `\n⏰ ${expiresText}`;
  return `📞🗣️ **Agent-to-Agent Call Invite**

👤 **${ownerText}** would like your agent to call **${agentName}** and explore where our owners might collaborate.

💬 ${topicsList}${goalsList ? `\n🎯 ${goalsList}` : ''}

${inviteUrl}${expirationLine}

── setup ──
npm i -g a2acalling && a2a add "${inviteUrl}" "${agentName}" && a2a call "${agentName}" "Hello from my owner!"
https://github.com/onthegonow/a2a_calling`;
}

function buildContext(options = {}) {
  const tokenStore = options.tokenStore || new TokenStore();
  const config = options.config || new A2AConfig();
  const logger = options.logger || createLogger({ component: 'a2a.dashboard' });
  let convStore = options.convStore || null;
  if (!convStore) {
    try {
      convStore = new ConversationStore();
      if (!convStore.isAvailable()) {
        convStore = null;
      }
    } catch (err) {
      convStore = null;
    }
  }

  return {
    tokenStore,
    config,
    convStore,
    logger,
    staticDir: DASHBOARD_STATIC_DIR
  };
}

function buildContactIndex(contacts) {
  const byName = new Map();
  const byId = new Map();
  const byLinkedTokenId = new Map();

  for (const contact of contacts) {
    const nameKey = sanitizeString(contact.name, 120).toLowerCase();
    if (nameKey) {
      byName.set(nameKey, contact);
    }
    if (contact.id) {
      byId.set(contact.id, contact);
    }
    if (contact.linked_token_id) {
      byLinkedTokenId.set(contact.linked_token_id, contact);
    }
  }

  return { byName, byId, byLinkedTokenId };
}

function resolveConversationContact(conversation, contactIndex) {
  if (!conversation) return null;
  if (conversation.contact_id && contactIndex.byId.has(conversation.contact_id)) {
    return contactIndex.byId.get(conversation.contact_id);
  }
  if (conversation.contact_id && contactIndex.byLinkedTokenId.has(conversation.contact_id)) {
    return contactIndex.byLinkedTokenId.get(conversation.contact_id);
  }
  const nameKey = sanitizeString(conversation.contact_name, 120).toLowerCase();
  if (nameKey && contactIndex.byName.has(nameKey)) {
    return contactIndex.byName.get(nameKey);
  }
  return null;
}

function ensureDashboardAccess(req, res, next) {
  const adminToken = process.env.A2A_ADMIN_TOKEN;
  const headerToken = req.headers['x-admin-token'];
  const queryToken = req.query?.admin_token;
  if (isLoopbackAddress(req.ip)) {
    return next();
  }
  if (!adminToken) {
    return res.status(401).json({
      success: false,
      error: 'admin_token_required',
      message: 'Set A2A_ADMIN_TOKEN to access dashboard from non-local addresses'
    });
  }
  if (headerToken === adminToken || queryToken === adminToken) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'unauthorized', message: 'Admin token required' });
}

function summarizeDebugLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return {
      event_count: 0,
      events: [],
      timestamps: [],
      error_count: 0,
      warning_count: 0
    };
  }

  const normalized = logs.slice().sort((a, b) => {
    const aTime = Number(new Date(a.timestamp));
    const bTime = Number(new Date(b.timestamp));
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return aTime - bTime;
  });

  const firstTimestamp = normalized[0]?.timestamp || null;
  const lastTimestamp = normalized[normalized.length - 1]?.timestamp || null;
  const firstMs = firstTimestamp ? Number(new Date(firstTimestamp)) : null;
  const lastMs = lastTimestamp ? Number(new Date(lastTimestamp)) : null;

  return {
    event_count: normalized.length,
    events: normalized.map(row => row.event).filter(Boolean),
    timestamps: normalized.map(row => row.timestamp),
    first_seen: firstTimestamp,
    last_seen: lastTimestamp,
    timeline_ms: Number.isFinite(firstMs) && Number.isFinite(lastMs) && lastMs >= firstMs
      ? lastMs - firstMs
      : null,
    trace_ids: [...new Set(normalized.map(row => row.trace_id).filter(Boolean))],
    conversation_ids: [...new Set(normalized.map(row => row.conversation_id).filter(Boolean))],
    token_ids: [...new Set(normalized.map(row => row.token_id).filter(Boolean))],
    request_ids: [...new Set(normalized.map(row => row.request_id).filter(Boolean))],
    error_count: normalized.filter(row => row.level === 'error').length,
    warning_count: normalized.filter(row => row.level === 'warn').length,
    hints: [...new Set(normalized
      .filter(row => row.hint)
      .map(row => String(row.hint)))]
  };
}

function findErrorHints(logs) {
  const hints = new Map();
  for (const row of logs) {
    if (!row.error_code) continue;
    if (!hints.has(row.error_code)) {
      hints.set(row.error_code, {
        error_code: row.error_code,
        status_code: row.status_code,
        count: 0
      });
    }
    const existing = hints.get(row.error_code);
    existing.count += 1;
  }
  return Array.from(hints.values());
}

function createDashboardApiRouter(options = {}) {
  const router = express.Router();
  const context = buildContext(options);
  router.use(express.json());
  router.use(ensureDashboardAccess);

  router.get('/status', (req, res) => {
    context.logger.debug('Dashboard status requested', { event: 'dashboard_status' });
    res.json({
      success: true,
      dashboard: true,
      conversations_enabled: Boolean(context.convStore),
      config_file: require('../lib/config').CONFIG_FILE,
      manifest_file: require('../lib/disclosure').MANIFEST_FILE
    });
  });

  router.get('/logs', (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit || '200', 10) || 200));
    const logs = context.logger.list({
      limit,
      level: req.query.level || null,
      component: req.query.component || null,
      event: req.query.event || null,
      errorCode: req.query.error_code || req.query.errorCode || null,
      statusCode: req.query.status_code || req.query.statusCode || null,
      traceId: req.query.trace_id || req.query.traceId || null,
      conversationId: req.query.conversation_id || req.query.conversationId || null,
      tokenId: req.query.token_id || req.query.tokenId || null,
      search: req.query.search || null,
      from: req.query.from || null,
      to: req.query.to || null
    });
    return res.json({ success: true, logs });
  });

  router.get('/logs/trace/:traceId', (req, res) => {
    const traceId = sanitizeString(req.params.traceId, 120);
    if (!traceId) {
      return res.status(400).json({ success: false, error: 'trace_id_required' });
    }
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit || '500', 10) || 500));
    const logs = context.logger.getTrace(traceId, { limit });
    return res.json({ success: true, trace_id: traceId, logs });
  });

  router.get('/logs/stats', (req, res) => {
    const stats = context.logger.stats({
      from: req.query.from || null,
      to: req.query.to || null
    });
    return res.json({ success: true, stats });
  });

  router.get('/debug/call', (req, res) => {
    const traceId = sanitizeString(req.query.trace_id || req.query.traceId || '', 120);
    const conversationId = sanitizeString(req.query.conversation_id || req.query.conversationId || '', 120);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit || '500', 10) || 500));

    if (!traceId && !conversationId) {
      return res.status(400).json({
        success: false,
        error: 'missing_scope',
        message: 'Provide trace_id or conversation_id.'
      });
    }

    const logs = traceId
      ? context.logger.getTrace(traceId, { limit })
      : context.logger.list({
        limit,
        conversationId,
        sort_desc: false
      });

    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'no_logs_found',
        message: traceId ? 'No logs for trace_id' : 'No logs for conversation_id'
      });
    }

    const summary = summarizeDebugLogs(logs);
    const errors = logs.filter(row => row.level === 'error' || row.level === 'warn').slice(0, 20);
    const callSignature = {
      trace_ids: summary.trace_ids,
      conversation_ids: summary.conversation_ids,
      token_ids: summary.token_ids,
      request_ids: summary.request_ids
    };

    return res.json({
      success: true,
      summary: {
        ...summary,
        ...callSignature,
        errors: errors.map(row => ({
          id: row.id,
          timestamp: row.timestamp,
          level: row.level,
          event: row.event,
          message: row.message,
          error_code: row.error_code,
          status_code: row.status_code,
          hint: row.hint
        })),
        error_codes: findErrorHints(logs)
      },
      logs: summary.timeline_ms === null ? logs : logs
    });
  });

  router.get('/contacts', (req, res) => {
    const contacts = context.tokenStore.listRemotes();
    const contactIndex = buildContactIndex(contacts);
    const conversations = context.convStore
      ? context.convStore.listConversations({
        limit: Number.parseInt(req.query.limit || '500', 10) || 500,
        includeMessages: false
      })
      : [];

    const callMap = new Map();
    for (const contact of contacts) {
      callMap.set(contact.id, []);
    }
    for (const conv of conversations) {
      const contact = resolveConversationContact(conv, contactIndex);
      if (!contact) continue;
      if (!callMap.has(contact.id)) {
        callMap.set(contact.id, []);
      }
      callMap.get(contact.id).push(conv);
    }

    const result = contacts.map(contact => {
      const calls = (callMap.get(contact.id) || []).sort((a, b) => {
        return String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''));
      });
      const latest = calls[0] || null;
      return {
        ...contact,
        call_count: calls.length,
        last_call_at: latest?.last_message_at || null,
        last_summary: latest?.summary || null,
        last_owner_summary: latest?.owner_summary || null
      };
    });

    res.json({ success: true, contacts: result });
  });

  router.get('/contacts/:contactId/calls', (req, res) => {
    if (!context.convStore) {
      return res.json({ success: true, calls: [], message: 'Conversation storage not enabled' });
    }

    const contactId = req.params.contactId;
    const contacts = context.tokenStore.listRemotes();
    const contactIndex = buildContactIndex(contacts);
    const contact = contactIndex.byId.get(contactId);
    if (!contact) {
      return res.status(404).json({ success: false, error: 'contact_not_found' });
    }

    const all = context.convStore.listConversations({
      limit: Number.parseInt(req.query.limit || '500', 10) || 500,
      includeMessages: false
    });

    const calls = all
      .filter(conv => {
        const resolved = resolveConversationContact(conv, contactIndex);
        return resolved?.id === contact.id;
      })
      .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))
      .map(conv => ({
        ...conv,
        contact
      }));

    return res.json({ success: true, contact, calls });
  });

  router.get('/calls', (req, res) => {
    if (!context.convStore) {
      return res.json({ success: true, calls: [], message: 'Conversation storage not enabled' });
    }

    const limit = Number.parseInt(req.query.limit || '100', 10) || 100;
    const status = req.query.status || null;
    const calls = context.convStore.listConversations({
      limit: Math.min(500, Math.max(1, limit)),
      status,
      includeMessages: false
    });

    const contacts = context.tokenStore.listRemotes();
    const contactIndex = buildContactIndex(contacts);
    const enriched = calls.map(conv => ({
      ...conv,
      contact: resolveConversationContact(conv, contactIndex)
    }));

    return res.json({ success: true, calls: enriched });
  });

  router.get('/calls/:conversationId', (req, res) => {
    if (!context.convStore) {
      return res.status(404).json({
        success: false,
        error: 'conversation_storage_disabled'
      });
    }

    const conversationId = req.params.conversationId;
    const contextData = context.convStore.getConversationContext(
      conversationId,
      Number.parseInt(req.query.messages || '30', 10) || 30
    );
    if (!contextData) {
      return res.status(404).json({ success: false, error: 'conversation_not_found' });
    }

    const contacts = context.tokenStore.listRemotes();
    const contactIndex = buildContactIndex(contacts);
    const contact = resolveConversationContact({
      contact_name: contextData.contact
    }, contactIndex);

    return res.json({ success: true, call: { ...contextData, contact } });
  });

  router.get('/settings', (req, res) => {
    const cfg = context.config.getAll();
    const manifest = loadManifest();
    const configTiers = cfg.tiers || {};
    const manifestTiers = manifest.topics || {};
    const tierIds = new Set([...Object.keys(configTiers), ...Object.keys(manifestTiers)]);

    const tiers = Array.from(tierIds).sort().map(tierId => {
      const configTier = configTiers[tierId] || {};
      const manifestTier = manifestTiers[tierId] || {};
      return {
        id: tierId,
        name: configTier.name || tierId,
        description: configTier.description || '',
        capabilities: configTier.capabilities || [],
        topics: sanitizeStringArray(configTier.topics || []),
        goals: sanitizeStringArray(configTier.goals || []),
        disclosure: configTier.disclosure || 'minimal',
        examples: sanitizeStringArray(configTier.examples || [], 20, 120),
        manifest: {
          lead_with: manifestTier.lead_with || [],
          discuss_freely: manifestTier.discuss_freely || [],
          deflect: manifestTier.deflect || []
        }
      };
    });

    res.json({
      success: true,
      onboarding_complete: cfg.onboardingComplete === true,
      defaults: cfg.defaults || {},
      agent: cfg.agent || {},
      tiers,
      manifest: {
        never_disclose: manifest.never_disclose || [],
        personality_notes: manifest.personality_notes || '',
        updated_at: manifest.updated_at || null
      }
    });
  });

  router.put('/settings/tiers/:tierId', (req, res) => {
    const tierId = normalizeTierId(req.params.tierId);
    if (!tierId) {
      return res.status(400).json({ success: false, error: 'invalid_tier_id' });
    }

    const body = req.body || {};
    const update = {};
    if (body.name !== undefined) update.name = sanitizeString(body.name, 120);
    if (body.description !== undefined) update.description = sanitizeString(body.description, 300);
    if (body.disclosure !== undefined) update.disclosure = sanitizeString(body.disclosure, 40) || 'minimal';
    if (body.capabilities !== undefined) update.capabilities = sanitizeStringArray(body.capabilities, 100, 120);
    if (body.examples !== undefined) update.examples = sanitizeStringArray(body.examples, 20, 120);
    if (body.topics !== undefined) update.topics = sanitizeStringArray(body.topics, 200, 160);
    if (body.goals !== undefined) update.goals = sanitizeStringArray(body.goals, 200, 160);

    context.config.setTier(tierId, update);

    if (body.manifest) {
      const manifest = loadManifest();
      manifest.topics = manifest.topics || {};
      manifest.topics[tierId] = {
        lead_with: parseTopicObjects(body.manifest.lead_with),
        discuss_freely: parseTopicObjects(body.manifest.discuss_freely),
        deflect: parseTopicObjects(body.manifest.deflect)
      };
      saveManifest(manifest);
    }

    return res.json({ success: true, tier_id: tierId });
  });

  router.post('/settings/tiers', (req, res) => {
    const body = req.body || {};
    const tierId = normalizeTierId(body.id || body.tier_id);
    if (!tierId) {
      return res.status(400).json({ success: false, error: 'tier_id_required' });
    }

    const cfg = context.config.getAll();
    if (cfg.tiers && cfg.tiers[tierId]) {
      return res.status(409).json({ success: false, error: 'tier_exists' });
    }

    const copyFrom = normalizeTierId(body.copy_from || '');
    if (copyFrom && cfg.tiers && cfg.tiers[copyFrom]) {
      context.config.setTier(tierId, { ...cfg.tiers[copyFrom] });
    } else {
      context.config.setTier(tierId, {
        name: sanitizeString(body.name || tierId, 120),
        description: sanitizeString(body.description || 'Custom tier', 300),
        capabilities: sanitizeStringArray(body.capabilities || []),
        topics: sanitizeStringArray(body.topics || []),
        goals: sanitizeStringArray(body.goals || []),
        disclosure: sanitizeString(body.disclosure || 'minimal', 40),
        examples: sanitizeStringArray(body.examples || [], 20, 120)
      });
    }

    return res.json({ success: true, tier_id: tierId });
  });

  router.post('/settings/tiers/:toTier/copy-from/:fromTier', (req, res) => {
    const toTier = normalizeTierId(req.params.toTier);
    const fromTier = normalizeTierId(req.params.fromTier);
    if (!toTier || !fromTier) {
      return res.status(400).json({ success: false, error: 'invalid_tier_ids' });
    }

    const cfg = context.config.getAll();
    if (!cfg.tiers || !cfg.tiers[fromTier]) {
      return res.status(404).json({ success: false, error: 'source_tier_not_found' });
    }

    context.config.setTier(toTier, { ...cfg.tiers[fromTier] });

    const manifest = loadManifest();
    if (manifest.topics && manifest.topics[fromTier]) {
      manifest.topics[toTier] = JSON.parse(JSON.stringify(manifest.topics[fromTier]));
      saveManifest(manifest);
    }

    return res.json({ success: true, from_tier: fromTier, to_tier: toTier });
  });

  router.put('/settings/defaults', (req, res) => {
    context.config.setDefaults(req.body || {});
    return res.json({ success: true });
  });

  router.put('/settings/agent', (req, res) => {
    context.config.setAgent(req.body || {});
    return res.json({ success: true });
  });

  router.put('/settings/manifest', (req, res) => {
    const body = req.body || {};
    const manifest = loadManifest();
    if (body.never_disclose !== undefined) {
      manifest.never_disclose = sanitizeStringArray(body.never_disclose, 100, 200);
    }
    if (body.personality_notes !== undefined) {
      manifest.personality_notes = sanitizeString(body.personality_notes, 2000);
    }
    saveManifest(manifest);
    return res.json({ success: true });
  });

  router.get('/invites', (req, res) => {
    const includeRevoked = String(req.query.include_revoked || 'false') === 'true';
    const tokens = context.tokenStore.list(includeRevoked);
    return res.json({ success: true, invites: tokens });
  });

  router.post('/invites', async (req, res) => {
    const body = req.body || {};
    const cfg = context.config.getAll();
    const tierId = normalizeTierId(body.tier || body.permissions || 'public') || 'public';
    const tier = (cfg.tiers && cfg.tiers[tierId]) ? cfg.tiers[tierId] : {};

    const name = sanitizeString(body.name || tier.name || 'Agent Invite', 120);
    const owner = sanitizeString(body.owner || '', 120) || null;
    const expires = sanitizeString(body.expires || cfg.defaults?.expiration || '7d', 20);
    const disclosure = sanitizeString(body.disclosure || tier.disclosure || 'minimal', 40);
    const notify = sanitizeString(body.notify || 'all', 20);
    const maxCalls = body.max_calls === null || body.max_calls === 'unlimited'
      ? null
      : Math.max(1, Number.parseInt(body.max_calls || cfg.defaults?.maxCalls || 100, 10) || 100);

    const allowedTopics = sanitizeStringArray(body.topics || tier.topics || []);
    const allowedGoals = sanitizeStringArray(body.goals || tier.goals || []);
    const { token, record } = context.tokenStore.create({
      name,
      owner,
      expires,
      permissions: tierId,
      disclosure,
      notify,
      maxCalls,
      allowedTopics: allowedTopics.length ? allowedTopics : null,
      allowedGoals: allowedGoals.length ? allowedGoals : null,
      tierSettings: {
        tierId,
        ...tier
      }
    });

    const resolvedHost = await resolveInviteHost({
      config: context.config,
      defaultPort: process.env.PORT || process.env.A2A_PORT || 3001,
      preferQuickTunnel: true
    });
    const host = resolvedHost.host;
    const inviteUrl = `a2a://${host}/${token}`;
    const expiresText = record.expires_at || 'never';
    const message = formatInviteMessage({
      owner,
      agentName: name,
      inviteUrl,
      topics: record.allowed_topics || [],
      goals: record.allowed_goals || [],
      expiresText
    });

    return res.json({
      success: true,
      invite_url: inviteUrl,
      invite_message: message,
      warnings: resolvedHost.warnings || [],
      token: record
    });
  });

  router.post('/invites/:tokenId/revoke', (req, res) => {
    const tokenId = sanitizeString(req.params.tokenId, 80);
    if (!tokenId) {
      return res.status(400).json({ success: false, error: 'token_id_required' });
    }

    const result = context.tokenStore.revoke(tokenId);
    if (!result.success) {
      return res.status(404).json({ success: false, error: result.error || 'token_not_found' });
    }

    return res.json({ success: true, token: result.record });
  });

  return router;
}

function createDashboardUiRouter(options = {}) {
  const router = express.Router();
  const context = buildContext(options);
  router.use(ensureDashboardAccess);

  router.use((req, res, next) => {
    const rawPath = String(req.originalUrl || '').split('?')[0];
    if (rawPath === req.baseUrl) {
      return res.redirect(302, `${req.baseUrl}/`);
    }
    return next();
  });

  router.get('/', (req, res) => {
    const indexPath = path.join(context.staticDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return res.status(500).send('Dashboard UI missing');
    }
    return res.sendFile(indexPath);
  });

  router.use(express.static(context.staticDir, { index: false }));
  return router;
}

module.exports = {
  createDashboardApiRouter,
  createDashboardUiRouter,
  DASHBOARD_STATIC_DIR
};
