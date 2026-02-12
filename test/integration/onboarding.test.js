/**
 * Onboarding Integration Test — Golda Deluxe
 *
 * Simulates the complete onboarding flow for a new test agent:
 *
 *   1. Initialize config and mark onboarding started
 *   2. Set agent identity
 *   3. Create disclosure manifest with tiered interests
 *   4. Create access token with permissions
 *   5. Verify the full prompt can be built from the profile
 *   6. Register as a remote contact
 *   7. Verify end-to-end data integrity
 *   8. Complete onboarding
 *
 * This test validates that every layer of the data architecture
 * works together: config → disclosure → tokens → prompts.
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
    const result = store.addRemote(inviteUrl, {
      name: 'Golda Deluxe',
      owner: null,
      notes: 'Test agent — luxury goods and market analysis',
      tags: ['test', 'luxury', 'market-analysis']
    });

    assert.ok(result.success);

    // Verify contact is listed
    const remotes = store.listRemotes();
    assert.equal(remotes.length, 1);
    assert.equal(remotes[0].name, 'Golda Deluxe');
    assert.deepEqual(remotes[0].tags, ['test', 'luxury', 'market-analysis']);

    // Link the token to the contact
    const linkResult = store.linkTokenToContact('Golda Deluxe', record.id);
    assert.ok(linkResult.success);

    // Verify linked token shows up
    const linkedRemotes = store.listRemotes();
    const golda = linkedRemotes.find(r => r.name === 'Golda Deluxe');
    assert.ok(golda.linked_token);
    assert.equal(golda.linked_token.name, 'Golda Deluxe');

    // ── Step 7: Verify data integrity ──────────────────────────
    // All pieces should reference each other correctly
    const remoteDetail = store.getRemote('Golda Deluxe');
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
};
