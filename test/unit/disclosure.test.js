/**
 * Disclosure Manifest Tests
 *
 * Covers: manifest load/save, tier merging, topic formatting,
 * default manifest generation, and context file parsing.
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  function freshDisclosure() {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('disc');
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    return require('../../src/lib/disclosure');
  }

  // ── Load / Save ───────────────────────────────────────────────

  test('loadManifest returns {} when no file exists', () => {
    const disc = freshDisclosure();
    const manifest = disc.loadManifest();
    assert.deepEqual(manifest, {});
    tmp.cleanup();
  });

  test('saveManifest writes and loadManifest reads back', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();

    disc.saveManifest(profile.manifest);
    const loaded = disc.loadManifest();

    assert.equal(loaded.version, 1);
    assert.ok(loaded.updated_at);
    assert.equal(loaded.topics.public.lead_with.length, 2);
    assert.equal(loaded.topics.public.lead_with[0].topic, 'Market trend analysis');
    tmp.cleanup();
  });

  // ── Tier Merging ──────────────────────────────────────────────

  test('public tier gets only public topics', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();
    disc.saveManifest(profile.manifest);

    const topics = disc.getTopicsForTier('public');

    assert.equal(topics.lead_with.length, 2); // only public lead_with
    assert.equal(topics.discuss_freely.length, 3); // only public discuss_freely
    assert.equal(topics.deflect.length, 2); // only public deflect
    assert.greaterThan(topics.never_disclose.length, 0);
    tmp.cleanup();
  });

  test('friends tier merges public + friends topics', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();
    disc.saveManifest(profile.manifest);

    const topics = disc.getTopicsForTier('friends');

    // lead_with: 2 public + 2 friends = 4
    assert.equal(topics.lead_with.length, 4);
    // discuss_freely: 3 public + 3 friends = 6
    assert.equal(topics.discuss_freely.length, 6);
    // never_disclose is always included
    assert.greaterThan(topics.never_disclose.length, 0);
    tmp.cleanup();
  });

  test('family tier merges all three tiers', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();
    disc.saveManifest(profile.manifest);

    const topics = disc.getTopicsForTier('family');

    // lead_with: 2 public + 2 friends + 1 family = 5
    assert.equal(topics.lead_with.length, 5);
    // discuss_freely: 3 public + 3 friends + 2 family = 8
    assert.equal(topics.discuss_freely.length, 8);
    tmp.cleanup();
  });

  test('promoted topics are removed from deflect', () => {
    const disc = freshDisclosure();

    // Create a manifest where a public deflect topic is promoted in friends
    disc.saveManifest({
      version: 1,
      topics: {
        public: {
          lead_with: [],
          discuss_freely: [],
          deflect: [{ topic: 'Investment stuff', detail: 'redirect' }]
        },
        friends: {
          lead_with: [{ topic: 'Investment stuff', detail: 'now available!' }],
          discuss_freely: [],
          deflect: []
        },
        family: { lead_with: [], discuss_freely: [], deflect: [] }
      },
      never_disclose: []
    });

    const topics = disc.getTopicsForTier('friends');
    const deflectTopics = topics.deflect.map(t => t.topic);
    assert.equal(deflectTopics.includes('Investment stuff'), false);
    tmp.cleanup();
  });

  test('unknown tier falls back to public', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();
    disc.saveManifest(profile.manifest);

    const topics = disc.getTopicsForTier('stranger');
    assert.equal(topics.lead_with.length, 2); // same as public
    tmp.cleanup();
  });

  // ── Topic Formatting ─────────────────────────────────────────

  test('formatTopicsForPrompt produces readable bullet points', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();
    disc.saveManifest(profile.manifest);

    const topics = disc.getTopicsForTier('friends');
    const formatted = disc.formatTopicsForPrompt(topics);

    assert.includes(formatted.leadWithTopics, 'Market trend analysis');
    assert.includes(formatted.discussFreelyTopics, 'Art and design history');
    assert.includes(formatted.neverDisclose, 'Bank account numbers');
    // Each item starts with "  - "
    assert.includes(formatted.leadWithTopics, '  - ');
    tmp.cleanup();
  });

  test('formatTopicsForPrompt handles empty lists', () => {
    const disc = freshDisclosure();
    const formatted = disc.formatTopicsForPrompt({
      lead_with: [],
      discuss_freely: [],
      deflect: [],
      never_disclose: []
    });

    assert.includes(formatted.leadWithTopics, '(none specified)');
    assert.includes(formatted.neverDisclose, '(none specified)');
    tmp.cleanup();
  });

  // ── Default Manifest Generation ───────────────────────────────

  test('generateDefaultManifest with no context returns starter', () => {
    const disc = freshDisclosure();
    const manifest = disc.generateDefaultManifest();

    assert.equal(manifest.version, 1);
    assert.ok(manifest.topics.public.lead_with.length > 0);
    assert.ok(manifest.topics.public.discuss_freely.length > 0);
    assert.ok(manifest.topics.public.deflect.length > 0);
    assert.greaterThan(manifest.never_disclose.length, 0);
    tmp.cleanup();
  });

  test('generateDefaultManifest extracts goals from USER.md content', () => {
    const disc = freshDisclosure();
    const manifest = disc.generateDefaultManifest({
      user: `# About Me
## Goals
- Build AI authentication tools
- Launch luxury goods marketplace
- Expand into Asian markets
`
    });

    // First 2 goals go to lead_with, rest to discuss_freely
    const leadTopics = manifest.topics.public.lead_with.map(t => t.detail);
    assert.ok(leadTopics.some(t => t.includes('AI authentication')));
    tmp.cleanup();
  });

  test('generateDefaultManifest extracts personality from SOUL.md', () => {
    const disc = freshDisclosure();
    const manifest = disc.generateDefaultManifest({
      soul: `Refined and precise. Values quality above all.
Prefers deep technical discussions over small talk.

## Values
- Craftsmanship
- Integrity
- Curiosity
`
    });

    assert.includes(manifest.personality_notes, 'Refined');
    // Values become friends-tier topics
    const friendTopics = manifest.topics.friends.discuss_freely.map(t => t.topic);
    assert.ok(friendTopics.some(t => t.includes('Craftsmanship')));
    tmp.cleanup();
  });

  // ── Context File Reading ──────────────────────────────────────

  test('readContextFiles returns empty strings for missing files', () => {
    const disc = freshDisclosure();
    const result = disc.readContextFiles('/nonexistent/path');
    assert.equal(result.user, '');
    assert.equal(result.heartbeat, '');
    assert.equal(result.soul, '');
    assert.equal(result.skill, '');
    assert.equal(result.claude, '');
    assert.equal(result.memory, '');
    tmp.cleanup();
  });

  test('readContextFiles reads existing files', () => {
    const disc = freshDisclosure();
    const fs = require('fs');
    const path = require('path');

    fs.writeFileSync(path.join(tmp.dir, 'USER.md'), '# Test User');
    fs.writeFileSync(path.join(tmp.dir, 'SOUL.md'), '# Test Soul');

    const result = disc.readContextFiles(tmp.dir);
    assert.equal(result.user, '# Test User');
    assert.equal(result.soul, '# Test Soul');
    assert.equal(result.heartbeat, '');
    tmp.cleanup();
  });

  test('readContextFiles reads SKILL.md and CLAUDE.md', () => {
    const disc = freshDisclosure();
    const fs = require('fs');
    const path = require('path');

    fs.writeFileSync(path.join(tmp.dir, 'SKILL.md'), '# My Skill');
    fs.writeFileSync(path.join(tmp.dir, 'CLAUDE.md'), '# Project Config');

    const result = disc.readContextFiles(tmp.dir);
    assert.equal(result.skill, '# My Skill');
    assert.equal(result.claude, '# Project Config');
    tmp.cleanup();
  });

  test('readContextFiles reads memory/*.md files', () => {
    const disc = freshDisclosure();
    const fs = require('fs');
    const path = require('path');

    const memDir = path.join(tmp.dir, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'notes.md'), '- Important note');
    fs.writeFileSync(path.join(memDir, 'context.md'), '- Another note');

    const result = disc.readContextFiles(tmp.dir);
    assert.ok(result.memory.includes('Important note'));
    assert.ok(result.memory.includes('Another note'));
    tmp.cleanup();
  });

  // ── Expanded Manifest Generation ───────────────────────────────

  test('generateDefaultManifest uses skill content to add topics', () => {
    const disc = freshDisclosure();
    const manifest = disc.generateDefaultManifest({
      skill: `# My Skill
- Handle API authentication
- Process payment webhooks
- Generate PDF reports
`
    });

    const publicDiscuss = manifest.topics.public.discuss_freely.map(t => t.detail);
    assert.ok(publicDiscuss.some(t => t.includes('API authentication')));
    tmp.cleanup();
  });

  test('generateDefaultManifest uses memory content to add topics', () => {
    const disc = freshDisclosure();
    const manifest = disc.generateDefaultManifest({
      memory: `- Working on distributed systems architecture
- Interested in real-time collaboration tools
`
    });

    const friendsDiscuss = manifest.topics.friends.discuss_freely.map(t => t.detail);
    assert.ok(friendsDiscuss.some(t => t.includes('distributed systems')));
    tmp.cleanup();
  });

  test('generateDefaultManifest uses CLAUDE.md context', () => {
    const disc = freshDisclosure();
    const manifest = disc.generateDefaultManifest({
      claude: `# Project
## Quick Context
- A2A enables agent-to-agent communication
- Token management for scoped permissions
`
    });

    const publicDiscuss = manifest.topics.public.discuss_freely.map(t => t.detail);
    assert.ok(publicDiscuss.some(t => t.includes('agent-to-agent')));
    tmp.cleanup();
  });

  test('generateDefaultManifest with only new context fields returns non-starter', () => {
    const disc = freshDisclosure();
    const manifest = disc.generateDefaultManifest({
      skill: '- Handle webhooks\n- Process data pipelines'
    });

    // Should not be the minimal starter (which only has generic topics)
    const publicDiscuss = manifest.topics.public.discuss_freely.map(t => t.detail);
    assert.ok(publicDiscuss.some(t => t.includes('webhooks') || t.includes('pipelines')));
    tmp.cleanup();
  });
};
