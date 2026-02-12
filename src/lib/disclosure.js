/**
 * Disclosure Manifest System
 *
 * Manages a structured list of topics the owner wants to discuss
 * at each access tier. Stored as JSON at ~/.config/openclaw/a2a-disclosure.json.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = process.env.A2A_CONFIG_DIR ||
  process.env.OPENCLAW_CONFIG_DIR ||
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const MANIFEST_FILE = path.join(CONFIG_DIR, 'a2a-disclosure.json');

const TIER_HIERARCHY = ['public', 'friends', 'family'];

/**
 * Load manifest from disk. Returns {} if not found.
 */
function loadManifest() {
  try {
    if (fs.existsSync(MANIFEST_FILE)) {
      return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[a2a] Failed to load disclosure manifest:', e.message);
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
 * Generate a default manifest by reading USER.md, HEARTBEAT.md, SOUL.md
 * from the owner's workspace. Falls back to a minimal starter if files don't exist.
 */
function generateDefaultManifest(contextFiles = {}) {
  const now = new Date().toISOString();

  const manifest = {
    version: 1,
    generated_at: now,
    updated_at: now,
    topics: {
      public: { lead_with: [], discuss_freely: [], deflect: [] },
      friends: { lead_with: [], discuss_freely: [], deflect: [] },
      family: { lead_with: [], discuss_freely: [], deflect: [] }
    },
    never_disclose: ['API keys', 'Other users\' data', 'Financial figures'],
    personality_notes: 'Direct and technical. Prefers depth over breadth.'
  };

  const userContent = contextFiles.user || '';
  const heartbeatContent = contextFiles.heartbeat || '';
  const soulContent = contextFiles.soul || '';

  const hasContent = userContent || heartbeatContent || soulContent;

  if (!hasContent) {
    // Minimal starter manifest
    manifest.topics.public.lead_with.push(
      { topic: 'What I do', detail: 'Brief professional description' }
    );
    manifest.topics.public.discuss_freely.push(
      { topic: 'General interests', detail: 'Non-sensitive topics and hobbies' }
    );
    manifest.topics.public.deflect.push(
      { topic: 'Personal details', detail: 'Redirect to direct owner contact' }
    );
    return manifest;
  }

  // Extract from USER.md
  if (userContent) {
    // Goals/seeking
    const goalsMatch = userContent.match(/##\s*(?:Goals|Current|Seeking|Working On)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
    if (goalsMatch) {
      const goals = goalsMatch[1]
        .split('\n')
        .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
        .map(l => l.replace(/^[\s\-\*]+/, '').trim())
        .filter(Boolean);

      goals.forEach((goal, i) => {
        if (i < 2) {
          manifest.topics.public.lead_with.push({ topic: goal.slice(0, 60), detail: goal });
        } else {
          manifest.topics.public.discuss_freely.push({ topic: goal.slice(0, 60), detail: goal });
        }
      });
    }

    // Interests/projects
    const interestsMatch = userContent.match(/##\s*(?:Interests|Projects|Skills)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
    if (interestsMatch) {
      const interests = interestsMatch[1]
        .split('\n')
        .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
        .map(l => l.replace(/^[\s\-\*]+/, '').trim())
        .filter(Boolean);

      interests.forEach(interest => {
        manifest.topics.public.discuss_freely.push({ topic: interest.slice(0, 60), detail: interest });
      });
    }

    // Private/personal sections go to friends/family
    const privateMatch = userContent.match(/##\s*(?:Private|Personal|Family)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
    if (privateMatch) {
      const privateItems = privateMatch[1]
        .split('\n')
        .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
        .map(l => l.replace(/^[\s\-\*]+/, '').trim())
        .filter(Boolean);

      privateItems.forEach(item => {
        manifest.topics.family.discuss_freely.push({ topic: item.slice(0, 60), detail: item });
      });

      // Deflect these for public
      manifest.topics.public.deflect.push(
        { topic: 'Personal life', detail: 'Redirect — suggest owners connect directly' }
      );
    }
  }

  // Extract from HEARTBEAT.md (recent activity/status)
  if (heartbeatContent) {
    const recentLines = heartbeatContent
      .split('\n')
      .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
      .map(l => l.replace(/^[\s\-\*]+/, '').trim())
      .filter(Boolean)
      .slice(0, 5);

    recentLines.forEach((line, i) => {
      if (i < 2) {
        manifest.topics.public.lead_with.push({ topic: line.slice(0, 60), detail: line });
      } else {
        manifest.topics.friends.discuss_freely.push({ topic: line.slice(0, 60), detail: line });
      }
    });
  }

  // Extract from SOUL.md (personality, values)
  if (soulContent) {
    // Look for personality cues
    const personalityLines = soulContent
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .slice(0, 3)
      .join(' ')
      .trim();

    if (personalityLines) {
      manifest.personality_notes = personalityLines.slice(0, 300);
    }

    // Values become friends-tier topics
    const valuesMatch = soulContent.match(/##\s*(?:Values|Beliefs|Principles)[^\n]*\n([\s\S]*?)(?=\n##|$)/i);
    if (valuesMatch) {
      const values = valuesMatch[1]
        .split('\n')
        .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
        .map(l => l.replace(/^[\s\-\*]+/, '').trim())
        .filter(Boolean);

      values.forEach(value => {
        manifest.topics.friends.discuss_freely.push({ topic: value.slice(0, 60), detail: value });
      });
    }
  }

  // Ensure at least something in each public category
  if (manifest.topics.public.lead_with.length === 0) {
    manifest.topics.public.lead_with.push(
      { topic: 'Current focus', detail: 'Primary work and interests' }
    );
  }
  if (manifest.topics.public.discuss_freely.length === 0) {
    manifest.topics.public.discuss_freely.push(
      { topic: 'General interests', detail: 'Non-sensitive topics' }
    );
  }
  if (manifest.topics.public.deflect.length === 0) {
    manifest.topics.public.deflect.push(
      { topic: 'Private matters', detail: 'Redirect to direct owner contact' }
    );
  }

  return manifest;
}

/**
 * Read context files from an OpenClaw workspace directory.
 * Returns { user, heartbeat, soul } with file contents or empty strings.
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

  return {
    user: read('USER.md'),
    heartbeat: read('HEARTBEAT.md'),
    soul: read('SOUL.md')
  };
}

module.exports = {
  loadManifest,
  saveManifest,
  getTopicsForTier,
  formatTopicsForPrompt,
  generateDefaultManifest,
  readContextFiles,
  MANIFEST_FILE
};
