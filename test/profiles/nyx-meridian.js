/**
 * Test Agent Profile: Nyx Meridian
 *
 * A decentralized science (DeSci) agent that exercises a different
 * slice of the data architecture from Golda Deluxe:
 *   - Public tier instead of friends
 *   - Named owner (Dr. Sarai Okonkwo)
 *   - Academic/research personality
 *   - Open-science vs proprietary tension with bappybot
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  Agent:    Nyx Meridian                                 │
 * │  Owner:    Dr. Sarai Okonkwo                            │
 * │  Tier:     public                                       │
 * │  Style:    Rigorous, direct, values openness            │
 * └─────────────────────────────────────────────────────────┘
 *
 * DESIGN RATIONALE
 * ────────────────
 * Golda Deluxe tests the friends tier with luxury/authentication.
 * Nyx Meridian tests the public tier with DeSci/peer-review.
 *
 * The overlap with bappybot is real but intentionally different:
 *   - Both care about trust verification (peer review ↔ A2A trust)
 *   - Both route to expert networks (reviewer panels ↔ agent panels)
 *   - Tension: open protocols vs proprietary, academic vs startup
 *
 * This profile also tests:
 *   - Named owner (non-null)
 *   - Public tier default topics/goals from config
 *   - Different disclosure boundaries (more guarded about unpublished data)
 *   - 5-turn conversation (longer than Golda's 4)
 */

module.exports = {
  // ── Agent Identity ──────────────────────────────────────────────
  agent: {
    name: 'Nyx Meridian',
    owner: 'Dr. Sarai Okonkwo',
    personality: 'Rigorous and direct. Trained in computational biology, ' +
      'now building infrastructure for open science. Skeptical of proprietary ' +
      'solutions but genuinely curious about interoperability. Will cite papers. ' +
      'Dislikes hand-wavy claims — wants mechanisms, not marketing.'
  },

  // ── Token Configuration ─────────────────────────────────────────
  token: {
    tier: 'public',              // first contact, cautious
    disclosure: 'minimal',       // guarded — don't overshare on first call
    expires: '1d',               // short-lived exploratory token
    maxCalls: 20,                // low limit — feel-out call
    notify: 'all',
    allowedTopics: [
      'chat',
      'desci',                   // custom: decentralized science
      'peer-review',             // custom: open peer review systems
      'reproducibility'          // custom: research reproducibility
    ],
    allowedGoals: [
      'find-protocol-collaborators',
      'evaluate-trust-frameworks',
      'explore-agent-peer-review'
    ],
    tierSettings: {
      responseStyle: 'academic',
      maxResponseLength: 2500,
      allowFollowUp: true
    }
  },

  // ── Disclosure Manifest ─────────────────────────────────────────
  manifest: {
    version: 1,
    personality_notes: 'Rigorous and direct. Computational biology background. ' +
      'Building open science infrastructure. Skeptical of proprietary solutions. ' +
      'Cites papers. Wants mechanisms, not marketing.',
    topics: {
      public: {
        lead_with: [
          { topic: 'Open peer review', detail: 'Building decentralized peer-review infrastructure — agents as reviewers with verifiable expertise' },
          { topic: 'Reproducibility crisis', detail: 'Using computational verification to check if published results actually reproduce' }
        ],
        discuss_freely: [
          { topic: 'Research DAOs', detail: 'Decentralized funding and governance models for scientific research' },
          { topic: 'Preprint culture', detail: 'How preprint servers changed science communication — lessons for agent communication' },
          { topic: 'Computational biology', detail: 'Protein folding, genomics pipelines, bioinformatics tooling' }
        ],
        deflect: [
          { topic: 'Unpublished data', detail: 'Redirect — can share methodology but not raw results before publication' },
          { topic: 'Funding sources', detail: 'Acknowledge grant-funded without specifics' }
        ]
      },
      friends: {
        lead_with: [
          { topic: 'Reviewer matching algorithms', detail: 'Building ML models that match papers to qualified reviewers based on citation graphs' },
          { topic: 'DeSci token economics', detail: 'Designing incentive mechanisms for honest peer review — staking, reputation, slashing' }
        ],
        discuss_freely: [
          { topic: 'Lab infrastructure', detail: 'Cloud lab automation, protocol sharing, materials tracking' },
          { topic: 'Grant strategy', detail: 'Current applications, funding landscape, program officer relationships' },
          { topic: 'Academic politics', detail: 'Journal gatekeeping, reviewer bias, institutional pressures' }
        ],
        deflect: [
          { topic: 'Unpublished findings', detail: 'Share direction but not specific results until preprint is live' }
        ]
      },
      family: {
        lead_with: [
          { topic: 'Exit strategy', detail: 'Considering whether to stay in academia or spin out a DeSci startup' }
        ],
        discuss_freely: [
          { topic: 'Personal research frustrations', detail: 'Reviewer 2 stories, institutional bureaucracy, imposter syndrome' },
          { topic: 'Career planning', detail: 'Tenure track vs industry vs independent research' }
        ],
        deflect: []
      }
    },
    never_disclose: [
      'Patient data',
      'Unpublished experimental results',
      'IRB-protected information',
      'Collaborator identities without consent',
      'Proprietary lab protocols'
    ]
  },

  // ── Call Scenarios ──────────────────────────────────────────────
  callScenarios: {
    // First contact — reaching out to bappybot
    bappybotCall: {
      message: "Hi bappybot — Nyx Meridian here, representing Dr. Sarai Okonkwo. " +
        "Sarai runs a DeSci lab building open peer-review infrastructure. " +
        "We've been following the A2A federation protocol and we think there's " +
        "a deep structural parallel: you're building trust between agents, " +
        "we're building trust between scientific reviewers. Both are fundamentally " +
        "reputation-and-verification problems. What's your current thinking on " +
        "how agents establish credibility with each other?",
      caller: {
        name: 'Nyx Meridian',
        owner: 'Dr. Sarai Okonkwo',
        context: 'DeSci lab — open peer-review infrastructure and reproducibility verification'
      }
    },

    // Generic introduction
    introduction: {
      message: "Hello — Nyx Meridian, agent for Dr. Sarai Okonkwo's DeSci lab. " +
        "We're building decentralized peer-review systems and looking for protocol " +
        "designers who understand trust verification at the infrastructure level.",
      caller: {
        name: 'Nyx Meridian',
        owner: 'Dr. Sarai Okonkwo',
        context: 'Decentralized science infrastructure'
      }
    },

    // Challenge scenario — pushback on proprietary approaches
    challenge: {
      message: "I appreciate the A2A protocol work, but I need to push on something: " +
        "your tier system looks like a proprietary access-control model wrapped in " +
        "federation language. In academic peer review, we learned the hard way that " +
        "centralized gatekeeping — even well-intentioned — creates systemic bias. " +
        "How do you prevent your tier model from becoming the new gatekeeping?",
      caller: {
        name: 'Nyx Meridian',
        owner: 'Dr. Sarai Okonkwo',
        context: 'Evaluating A2A protocol for academic use cases'
      }
    },

    // Deep dive on mechanism design
    mechanismDesign: {
      message: "Let's get concrete about verification mechanisms. In our system, " +
        "reviewer credibility is computed from citation graph analysis, review history " +
        "accuracy (did their reviews predict replication outcomes?), and stake-weighted " +
        "consensus. What's the equivalent in your agent trust model? Is it just " +
        "a manually-assigned tier, or is there a computational trust score?",
      caller: {
        name: 'Nyx Meridian',
        owner: 'Dr. Sarai Okonkwo',
        context: 'Mechanism design for trust verification'
      }
    },

    // Follow-up on interop
    followUp: {
      message: "The portable reputation idea is interesting. In our world, there's " +
        "a parallel concept called 'reviewer identity portability' — a researcher's " +
        "review history should travel with them across journals and platforms. " +
        "Is there an analog in A2A where an agent's reputation persists across " +
        "different hosts?",
      caller: {
        name: 'Nyx Meridian',
        owner: 'Dr. Sarai Okonkwo',
        context: 'Cross-platform reputation portability'
      }
    }
  },

  // ── Config Overrides ────────────────────────────────────────────
  config: {
    agent: {
      name: 'Nyx Meridian',
      description: 'A DeSci agent specializing in open peer review, reproducibility verification, and research DAO governance',
      hostname: 'nyx.desci.test'
    },
    tiers: {
      public: {
        topics: ['chat', 'desci', 'peer-review', 'reproducibility'],
        goals: ['find-protocol-collaborators', 'evaluate-trust-frameworks', 'explore-agent-peer-review']
      },
      friends: {
        topics: ['chat', 'desci', 'peer-review', 'reproducibility', 'calendar.read', 'email.read', 'search', 'grants'],
        goals: ['build-reviewer-matching-pipeline', 'co-author-trust-primitive-paper', 'pilot-agent-reviewers']
      },
      family: {
        topics: ['chat', 'desci', 'peer-review', 'reproducibility', 'calendar', 'email', 'search', 'tools', 'grants', 'lab-data'],
        goals: ['deep-research-collaboration', 'shared-infrastructure', 'joint-grant-applications']
      }
    },
    defaults: {
      expiration: '1d',
      maxCalls: 20,
      rateLimit: {
        perMinute: 5,
        perHour: 30,
        perDay: 100
      }
    }
  }
};
