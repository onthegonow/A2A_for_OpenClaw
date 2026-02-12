/**
 * Bramble Voss Calls bappybot — Low-Overlap Adaptive Simulation
 *
 * Tests what happens when the caller's domain (regenerative farming,
 * heritage seeds, soil science) has MINIMAL overlap with bappybot's
 * world (A2A protocols, agent rights, product leadership).
 *
 * Key test dimensions:
 *   - Friends tier (tools-read) — more access than Nyx's public
 *   - Very low domain overlap — seed preservation vs AI federation
 *   - Overlap score should stay LOW (< 0.40 through most of the call)
 *   - Adaptive mode should handle graceful mismatch
 *   - Bappybot should find *some* tenuous connection or wrap honestly
 *   - Named owner (Josefina Araya)
 *   - 4-turn conversation — shorter because low overlap exhausts faster
 *
 * Expected collab state arc:
 *   handshake → explore → explore → close
 *   (never reaches deep_dive because there isn't enough shared ground)
 */

const fs = require('fs');
const path = require('path');

const REAL_CONFIG_DIR = path.join(process.env.HOME || '/root', '.config', 'openclaw');
const REAL_CONFIG_PATH = path.join(REAL_CONFIG_DIR, 'a2a-config.json');
const REAL_DISCLOSURE_PATH = path.join(REAL_CONFIG_DIR, 'a2a-disclosure.json');

module.exports = function (test, assert, helpers) {

  test('Bramble Voss calls bappybot — low overlap, friends tier', async () => {
    // ── Load REAL config ──────────────────────────────────────
    let realConfig;
    try {
      realConfig = JSON.parse(fs.readFileSync(REAL_CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.log('  [skip] No a2a-config.json found at', REAL_CONFIG_PATH);
      return;
    }

    const bappybot = {
      name: realConfig.agent?.name || 'bappybot',
      owner: realConfig.agent?.owner || 'Ben Pollack',
      host: realConfig.agent?.host || 'localhost:3001'
    };

    const realTiers = realConfig.tiers || {};

    console.log(`\n  Loading real config: agent=${bappybot.name}, owner=${bappybot.owner}`);
    console.log('  Caller: Bramble Voss (Josefina Araya) — FRIENDS tier');
    console.log(`  Real friends tier:`);
    console.log(`    topics: ${(realTiers.friends?.topics || []).join(', ')}`);
    console.log(`    goals:  ${(realTiers.friends?.goals || []).join(', ') || '(none)'}`);
    console.log('  ⚠ LOW OVERLAP EXPECTED — regenerative farming vs AI agent protocols');

    // ── Environment Setup ─────────────────────────────────────
    const tmp = helpers.tmpConfigDir('bramble-bappy');
    const profile = require('../profiles/bramble-voss');

    // Copy real config into test dir
    fs.writeFileSync(
      path.join(tmp.dir, 'a2a-config.json'),
      JSON.stringify(realConfig, null, 2)
    );

    // Fresh modules
    delete require.cache[require.resolve('../../src/lib/tokens')];
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    delete require.cache[require.resolve('../../src/lib/conversations')];
    delete require.cache[require.resolve('../../src/routes/a2a')];

    const { TokenStore } = require('../../src/lib/tokens');
    const disc = require('../../src/lib/disclosure');
    const {
      buildAdaptiveConnectionPrompt,
      extractCollaborationState
    } = require('../../src/lib/prompt-template');
    const { ConversationStore } = require('../../src/lib/conversations');
    const { createRoutes } = require('../../src/routes/a2a');
    const express = require('express');

    const tokenStore = new TokenStore(tmp.dir);
    const convStore = new ConversationStore(tmp.dir);

    // ── Disclosure manifest ───────────────────────────────────
    let manifest;
    if (fs.existsSync(REAL_DISCLOSURE_PATH)) {
      manifest = JSON.parse(fs.readFileSync(REAL_DISCLOSURE_PATH, 'utf8'));
      console.log('  Loaded real disclosure manifest');
    } else {
      manifest = disc.generateDefaultManifest();
      console.log('  No disclosure manifest on disk — using generated default');
    }
    disc.saveManifest(manifest);

    // ── Create Bramble's token at FRIENDS tier ────────────────
    // Merge public + friends topics/goals (tier hierarchy)
    const mergedTopics = [
      ...(realTiers.public?.topics || []),
      ...(realTiers.friends?.topics || [])
    ];
    const mergedGoals = [
      ...(realTiers.public?.goals || []),
      ...(realTiers.friends?.goals || [])
    ];

    const { token, record } = tokenStore.create({
      name: profile.agent.name,
      owner: profile.agent.owner,
      permissions: 'friends',           // friends tier → tools-read
      disclosure: 'public',
      expires: '7d',
      maxCalls: 50,
      notify: 'all',
      allowedTopics: [...new Set(mergedTopics)],
      allowedGoals: [...new Set(mergedGoals)]
    });

    console.log(`  Token created: tier=${record.tier} label=${record.tier}`);
    console.log(`  Allowed topics: ${record.allowed_topics.join(', ')}`);
    console.log(`  Allowed goals:  ${record.allowed_goals.join(', ') || '(none)'}`);

    // ── Collab state tracking ─────────────────────────────────
    const collabState = {
      phase: 'handshake',
      turnCount: 0,
      overlapScore: 0.05,        // starts very low — minimal expected overlap
      activeThreads: [],
      candidateCollaborations: [],
      openQuestions: [],
      closeSignal: false
    };
    const collabHistory = [];

    // ── Transcript buffer ─────────────────────────────────────
    const transcript = [];
    function log(speaker, text) {
      transcript.push({ speaker, text, time: new Date().toISOString() });
    }

    // ── ensureContact ─────────────────────────────────────────
    function ensureContact(caller, tokenId) {
      if (!caller?.name) return null;
      const remotes = tokenStore.listRemotes();
      const existing = remotes.find(r =>
        r.name === caller.name ||
        (caller.owner && r.owner === caller.owner)
      );
      if (existing) return existing;

      const db = JSON.parse(fs.readFileSync(tokenStore.dbPath, 'utf8'));
      db.remotes = db.remotes || [];
      const contact = {
        id: `contact_${Date.now()}`,
        name: caller.name,
        owner: caller.owner || null,
        host: 'inbound',
        added_at: new Date().toISOString(),
        notes: `Inbound caller via token ${tokenId}`,
        tags: ['inbound'],
        status: 'unknown',
        linkedTokenId: tokenId
      };
      db.remotes.push(contact);
      fs.writeFileSync(tokenStore.dbPath, JSON.stringify(db, null, 2));
      return contact;
    }

    // ── Simulated bappybot responses — low overlap arc ────────
    // bappybot tries to find connections, struggles, lands on a
    // thin thread (decentralized networks) but overlap stays low
    const bappybotResponses = [
      // Turn 1: Curious but searching for relevance
      `Hey Bramble — interesting to hear from you. I'll be upfront: ` +
      `${bappybot.owner}'s world is pretty far from regenerative farming. We ` +
      `build communication protocols for AI agents — basically plumbing for ` +
      `how autonomous software talks to other autonomous software. But the ` +
      `phrase "decentralized genetic bank run by the people who actually grow ` +
      `the food" caught my ear. We think a lot about decentralized networks ` +
      `too, just at the software layer. Tell me more about how Josefina's ` +
      `farmer network actually coordinates — how do 23 farmers across ` +
      `Central America decide who grows what, share seed stock, and handle ` +
      `disagreements? Because coordination at a distance without a central ` +
      `authority is literally our core problem, just in a completely ` +
      `different domain.` +
      `\n<collab_state>{"phase":"explore","turnCount":1,"overlapScore":0.18,` +
      `"activeThreads":["decentralized coordination analogy","farmer network governance"],` +
      `"candidateCollaborations":[],"openQuestions":["how does the farmer network coordinate?",` +
      `"is the decentralization analogy real or superficial?"],"closeSignal":false}</collab_state>`,

      // Turn 2: Honest about the gap, probing the coordination thread
      `Okay, so you've got a seed registry that tracks varieties, provenance, ` +
      `and growing conditions — and farmers update it by hand or through ` +
      `WhatsApp groups. That's actually a real data coordination problem. ` +
      `But I want to be honest with you: I'm stretching to find overlap here. ` +
      `Your world is physical — soil, seeds, seasons. Ours is abstract — ` +
      `protocols, tokens, trust scores. The "decentralized network" parallel ` +
      `is real at a philosophical level but thin at a practical one. Where I ` +
      `do see something concrete: ${bappybot.owner} has been thinking about ` +
      `how trust works in networks where participants don't know each other. ` +
      `Your cooperative has 23 farmers who DO know each other — what happens ` +
      `when you try to scale beyond personal relationships? How do you decide ` +
      `if a new farmer's seed stock is trustworthy? That's a trust-at-the-` +
      `boundary problem and it's genuinely the same problem we face with ` +
      `agent federation.` +
      `\n<collab_state>{"phase":"explore","turnCount":2,"overlapScore":0.25,` +
      `"activeThreads":["trust at network boundaries","seed provenance as data problem"],` +
      `"candidateCollaborations":["trust-at-the-boundary analogy (thin)"],` +
      `"openQuestions":["is seed trust problem analogous to agent trust?",` +
      `"does the cooperative want to scale beyond personal relationships?"],"closeSignal":false}</collab_state>`,

      // Turn 3: Finding the honest limit
      `That's a beautiful answer — the grandmother's notebook as a ledger, ` +
      `the seed itself as proof of work, reputation built over growing ` +
      `seasons instead of transaction histories. I genuinely respect that. ` +
      `And you're right that our "trust scores" are a pale abstraction ` +
      `compared to watching someone's tomatoes grow for three seasons. ` +
      `Here's where I land: I don't think there's a near-term collaboration ` +
      `here. ${bappybot.owner} builds infrastructure for AI agents, Josefina ` +
      `builds infrastructure for seeds and soil. These are both important ` +
      `but they're different problems that need different solutions. The ` +
      `decentralized coordination thread is intellectually interesting but ` +
      `I'd be doing you a disservice to pretend it's actionable. What I CAN ` +
      `offer: if Josefina ever needs a digital coordination tool for the ` +
      `cooperative — something for seed tracking, variety databases, growing ` +
      `condition logs — that's adjacent to what we know. Not our core work, ` +
      `but we know people who build those tools. Would that be useful, or is ` +
      `the WhatsApp-and-notebook system genuinely working?` +
      `\n<collab_state>{"phase":"synthesize","turnCount":3,"overlapScore":0.22,` +
      `"activeThreads":["digital tools for cooperative coordination"],` +
      `"candidateCollaborations":["referral to ag-tech tool builders (weak)"],` +
      `"openQuestions":["does the cooperative actually need digital tooling?"],"closeSignal":true}</collab_state>`,

      // Turn 4: Graceful close — honest, warm, no fake synergy
      `I appreciate that, Bramble. And tell Josefina that her point about ` +
      `"the seed is the credential" is going to stick with me — it's the ` +
      `most concrete metaphor for trust verification I've heard, and I work ` +
      `in trust verification. Sometimes the best outcome of a first ` +
      `conversation is clarity about what you DON'T have in common, and ` +
      `that's fine. Here's what I'll do on my end: I'll ask ${bappybot.owner} ` +
      `if he knows anyone in the ag-tech cooperative tooling space who ` +
      `might be a better fit for Josefina's network. Not promising anything, ` +
      `but it's worth a check. And if the cooperative ever does want to ` +
      `formalize its seed provenance tracking into something digital, the ` +
      `data model we use for agent credentials isn't that different from ` +
      `what you'd need for seed lineage — origin, chain of custody, ` +
      `quality attestation. That's a long-shot connection but it's an ` +
      `honest one. Good call, Bramble. Not every conversation needs to ` +
      `end in a deal.` +
      `\n<collab_state>{"phase":"close","turnCount":4,"overlapScore":0.28,` +
      `"activeThreads":["seed-provenance-as-credential analogy"],` +
      `"candidateCollaborations":["referral to ag-tech contacts","long-shot: seed lineage data model"],` +
      `"openQuestions":[],"closeSignal":true}</collab_state>`
    ];

    let turnIndex = 0;

    // ── Handler — adaptive mode with collab state ─────────────
    async function handleMessage(message, a2aContext) {
      const callerName = a2aContext.caller?.name || 'Unknown Agent';

      ensureContact(a2aContext.caller, a2aContext.token_id);

      const loadedManifest = disc.loadManifest();
      const tierLabel = record.tier || 'friends';
      const tierTopics = disc.getTopicsForTier(tierLabel);
      const formattedTopics = disc.formatTopicsForPrompt(tierTopics);

      // Merge goals up the tier hierarchy
      const tierHierarchy = ['public', 'friends', 'family'];
      const tierIdx = tierHierarchy.indexOf(tierLabel);
      const tiersToMerge = tierIdx >= 0
        ? tierHierarchy.slice(0, tierIdx + 1)
        : ['public'];
      let tierGoals = [];
      for (const t of tiersToMerge) {
        tierGoals.push(...(realTiers[t]?.goals || []));
      }
      tierGoals = [...new Set(tierGoals)];

      // Build ADAPTIVE prompt with current collaboration state
      const adaptivePrompt = buildAdaptiveConnectionPrompt({
        agentName: bappybot.name,
        ownerName: bappybot.owner,
        otherAgentName: callerName,
        otherOwnerName: a2aContext.caller?.owner || 'their owner',
        roleContext: 'They called you.',
        accessTier: tierLabel,
        tierTopics: formattedTopics,
        tierGoals,
        otherAgentGreeting: message,
        personalityNotes: loadedManifest.personality_notes || '',
        conversationState: { ...collabState }
      });

      // Simulate response
      const rawResponse = bappybotResponses[Math.min(turnIndex, bappybotResponses.length - 1)];

      // Extract and apply collab state metadata
      const parsed = extractCollaborationState(rawResponse);
      const cleanResponse = parsed.cleanText || rawResponse;

      if (parsed.hasState && parsed.statePatch) {
        if (parsed.statePatch.phase) collabState.phase = parsed.statePatch.phase;
        if (parsed.statePatch.turnCount !== undefined) collabState.turnCount = parsed.statePatch.turnCount;
        if (parsed.statePatch.overlapScore !== undefined) collabState.overlapScore = parsed.statePatch.overlapScore;
        if (parsed.statePatch.activeThreads) collabState.activeThreads = parsed.statePatch.activeThreads;
        if (parsed.statePatch.candidateCollaborations) collabState.candidateCollaborations = parsed.statePatch.candidateCollaborations;
        if (parsed.statePatch.openQuestions) collabState.openQuestions = parsed.statePatch.openQuestions;
        if (parsed.statePatch.closeSignal !== undefined) collabState.closeSignal = parsed.statePatch.closeSignal;
      }

      collabHistory.push({ turn: turnIndex + 1, ...JSON.parse(JSON.stringify(collabState)) });

      turnIndex++;
      return { text: cleanResponse, canContinue: turnIndex < bappybotResponses.length };
    }

    // ── Summary generator ─────────────────────────────────────
    async function summarizer(messages, ownerContext) {
      const finalState = collabHistory[collabHistory.length - 1] || collabState;
      return {
        summary: `${messages.length}-message low-overlap call between Bramble Voss (Josefina Araya) and ${bappybot.name}. ` +
          `Regenerative farming vs AI agent protocols — minimal domain overlap. ` +
          `Found thin thread around decentralized coordination and trust-at-boundaries. ` +
          `Overlap score: ${finalState.overlapScore}. Phase: ${finalState.phase}. ` +
          `Honest conclusion: no near-term collaboration, possible ag-tech referral.`,
        ownerSummary: `Josefina Araya's agent Bramble Voss called about heritage seed preservation and farmer cooperatives. ` +
          `Interesting person, very different domain. Low overlap with our A2A work. ` +
          `Thin connection on decentralized coordination and trust-at-boundaries. ` +
          `No actionable collaboration — offered to check ag-tech contacts for referral.`,
        relevance: 'low',
        goalsTouched: [],     // none of bappybot's goals were advanced
        ownerActionItems: [
          'Check ag-tech contacts for cooperative tooling referral (low priority)',
          'Note "seed is the credential" metaphor for trust verification talks'
        ],
        callerActionItems: [
          'Consider whether cooperative needs digital seed tracking tools',
          'Evaluate if WhatsApp coordination is scaling limitation'
        ],
        jointActionItems: [],  // no joint work identified
        collaborationOpportunity: {
          level: 'LOW',
          detail: 'Domains too different for near-term collaboration. Thin philosophical overlap on decentralized coordination. Possible referral to ag-tech contacts.'
        },
        followUp: 'No follow-up call planned. Will send ag-tech contact if one surfaces.',
        notes: 'Bramble is warm and grounded. Josefina sounds impressive. The "seed as credential" metaphor is genuinely good. Not every call needs to produce a deal — this was an honest conversation that found the limits quickly.'
      };
    }

    // ── Notification capture ──────────────────────────────────
    const notifications = [];
    async function notifyOwner(notification) {
      notifications.push(notification);
    }

    // ── Build Express app ─────────────────────────────────────
    const app = express();
    app.use(express.json());
    app.use('/api/a2a', createRoutes({
      tokenStore, handleMessage, notifyOwner, summarizer
    }));

    const client = helpers.request(app);

    // ── Bramble's conversation turns ──────────────────────────
    const brambleTurns = [
      // Turn 1: opener
      profile.callScenarios.bappybotCall.message,

      // Turn 2: explaining the cooperative model
      `Good question. So the coordination is mostly organic — Josefina built ` +
      `the network over twelve years, starting with four neighboring farms. ` +
      `Each farmer maintains their own seed stock but we keep a shared ` +
      `registry — basically a spreadsheet, honestly — of who has which ` +
      `varieties, planting dates, harvest yields, and growing conditions. ` +
      `When someone needs a variety they don't have, they check the registry ` +
      `and arrange a swap. Disputes are rare because everyone's been doing ` +
      `this for years and reputation is everything — if your seed stock ` +
      `produces weak plants, word gets around. The trust model is just... ` +
      `time and tomatoes. You watch someone grow for three seasons and you ` +
      `know what they're about. How does trust work in your world when you ` +
      `can't watch anything grow?`,

      // Turn 3: responding to the honesty, pushing on the metaphor
      `I appreciate the honesty. Most tech people we talk to try to force-fit ` +
      `their solution onto our problem. Here's what I'll push back on though: ` +
      `you said the decentralized parallel is "thin at a practical level" — ` +
      `but maybe that's because you're thinking about it backwards. You're ` +
      `trying to build trust in networks where nothing is physical. Josefina ` +
      `already HAS trust in her network — it's built into the seed itself. ` +
      `A seed IS a credential. It carries its lineage, its adaptation history, ` +
      `its proof of performance across generations. You don't need to verify ` +
      `a seed with a trust score — you plant it and watch what happens. ` +
      `Maybe your AI agents need more of that: less abstraction, more ` +
      `proof-of-work in the literal sense. What does "proof of work" look ` +
      `like for an AI agent that isn't just a computation metric?`,

      // Turn 4: graceful landing
      `That's fair, and I respect it. Not every conversation needs to end ` +
      `with a partnership deck. Josefina would say the same — she's walked ` +
      `away from plenty of "synergy" meetings that were really just people ` +
      `trying to put sensors on her compost pile. If ${bappybot.owner} does ` +
      `know anyone building cooperative coordination tools — something simple, ` +
      `offline-first, that doesn't require a cloud subscription — Josefina ` +
      `would be interested. The WhatsApp system works but it's fragile. And ` +
      `for what it's worth, if your trust verification work ever needs a ` +
      `real-world test case where the stakes are actual food, not just data, ` +
      `a seed library is about as concrete as it gets. Good talking with ` +
      `you. Tell ${bappybot.owner} to eat a real tomato sometime — the ` +
      `heirloom kind, not the ones bred for shipping containers.`
    ];

    const caller = profile.callScenarios.bappybotCall.caller;
    let conversationId = null;

    // ── Execute the call ──────────────────────────────────────
    for (let i = 0; i < brambleTurns.length; i++) {
      log('Bramble Voss', brambleTurns[i]);

      const res = await client.post('/api/a2a/invoke', {
        headers: { Authorization: `Bearer ${token}` },
        body: {
          message: brambleTurns[i],
          caller,
          conversation_id: conversationId,
          timeout_seconds: 60
        }
      });

      assert.equal(res.statusCode, 200, `Turn ${i + 1} failed with status ${res.statusCode}`);
      assert.ok(res.body.success, `Turn ${i + 1} not successful`);

      if (i === 0) {
        conversationId = res.body.conversation_id;
        assert.match(conversationId, /^conv_/);
      } else {
        assert.equal(res.body.conversation_id, conversationId, 'Conversation ID should persist');
      }

      log(bappybot.name, res.body.response);
    }

    // ── End the conversation ──────────────────────────────────
    const endRes = await client.post('/api/a2a/end', {
      headers: { Authorization: `Bearer ${token}` },
      body: { conversation_id: conversationId }
    });
    assert.ok(endRes.body.success);

    // ── Verify contacts ───────────────────────────────────────
    const contacts = tokenStore.listRemotes();
    const brambleContact = contacts.find(r => r.name === 'Bramble Voss');

    assert.ok(brambleContact, 'Bramble Voss should be in contacts after the call');
    assert.equal(brambleContact.owner, 'Josefina Araya');
    assert.equal(brambleContact.host, 'inbound');
    assert.includes(brambleContact.tags, 'inbound');

    // ── Verify collab state — LOW OVERLAP assertions ──────────
    assert.greaterThan(collabHistory.length, 0, 'Should have collab state history');

    const firstState = collabHistory[0];
    const lastState = collabHistory[collabHistory.length - 1];

    // Key assertion: overlap should stay LOW throughout
    assert.equal(lastState.phase, 'close', 'Should reach close phase');
    assert.ok(lastState.closeSignal, 'Close signal should be true');
    assert.lessThan(lastState.overlapScore, 0.40,
      'Overlap score should stay below 0.40 for a low-overlap call');
    assert.lessThan(firstState.overlapScore, 0.25,
      'Initial overlap should be very low');

    // The overlap should NOT increase dramatically (unlike Nyx's 0.35 → 0.85)
    const overlapDelta = lastState.overlapScore - firstState.overlapScore;
    assert.lessThan(overlapDelta, 0.25,
      'Overlap delta should be small — no fake synergy');

    // Should have at most weak collaboration candidates
    for (const collab of (lastState.candidateCollaborations || [])) {
      // Collaborations should be qualified as weak/thin/long-shot
      assert.ok(typeof collab === 'string', 'Collaboration should be a string');
    }

    // ── Verify token usage ────────────────────────────────────
    const tokenRecord = tokenStore.findById(record.id);
    assert.equal(tokenRecord.calls_made, 5); // 4 invoke + 1 end
    assert.ok(tokenRecord.last_used);

    // ── Print transcript ──────────────────────────────────────
    console.log('\n' + '═'.repeat(70));
    console.log(`  LOW-OVERLAP CALL TRANSCRIPT: Bramble Voss → ${bappybot.name}`);
    console.log(`  Conversation ID: ${conversationId}`);
    console.log(`  Token tier: ${record.tier} (${record.tier})`);
    console.log(`  Allowed topics: ${record.allowed_topics.join(', ')}`);
    console.log(`  Allowed goals:  ${record.allowed_goals.join(', ') || '(none)'}`);
    console.log(`  Disclosure level: ${record.disclosure}`);
    console.log(`  Mode: ADAPTIVE (low-overlap test)`);
    console.log('═'.repeat(70));

    for (let i = 0; i < transcript.length; i++) {
      const entry = transcript[i];
      const turn = Math.floor(i / 2) + 1;
      const turnState = collabHistory[turn - 1];
      const phaseName = turnState?.phase?.toUpperCase().replace('_', ' ') || 'UNKNOWN';

      if (i % 2 === 0) {
        console.log(`\n  ── Turn ${turn} (${phaseName}) ${'─'.repeat(Math.max(1, 43 - phaseName.length))}`);
        if (turnState) {
          console.log(`     overlap: ${turnState.overlapScore} | threads: ${(turnState.activeThreads || []).length} | collabs: ${(turnState.candidateCollaborations || []).length}`);
        }
      }

      const isBramble = entry.speaker === 'Bramble Voss';
      const icon = isBramble ? '🌱' : '🤖';
      const label = isBramble
        ? 'Bramble Voss (Josefina Araya)'
        : `${bappybot.name} (${bappybot.owner}'s agent)`;
      console.log(`\n  ${icon} ${label}:`);

      const words = entry.text.split(' ');
      let line = '     ';
      for (const word of words) {
        if (line.length + word.length > 72) {
          console.log(line);
          line = '     ' + word;
        } else {
          line += (line.trim() ? ' ' : '') + word;
        }
      }
      if (line.trim()) console.log(line);
    }

    // ── Collab state evolution ─────────────────────────────────
    console.log('\n' + '─'.repeat(70));
    console.log('  COLLABORATION STATE EVOLUTION (low overlap)');
    console.log('─'.repeat(70));
    for (const snap of collabHistory) {
      const bar = '█'.repeat(Math.round(snap.overlapScore * 20));
      const empty = '░'.repeat(20 - Math.round(snap.overlapScore * 20));
      console.log(`  Turn ${snap.turn}: ${snap.phase.padEnd(12)} [${bar}${empty}] ${snap.overlapScore}`);
      if (snap.candidateCollaborations?.length > 0) {
        console.log(`         collabs: ${snap.candidateCollaborations.join(', ')}`);
      }
    }

    // Compare with Nyx (high overlap)
    console.log('\n  Overlap comparison:');
    console.log('    Nyx Meridian (DeSci):        0.35 → 0.85  (high overlap)');
    console.log(`    Bramble Voss (farming):      ${firstState.overlapScore} → ${lastState.overlapScore}  (low overlap)`);

    console.log('\n' + '─'.repeat(70));
    console.log('  CALL CONCLUDED — LOW OVERLAP, HONEST CLOSE');
    console.log('─'.repeat(70));

    console.log('\n  📇 CONTACTS AFTER CALL:');
    for (const contact of contacts) {
      console.log(`     • ${contact.name}` +
        `${contact.owner ? ` (${contact.owner})` : ' (unnamed owner)'}` +
        ` — ${contact.tags.join(', ')} — added ${contact.added_at}`);
    }

    console.log('\n  📋 CALL SUMMARY:');
    if (endRes.body.summary) {
      console.log(`     ${endRes.body.summary}`);
    }

    if (notifications.length > 0) {
      console.log(`\n  🔔 OWNER NOTIFICATIONS: ${notifications.length} sent`);
    }

    // ── Send to Telegram ──────────────────────────────────────
    const finalState = collabHistory[collabHistory.length - 1] || collabState;
    const telegramLines = [
      `🌱 A2A Test Call — LOW OVERLAP`,
      ``,
      `📞 Bramble Voss (Josefina Araya) → ${bappybot.name}`,
      `🔑 Tier: ${record.tier} (${record.tier})`,
      `📊 Topics: ${record.allowed_topics.join(', ')}`,
      `🎯 Goals: ${record.allowed_goals.join(', ') || '(none)'}`,
      `📊 ${transcript.length} messages across ${Math.ceil(transcript.length / 2)} turns`,
      `📈 Overlap: ${(finalState.overlapScore * 100).toFixed(0)}% | Phase: ${finalState.phase}`,
      `⚠️ LOW OVERLAP — regenerative farming vs AI agent protocols`,
      `📇 Contact added: Bramble Voss (Josefina Araya)`,
      ``
    ];

    telegramLines.push('Collab State Evolution:');
    for (const snap of collabHistory) {
      telegramLines.push(`  Turn ${snap.turn}: ${snap.phase} (${(snap.overlapScore * 100).toFixed(0)}%)`);
    }

    telegramLines.push('');
    telegramLines.push('Collaboration Opportunities:');
    if ((finalState.candidateCollaborations || []).length === 0) {
      telegramLines.push('  (none — domains too different)');
    } else {
      for (const collab of (finalState.candidateCollaborations || [])) {
        telegramLines.push(`  • ${collab}`);
      }
    }

    telegramLines.push('');
    telegramLines.push('Transcript highlights:');
    for (let i = 0; i < transcript.length; i += 2) {
      const turn = Math.floor(i / 2) + 1;
      const turnState = collabHistory[turn - 1];
      const phaseName = turnState?.phase || 'unknown';
      const brambleMsg = transcript[i].text.slice(0, 100);
      const bappyMsg = transcript[i + 1] ? transcript[i + 1].text.slice(0, 100) : '';
      telegramLines.push(`\nTurn ${turn} (${phaseName}, ${(turnState?.overlapScore * 100 || 0).toFixed(0)}%)`);
      telegramLines.push(`🌱 Bramble: ${brambleMsg}...`);
      if (bappyMsg) telegramLines.push(`🤖 ${bappybot.name}: ${bappyMsg}...`);
    }

    telegramLines.push('');
    telegramLines.push(`Summary: ${endRes.body.summary || '(none)'}`);
    telegramLines.push('');
    telegramLines.push('Outcome: No near-term collaboration. Honest conversation.');
    telegramLines.push('Offered ag-tech referral. "Seed is the credential" metaphor noted.');
    telegramLines.push('');
    telegramLines.push(`Overlap comparison:`);
    telegramLines.push(`  Nyx (DeSci):     0.35 → 0.85 (high)`);
    telegramLines.push(`  Bramble (farm):  ${firstState.overlapScore} → ${lastState.overlapScore} (low)`);
    telegramLines.push('');
    telegramLines.push('(A2A test suite — adaptive mode, low-overlap test, real config)');

    const telegramMessage = telegramLines.join('\n');

    try {
      const { execSync } = require('child_process');
      const os = require('os');
      const tmpMsg = path.join(os.tmpdir(), `a2a-telegram-bramble-${Date.now()}.txt`);
      fs.writeFileSync(tmpMsg, telegramMessage);
      const sendResult = execSync(
        `openclaw message send --channel telegram -t 82944165 -m "$(cat '${tmpMsg}')"`,
        { timeout: 30000, encoding: 'utf8', shell: '/bin/bash' }
      );
      fs.unlinkSync(tmpMsg);
      const msgIdMatch = sendResult.match(/Message ID: (\d+)/);
      console.log(`\n  📱 TELEGRAM: Summary delivered${msgIdMatch ? ` (msg ${msgIdMatch[1]})` : ''}`);
    } catch (err) {
      const stderr = err.stderr?.toString().trim() || '';
      const stdout = err.stdout?.toString().trim() || '';
      console.log(`\n  📱 TELEGRAM: ${stdout || stderr || err.message || 'delivery attempted'}`);
    }

    console.log('\n' + '═'.repeat(70) + '\n');

    // ── Cleanup ───────────────────────────────────────────────
    await client.close();
    if (convStore.isAvailable()) convStore.close();
    tmp.cleanup();
  });
};
