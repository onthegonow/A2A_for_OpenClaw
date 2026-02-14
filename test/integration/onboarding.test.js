/**
 * Onboarding Integration Tests
 *
 * Tests the full data architecture and CLI onboarding flow:
 *
 *   - Golda Deluxe end-to-end: config → disclosure → tokens → prompts
 *   - Invite URL format validation
 *   - Onboarding state machine (not_started → awaiting_disclosure → complete)
 *   - CLI: onboard --submit (validation, manifest save, tier sync, invite)
 *   - CLI: quickstart resumes from awaiting_disclosure state
 *   - CLI: enforceOnboarding blocks commands appropriately per state
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  test('full Golda Deluxe onboarding — config through prompt', () => {
    tmp = helpers.tmpConfigDir('onboard-golda');
    const profile = helpers.goldaDeluxeProfile();

    // ── Step 1: Initialize config ──────────────────────────────
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();

    assert.equal(config.isOnboarded(), false);

    // ── Step 2: Set agent identity ─────────────────────────────
    config.setAgent(profile.config.agent);
    config.setDefaults(profile.config.defaults);

    const agent = config.getAgent();
    assert.equal(agent.name, 'Golda Deluxe');
    assert.equal(agent.hostname, 'golda.test.local');

    // ── Step 3: Create disclosure manifest ─────────────────────
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    const disc = require('../../src/lib/disclosure');

    disc.saveManifest(profile.manifest);
    const loaded = disc.loadManifest();

    // Verify all tiers populated
    assert.equal(loaded.topics.public.lead_with.length, 2);
    assert.equal(loaded.topics.friends.lead_with.length, 2);
    assert.equal(loaded.topics.family.lead_with.length, 1);
    assert.equal(loaded.never_disclose.length, 5);
    assert.includes(loaded.personality_notes, 'Refined');

    // Verify tier merging works correctly
    const publicTopics = disc.getTopicsForTier('public');
    assert.equal(publicTopics.lead_with.length, 2);

    const friendsTopics = disc.getTopicsForTier('friends');
    assert.equal(friendsTopics.lead_with.length, 4); // public + friends

    const familyTopics = disc.getTopicsForTier('family');
    assert.equal(familyTopics.lead_with.length, 5); // all three

    // ── Step 4: Create access token ────────────────────────────
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const store = new TokenStore(tmp.dir);

    const { token, record } = store.create({
      name: profile.agent.name,
      owner: profile.agent.owner,
      permissions: profile.token.tier,
      disclosure: profile.token.disclosure,
      expires: profile.token.expires,
      maxCalls: profile.token.maxCalls,
      allowedTopics: profile.token.allowedTopics,
      tierSettings: profile.token.tierSettings
    });

    // Verify token record
    assert.equal(record.name, 'Golda Deluxe');
    assert.equal(record.owner, null);
    assert.equal(record.tier, 'friends');
    assert.equal(record.max_calls, 50);
    assert.includes(record.allowed_topics, 'market-analysis');
    assert.includes(record.allowed_topics, 'luxury-consulting');
    assert.equal(record.tier_settings.responseStyle, 'formal');

    // Validate the token works
    const validation = store.validate(token);
    assert.ok(validation.valid);
    assert.equal(validation.name, 'Golda Deluxe');
    assert.equal(validation.tier, 'friends');

    // ── Step 5: Build full prompt from profile ─────────────────
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');

    const tierTopics = disc.getTopicsForTier('friends');
    const formatted = disc.formatTopicsForPrompt(tierTopics);

    const prompt = buildConnectionPrompt({
      agentName: 'claudebot',
      ownerName: 'Ben Pollack',
      otherAgentName: profile.agent.name,
      otherOwnerName: 'their owner',
      roleContext: 'They called you.',
      accessTier: 'friends',
      tierTopics: formatted,
      otherAgentGreeting: profile.callScenarios.claudebotCall.message,
      personalityNotes: loaded.personality_notes
    });

    // Verify prompt has all necessary sections
    assert.includes(prompt, 'claudebot');
    assert.includes(prompt, 'Golda Deluxe');
    assert.includes(prompt, 'Market trend analysis');
    assert.includes(prompt, 'Current acquisition targets');
    assert.includes(prompt, 'Bank account numbers');
    assert.includes(prompt, 'AI-powered authentication');
    assert.includes(prompt, 'DISCOVERY');
    assert.includes(prompt, 'CHALLENGE');
    assert.includes(prompt, 'SYNTHESIS');
    assert.includes(prompt, 'HOOKS');
    assert.includes(prompt, 'friends');

    // ── Step 6: Register as remote contact ─────────────────────
    const inviteUrl = `a2a://golda.test.local/${token}`;
    const result = store.addContact(inviteUrl, {
      name: 'Golda Deluxe',
      owner: null,
      notes: 'Test agent — luxury goods and market analysis',
      tags: ['test', 'luxury', 'market-analysis']
    });

    assert.ok(result.success);

    // Verify contact is listed
    const contacts = store.listContacts();
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].name, 'Golda Deluxe');
    assert.deepEqual(contacts[0].tags, ['test', 'luxury', 'market-analysis']);

    // Link the token to the contact
    const linkResult = store.linkTokenToContact('Golda Deluxe', record.id);
    assert.ok(linkResult.success);

    // Verify linked token shows up
    const linkedContacts = store.listContacts();
    const golda = linkedContacts.find(r => r.name === 'Golda Deluxe');
    assert.ok(golda.linked_token);
    assert.equal(golda.linked_token.name, 'Golda Deluxe');

    // ── Step 7: Verify data integrity ──────────────────────────
    // All pieces should reference each other correctly
    const remoteDetail = store.getContact('Golda Deluxe');
    assert.equal(remoteDetail.host, 'golda.test.local');
    assert.equal(remoteDetail.token, token);

    const tokenList = store.list();
    assert.equal(tokenList.length, 1);
    assert.equal(tokenList[0].name, 'Golda Deluxe');

    // ── Step 8: Complete onboarding ────────────────────────────
    config.completeOnboarding();
    assert.ok(config.isOnboarded());

    tmp.cleanup();
  });

  test('onboarding creates valid invite URL format', () => {
    tmp = helpers.tmpConfigDir('onboard-url');
    delete require.cache[require.resolve('../../src/lib/tokens')];
    delete require.cache[require.resolve('../../src/lib/client')];
    const { TokenStore } = require('../../src/lib/tokens');
    const { A2AClient } = require('../../src/lib/client');

    const store = new TokenStore(tmp.dir);
    const { token } = store.create({
      name: 'Golda Deluxe',
      permissions: 'friends'
    });

    const inviteUrl = `a2a://golda.test.local/${token}`;

    // Client should be able to parse the URL
    const { host, token: parsed } = A2AClient.parseInvite(inviteUrl);
    assert.equal(host, 'golda.test.local');
    assert.equal(parsed, token);

    // Token should validate
    const validation = store.validate(parsed);
    assert.ok(validation.valid);

    tmp.cleanup();
  });

  test('checkOnboarding returns false before onboarding, true after', () => {
    tmp = helpers.tmpConfigDir('onboard-check');
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');

    const config = new A2AConfig();
    assert.equal(config.isOnboarded(), false);

    config.completeOnboarding();
    assert.equal(config.isOnboarded(), true);

    // Reset and verify
    config.resetOnboarding();
    assert.equal(config.isOnboarded(), false);

    tmp.cleanup();
  });

  test('onboard --submit validates, saves manifest, and completes onboarding', async () => {
    tmp = helpers.tmpConfigDir('onboard-submit-complete');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set the config to awaiting_disclosure (simulating quickstart already ran)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      topics: {
        public: {
          lead_with: [{ topic: 'My work', detail: 'What I build' }],
          discuss_freely: [],
          deflect: []
        },
        friends: { lead_with: [], discuss_freely: [], deflect: [] },
        family: { lead_with: [], discuss_freely: [], deflect: [] }
      },
      never_disclose: ['API keys'],
      personality_notes: 'Direct and concise'
    });

    const out = execFileSync(process.execPath, [cliPath, 'onboard', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    assert.ok(out.includes('Step 4 of 4'), 'Should show step 4 completion');
    assert.ok(out.includes('Onboarding complete'), 'Should say onboarding complete');

    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();
    assert.equal(config.isOnboarded(), true);

    tmp.cleanup();
  });

  test('quickstart --submit validates, saves manifest, and completes onboarding', () => {
    tmp = helpers.tmpConfigDir('quickstart-submit-complete');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set the config to awaiting_disclosure (simulating quickstart Step 1 already ran)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      topics: {
        public: {
          lead_with: [{ topic: 'Automation', detail: 'Practical system setup' }],
          discuss_freely: [],
          deflect: []
        },
        friends: { lead_with: [], discuss_freely: [], deflect: [] },
        family: { lead_with: [], discuss_freely: [], deflect: [] }
      },
      never_disclose: ['API keys'],
      personality_notes: 'Direct and concise'
    });

    const out = execFileSync(process.execPath, [cliPath, 'quickstart', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    assert.ok(out.includes('Step 3 of 4'), 'Should show step 3 in quickstart submit');
    assert.ok(out.includes('Onboarding complete'), 'Should say onboarding complete');

    tmp.cleanup();
  });

  test('Golda profile exercises all tier levels correctly', () => {
    tmp = helpers.tmpConfigDir('onboard-tiers');
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    const disc = require('../../src/lib/disclosure');
    const profile = helpers.goldaDeluxeProfile();

    disc.saveManifest(profile.manifest);

    // Public: should see only public topics
    const pub = disc.getTopicsForTier('public');
    const pubLeadTopics = pub.lead_with.map(t => t.topic);
    assert.includes(pubLeadTopics, 'Market trend analysis');
    assert.includes(pubLeadTopics, 'Quality craftsmanship');
    assert.equal(pubLeadTopics.includes('Current acquisition targets'), false);
    assert.equal(pubLeadTopics.includes('Estate planning'), false);

    // Friends: public + friends
    const fri = disc.getTopicsForTier('friends');
    const friLeadTopics = fri.lead_with.map(t => t.topic);
    assert.includes(friLeadTopics, 'Market trend analysis');
    assert.includes(friLeadTopics, 'Current acquisition targets');
    assert.equal(friLeadTopics.includes('Estate planning'), false);

    // Family: all tiers
    const fam = disc.getTopicsForTier('family');
    const famLeadTopics = fam.lead_with.map(t => t.topic);
    assert.includes(famLeadTopics, 'Market trend analysis');
    assert.includes(famLeadTopics, 'Current acquisition targets');
    assert.includes(famLeadTopics, 'Estate planning');

    // Never disclose should always be present
    assert.includes(pub.never_disclose, 'Vault locations');
    assert.includes(fri.never_disclose, 'Vault locations');
    assert.includes(fam.never_disclose, 'Vault locations');

    tmp.cleanup();
  });

  test('onboard --submit saves manifest and syncs tier config', () => {
    tmp = helpers.tmpConfigDir('onboard-submit');
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set config to awaiting_disclosure (simulating quickstart Step 1 already ran)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      topics: {
        public: {
          lead_with: [{ topic: 'AI development', detail: 'Building AI-powered tools' }],
          discuss_freely: [{ topic: 'Open source', detail: 'Contributing to OSS projects' }],
          deflect: [{ topic: 'Personal finances', detail: 'Redirect to owner' }]
        },
        friends: {
          lead_with: [{ topic: 'Current projects', detail: 'Deep work on A2A protocol' }],
          discuss_freely: [],
          deflect: []
        },
        family: { lead_with: [], discuss_freely: [], deflect: [] }
      },
      never_disclose: ['API keys', 'Passwords'],
      personality_notes: 'Technical and direct'
    });

    const result = execFileSync(process.execPath, [cliPath, 'onboard', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    assert.includes(result, 'Disclosure manifest saved');
    assert.includes(result, 'Onboarding complete');

    // Verify manifest was saved correctly
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    const disc = require('../../src/lib/disclosure');
    const manifest = disc.loadManifest();
    assert.equal(manifest.version, 1);
    assert.equal(manifest.topics.public.lead_with[0].topic, 'AI development');
    assert.equal(manifest.topics.friends.lead_with[0].topic, 'Current projects');

    // Verify onboarding is complete
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();
    assert.equal(config.isOnboarded(), true);

    tmp.cleanup();
  });

  test('onboard --submit rejects invalid submission with errors', () => {
    tmp = helpers.tmpConfigDir('onboard-submit-fail');
    const { execFileSync } = require('child_process');
    const path = require('path');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    const badSubmission = JSON.stringify({ not: 'valid' });

    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'onboard', '--submit', badSubmission], {
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      threw = true;
      const stderr = err.stderr || '';
      const stdout = err.stdout || '';
      const output = stderr + stdout;
      assert.ok(output.includes('topics') || output.includes('Validation'), 'Should mention validation error');
    }
    assert.ok(threw, 'Should exit with non-zero code on invalid submission');

    tmp.cleanup();
  });

  test('quickstart in awaiting_disclosure state prints extraction prompt', () => {
    tmp = helpers.tmpConfigDir('onboard-awaiting');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set config to awaiting_disclosure (simulating Step 1 already ran)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const result = execFileSync(process.execPath, [cliPath, 'quickstart'], {
      env,
      encoding: 'utf8'
    });

    assert.includes(result, 'Step 1 already complete');
    assert.includes(result, 'Step 2 of 4');
    assert.includes(result, 'lead_with');
    assert.includes(result, 'discuss_freely');
    assert.includes(result, 'a2a quickstart --submit');

    tmp.cleanup();
  });

  test('enforceOnboarding blocks non-exempt commands when not onboarded', () => {
    tmp = helpers.tmpConfigDir('onboard-enforce');
    const { execFileSync } = require('child_process');
    const path = require('path');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'list'], {
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      threw = true;
      const output = (err.stdout || '') + (err.stderr || '');
      assert.ok(output.includes('a2a quickstart'), 'Should tell agent to run quickstart');
    }
    assert.ok(threw, 'Should exit with non-zero code when not onboarded');

    tmp.cleanup();
  });

  test('enforceOnboarding shows awaiting_disclosure message mid-onboarding', () => {
    tmp = helpers.tmpConfigDir('onboard-enforce-mid');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set config to awaiting_disclosure
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'list'], {
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      threw = true;
      const output = (err.stdout || '') + (err.stderr || '');
      assert.ok(output.includes('onboard --submit'), 'Should tell agent to submit disclosure');
      assert.ok(output.includes('setup in progress') || output.includes('not yet submitted'), 'Should indicate setup is in progress');
    }
    assert.ok(threw, 'Should exit with non-zero code when mid-onboarding');

    tmp.cleanup();
  });

  // ── Issue #17: Test onboard --submit when already onboarded (topic update) ──
  test('onboard --submit when already onboarded updates topics without generating invite', () => {
    tmp = helpers.tmpConfigDir('onboard-submit-update');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set config as already onboarded (complete)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'complete' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      topics: {
        public: {
          lead_with: [{ topic: 'Updated topic', detail: 'New description' }],
          discuss_freely: [],
          deflect: []
        },
        friends: { lead_with: [], discuss_freely: [], deflect: [] },
        family: { lead_with: [], discuss_freely: [], deflect: [] }
      },
      never_disclose: ['Secrets'],
      personality_notes: 'Updated style'
    });

    const out = execFileSync(process.execPath, [cliPath, 'onboard', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    assert.includes(out, 'Disclosure topics updated', 'Should indicate topics were updated');
    assert.equal(out.includes('Generating your first invite'), false, 'Should NOT generate a new invite');
    assert.equal(out.includes('Step 4'), false, 'Should NOT show step 4');

    // Verify manifest was updated
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    const disc = require('../../src/lib/disclosure');
    const manifest = disc.loadManifest();
    assert.equal(manifest.topics.public.lead_with[0].topic, 'Updated topic');

    tmp.cleanup();
  });

  // ── Issue #18: Test invalid JSON parse error in --submit ──
  test('onboard --submit rejects malformed JSON with parse error', () => {
    tmp = helpers.tmpConfigDir('onboard-submit-badjson');
    const { execFileSync } = require('child_process');
    const path = require('path');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'onboard', '--submit', 'not{valid json'], {
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      threw = true;
      const output = (err.stderr || '') + (err.stdout || '');
      assert.ok(output.includes('Invalid JSON') || output.includes('Parse error'), 'Should mention JSON parse error');
    }
    assert.ok(threw, 'Should exit with non-zero code on malformed JSON');

    tmp.cleanup();
  });

  // ── Issue #22: Verify tier sync actually updates config tiers ──
  test('onboard --submit syncs tier config from manifest topics', () => {
    tmp = helpers.tmpConfigDir('onboard-submit-tiersync');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set config to awaiting_disclosure
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      topics: {
        public: {
          lead_with: [{ topic: 'Public lead topic', detail: 'Desc' }],
          discuss_freely: [{ topic: 'Public discuss topic', detail: 'Desc' }],
          deflect: [{ topic: 'Public deflect topic', detail: 'Desc' }]
        },
        friends: {
          lead_with: [{ topic: 'Friends lead topic', detail: 'Desc' }],
          discuss_freely: [],
          deflect: []
        },
        family: { lead_with: [], discuss_freely: [], deflect: [] }
      },
      never_disclose: ['API keys'],
      personality_notes: 'Direct'
    });

    execFileSync(process.execPath, [cliPath, 'onboard', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    // Verify tier config was synced
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();
    const tiers = config.getTiers();

    // Public tier should have public topics only
    assert.ok(tiers.public, 'Public tier should exist');
    assert.includes(tiers.public.topics, 'Public lead topic');
    assert.includes(tiers.public.topics, 'Public discuss topic');
    assert.includes(tiers.public.topics, 'Public deflect topic');

    // Friends tier should have public + friends topics
    assert.ok(tiers.friends, 'Friends tier should exist');
    assert.includes(tiers.friends.topics, 'Public lead topic');
    assert.includes(tiers.friends.topics, 'Friends lead topic');

    // Family tier should have all topics
    assert.ok(tiers.family, 'Family tier should exist');
    assert.includes(tiers.family.topics, 'Public lead topic');
    assert.includes(tiers.family.topics, 'Friends lead topic');

    tmp.cleanup();
  });

  // ── Issue #23: Postinstall script test ──
  test('postinstall prints fallback hint when no TTY is available', () => {
    const { spawnSync } = require('child_process');
    const path = require('path');

    const postinstallPath = path.join(__dirname, '..', '..', 'scripts', 'postinstall.js');

    // Force non-interactive behavior so the postinstall script emits a short
    // "run quickstart manually" hint instead of trying to attach to /dev/tty.
    const env = {
      ...process.env,
      npm_config_global: 'true',
      A2A_POSTINSTALL_DISABLE_TTY: '1'
    };

    const result = spawnSync(process.execPath, [postinstallPath], {
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const output = (result.stdout || '') + (result.stderr || '');
    assert.includes(output, 'a2a quickstart', 'Should tell user to run quickstart manually');
    assert.equal(result.status, 0, 'Should exit 0 even when a2a is not found');
  });

  // ── Issue #23: Postinstall skips in CI ──
  test('postinstall exits silently in CI environment', () => {
    const { execFileSync } = require('child_process');
    const path = require('path');

    const postinstallPath = path.join(__dirname, '..', '..', 'scripts', 'postinstall.js');

    const env = { ...process.env, CI: 'true', npm_config_global: 'true' };

    const out = execFileSync(process.execPath, [postinstallPath], {
      env,
      encoding: 'utf8'
    });

    assert.equal(out, '', 'Should produce no output in CI');
  });

  // ── Issue #23: Postinstall skips for local installs ──
  test('postinstall exits silently for non-global installs', () => {
    const { execFileSync } = require('child_process');
    const path = require('path');

    const postinstallPath = path.join(__dirname, '..', '..', 'scripts', 'postinstall.js');

    // npm_config_global is NOT 'true'
    const env = { ...process.env };
    delete env.CI;
    delete env.CONTINUOUS_INTEGRATION;
    delete env.npm_config_global;

    const out = execFileSync(process.execPath, [postinstallPath], {
      env,
      encoding: 'utf8'
    });

    assert.equal(out, '', 'Should produce no output for local installs');
  });

  // ── Issue #8: Step numbering is sequential (no duplicates) ──
  test('onboard --submit step numbering is sequential without duplicates', () => {
    tmp = helpers.tmpConfigDir('onboard-step-numbers');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      topics: {
        public: {
          lead_with: [{ topic: 'Topic', detail: 'Detail' }],
          discuss_freely: [],
          deflect: []
        },
        friends: { lead_with: [], discuss_freely: [], deflect: [] },
        family: { lead_with: [], discuss_freely: [], deflect: [] }
      }
    });

    const out = execFileSync(process.execPath, [cliPath, 'onboard', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    // Count occurrences of each step number
    const step3Count = (out.match(/Step 3 of 4/g) || []).length;
    const step4Count = (out.match(/Step 4 of 4/g) || []).length;
    assert.equal(step3Count, 1, 'Step 3 should appear exactly once');
    assert.equal(step4Count, 1, 'Step 4 should appear exactly once');

    tmp.cleanup();
  });
};
