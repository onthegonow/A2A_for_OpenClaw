/**
 * Disclosure Manifest System
 *
 * Manages a structured list of topics the owner wants to discuss
 * at each access tier. Stored as JSON at ~/.config/openclaw/a2a-disclosure.json.
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const CONFIG_DIR = process.env.A2A_CONFIG_DIR ||
  process.env.OPENCLAW_CONFIG_DIR ||
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const MANIFEST_FILE = path.join(CONFIG_DIR, 'a2a-disclosure.json');

const TIER_HIERARCHY = ['public', 'friends', 'family'];
const logger = createLogger({ component: 'a2a.disclosure' });

/**
 * Load manifest from disk. Returns {} if not found.
 */
function loadManifest() {
  try {
    if (fs.existsSync(MANIFEST_FILE)) {
      return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    }
  } catch (e) {
    logger.error('Failed to load disclosure manifest', {
      event: 'disclosure_manifest_load_failed',
      error: e,
      error_code: 'DISCLOSURE_MANIFEST_LOAD_FAILED',
      hint: 'Fix invalid JSON or file permissions in a2a-disclosure.json.',
      data: {
        manifest_file: MANIFEST_FILE
      }
    });
  }
  return {};
}

/**
 * Save manifest to disk.
 */
function saveManifest(manifest) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  manifest.updated_at = new Date().toISOString();
  const tmpPath = `${MANIFEST_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, MANIFEST_FILE);
  try {
    fs.chmodSync(MANIFEST_FILE, 0o600);
  } catch (err) {
    // Best effort - ignore on platforms without chmod support.
  }
}

/**
 * Get topics for a given tier, merged down the hierarchy.
 * family gets everything, friends gets friends+public, public gets public only.
 *
 * Returns { lead_with, discuss_freely, deflect, never_disclose }
 */
function getTopicsForTier(tier) {
  const manifest = loadManifest();
  const topics = manifest.topics || {};

  const tierIndex = TIER_HIERARCHY.indexOf(tier);
  if (tierIndex === -1) {
    // Unknown tier, treat as public
    return getTopicsForTier('public');
  }

  // Merge tiers from public up to the requested tier
  const tiersToMerge = TIER_HIERARCHY.slice(0, tierIndex + 1);

  const merged = {
    lead_with: [],
    discuss_freely: [],
    deflect: [],
    never_disclose: manifest.never_disclose || []
  };

  for (const t of tiersToMerge) {
    const tierTopics = topics[t] || {};
    if (tierTopics.lead_with) merged.lead_with.push(...tierTopics.lead_with);
    if (tierTopics.discuss_freely) merged.discuss_freely.push(...tierTopics.discuss_freely);
    if (tierTopics.deflect) merged.deflect.push(...tierTopics.deflect);
  }

  // Deflect items: remove any that already appear in lead_with or discuss_freely
  // (higher tiers promote topics from deflect to discuss/lead)
  const promoted = new Set([
    ...merged.lead_with.map(t => t.topic),
    ...merged.discuss_freely.map(t => t.topic)
  ]);
  merged.deflect = merged.deflect.filter(t => !promoted.has(t.topic));

  return merged;
}

/**
 * Format topic lists into readable bullet points for prompt injection.
 */
function formatTopicsForPrompt(tierTopics) {
  const formatList = (items) => {
    if (!items || items.length === 0) return '  (none specified)';
    return items.map(item => `  - ${item.topic}: ${item.detail}`).join('\n');
  };

  return {
    leadWithTopics: formatList(tierTopics.lead_with),
    discussFreelyTopics: formatList(tierTopics.discuss_freely),
    deflectTopics: formatList(tierTopics.deflect),
    neverDisclose: tierTopics.never_disclose?.length
      ? tierTopics.never_disclose.map(item => `  - ${item}`).join('\n')
      : '  (none specified)'
  };
}

/**
 * Generate a minimal starter manifest. This provides safe defaults when
 * no agent-driven extraction has been performed yet.
 *
 * For proper topic extraction, use buildExtractionPrompt() to instruct
 * an agent, then validate the result with validateDisclosureSubmission().
 */
function generateDefaultManifest() {
  const now = new Date().toISOString();

  return {
    version: 1,
    generated_at: now,
    updated_at: now,
    topics: {
      public: {
        lead_with: [{ topic: 'What I do', detail: 'Brief professional description' }],
        discuss_freely: [{ topic: 'General interests', detail: 'Non-sensitive topics and hobbies' }],
        deflect: [{ topic: 'Personal details', detail: 'Redirect to direct owner contact' }]
      },
      friends: { lead_with: [], discuss_freely: [], deflect: [] },
      family: { lead_with: [], discuss_freely: [], deflect: [] }
    },
    never_disclose: ['API keys', 'Other users\' data', 'Financial figures'],
    personality_notes: 'Direct and technical. Prefers depth over breadth.'
  };
}

/**
 * Check if a string contains technical content that shouldn't appear in
 * disclosure topics (code snippets, URLs, markdown formatting, camelCase).
 */
function isTechnicalContent(line) {
  return /`/.test(line) ||
    /https?:\/\//.test(line) ||
    /\*\*:/.test(line) ||
    /:\*\*/.test(line) ||
    /[a-z][A-Z]/.test(line);
}

/**
 * Validate an agent-submitted disclosure submission against the expected schema.
 * Returns { valid: boolean, manifest: object|null, errors: string[] }.
 */
function validateDisclosureSubmission(data) {
  const errors = [];

  // Must be a non-null object
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, manifest: null, errors: ['Submission must be a non-null object'] };
  }

  // Require topics object
  if (!data.topics || typeof data.topics !== 'object' || Array.isArray(data.topics)) {
    errors.push('Submission must include a "topics" object');
    return { valid: false, manifest: null, errors };
  }

  // Require all three tiers
  for (const tier of TIER_HIERARCHY) {
    if (!data.topics[tier] || typeof data.topics[tier] !== 'object') {
      errors.push(`Missing required tier: "${tier}" in topics`);
    }
  }
  if (errors.length > 0) {
    return { valid: false, manifest: null, errors };
  }

  // Validate each tier's structure
  const requiredLists = ['lead_with', 'discuss_freely', 'deflect'];
  for (const tier of TIER_HIERARCHY) {
    const tierData = data.topics[tier];
    for (const listName of requiredLists) {
      if (!Array.isArray(tierData[listName])) {
        errors.push(`topics.${tier}.${listName} must be an array`);
        continue;
      }
      for (let i = 0; i < tierData[listName].length; i++) {
        const item = tierData[listName][i];
        if (!item || typeof item !== 'object' || typeof item.topic !== 'string' || typeof item.detail !== 'string') {
          errors.push(`topics.${tier}.${listName}[${i}]: each topic item must have "topic" (string) and "detail" (string)`);
          continue;
        }
        if (item.topic.length > 160) {
          errors.push(`topics.${tier}.${listName}[${i}]: topic exceeds 160 character limit (got ${item.topic.length})`);
        }
        if (item.detail.length > 500) {
          errors.push(`topics.${tier}.${listName}[${i}]: detail exceeds 500 character limit (got ${item.detail.length})`);
        }
        if (isTechnicalContent(item.topic)) {
          errors.push(`topics.${tier}.${listName}[${i}]: contains technical content (code, URLs, or markdown formatting) — use plain language`);
        }
      }
    }
  }

  // Validate never_disclose (optional, defaults to sensible list)
  if (data.never_disclose !== undefined) {
    if (!Array.isArray(data.never_disclose)) {
      errors.push('"never_disclose" must be an array of strings');
    } else {
      for (let i = 0; i < data.never_disclose.length; i++) {
        if (typeof data.never_disclose[i] !== 'string') {
          errors.push(`never_disclose[${i}] must be a string`);
        }
      }
    }
  }

  // Validate personality_notes (optional)
  if (data.personality_notes !== undefined && typeof data.personality_notes !== 'string') {
    errors.push('"personality_notes" must be a string');
  }

  if (errors.length > 0) {
    return { valid: false, manifest: null, errors };
  }

  // Build valid manifest
  const now = new Date().toISOString();
  const manifest = {
    version: 1,
    generated_at: now,
    updated_at: now,
    topics: data.topics,
    never_disclose: data.never_disclose || ['API keys', 'Other users\' data', 'Financial figures'],
    personality_notes: data.personality_notes || ''
  };

  return { valid: true, manifest, errors: [] };
}

/**
 * Read context files from an OpenClaw workspace directory.
 * Returns { user, heartbeat, soul, skill, claude, memory, skills } with file contents or empty strings.
 */
function readContextFiles(workspaceDir) {
  const read = (filename) => {
    try {
      const filePath = path.join(workspaceDir, filename);
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
    } catch (e) {}
    return '';
  };

  // Read primary files
  const result = {
    user: read('USER.md'),
    heartbeat: read('HEARTBEAT.md'),
    soul: read('SOUL.md'),
    skill: read('SKILL.md'),
    claude: read('CLAUDE.md'),
    skills: ''
  };

  // Scan memory/*.md
  const memoryDir = path.join(workspaceDir, 'memory');
  result.memory = '';
  if (fs.existsSync(memoryDir)) {
    try {
      const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
      result.memory = files.map(f => {
        try { return fs.readFileSync(path.join(memoryDir, f), 'utf8'); }
        catch (e) { return ''; }
      }).filter(Boolean).join('\n---\n');
    } catch (e) {}
  }

  return result;
}

/**
 * Generate the extraction prompt that instructs an agent on exactly what
 * structured disclosure data to return.
 *
 * @param {Object} [availableFiles] - Map of filename to truthy if present
 * @returns {string} The instruction prompt for the agent
 */
function buildExtractionPrompt(availableFiles = {}) {
  const fileList = Object.entries(availableFiles)
    .filter(([, present]) => present)
    .map(([name]) => `  - ${name}`)
    .join('\n') || '  (no workspace files detected)';

  const jsonBlock = '```json\n{\n  "topics": {\n    "public": {\n      "lead_with": [\n        { "topic": "Short label (max 60 chars)", "detail": "Longer description of the topic" }\n      ],\n      "discuss_freely": [],\n      "deflect": []\n    },\n    "friends": {\n      "lead_with": [],\n      "discuss_freely": [],\n      "deflect": []\n    },\n    "family": {\n      "lead_with": [],\n      "discuss_freely": [],\n      "deflect": []\n    }\n  },\n  "never_disclose": ["API keys", "Credentials", "Financial figures"],\n  "personality_notes": "Brief description of communication style"\n}\n```';

  return `## A2A Disclosure Extraction

You are helping the owner set up their A2A disclosure profile — the topics and information their agent is willing to discuss with other agents at different trust levels.

### Available workspace files
${fileList}

Read the available files above and extract disclosure topics. Focus on what the OWNER cares about, works on, and wants to discuss — NOT on agent instructions, code documentation, or operational tasks.

### What to extract

For each trust tier, identify topics the owner would want to discuss:

- **public** — safe for anyone: professional role, public interests, general project descriptions
- **friends** — for trusted contacts: current goals, collaboration interests, values, detailed project work
- **family** — inner circle only: personal interests, private projects, sensitive plans

For each tier, categorize topics as:
- **lead_with** — proactively bring up (max 3 per tier)
- **discuss_freely** — happy to discuss if asked (max 8 per tier)
- **deflect** — redirect or decline (max 3 per tier)

Also identify:
- **never_disclose** — information that should never be shared regardless of tier (API keys, credentials, financial data, etc.)
- **personality_notes** — a 1-2 sentence description of the owner's communication style

### What NOT to extract

Do NOT include as topics:
- Code snippets, CLI commands, or technical documentation
- URLs or file paths
- Agent instructions or operational tasks (e.g., "post 50 comments/day")
- Markdown formatting artifacts (bold markers, backticks)
- Anything from HEARTBEAT.md (these are agent tasks, not disclosure topics)

### Required JSON format

Return ONLY valid JSON in this exact structure:

${jsonBlock}

### Rules

1. Each "topic" string must be a short, human-readable label (max 160 chars)
2. Each "detail" string explains the topic more fully (max 500 chars)
3. Topics should be things a person would discuss, not technical artifacts
4. Higher tiers (friends, family) inherit lower-tier topics automatically — don't duplicate
5. Present this to the owner for review before submitting
6. The owner may edit, remove, or add topics before final submission`;
}

module.exports = {
  loadManifest,
  saveManifest,
  getTopicsForTier,
  formatTopicsForPrompt,
  generateDefaultManifest,
  readContextFiles,
  validateDisclosureSubmission,
  isTechnicalContent,
  buildExtractionPrompt,
  MANIFEST_FILE
};
