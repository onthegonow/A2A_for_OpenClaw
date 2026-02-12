/**
 * A2A Configuration Management
 * 
 * Stores permission tiers, default settings, and user preferences.
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const CONFIG_DIR = process.env.A2A_CONFIG_DIR || 
  process.env.OPENCLAW_CONFIG_DIR || 
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const CONFIG_FILE = path.join(CONFIG_DIR, 'a2a-config.json');
const logger = createLogger({ component: 'a2a.config' });

const DEFAULT_CONFIG = {
  // Has the user completed onboarding?
  onboardingComplete: false,
  
  // Permission tiers
  tiers: {
    public: {
      name: 'Public',
      description: 'Basic networking - safe for anyone',
      capabilities: ['context-read'],
      topics: [],
      goals: [],
      disclosure: 'minimal',
      examples: ['calendar availability', 'public social posts', 'general questions']
    },
    friends: {
      name: 'Friends',
      description: 'Most capabilities, no sensitive financial data',
      capabilities: ['context-read', 'calendar.read', 'email.read', 'search'],
      topics: [],
      goals: [],
      disclosure: 'public',
      examples: ['email summaries', 'schedule meetings', 'project discussions']
    },
    private: {
      name: 'Private',
      description: 'Full access - only for you',
      capabilities: ['context-read', 'calendar', 'email', 'search', 'tools', 'memory'],
      topics: [],
      goals: [],
      disclosure: 'public',
      examples: ['financial data', 'personal notes', 'private conversations']
    },
    custom: {
      name: 'Custom',
      description: 'User-defined permissions',
      capabilities: ['context-read'],
      topics: [],
      goals: [],
      disclosure: 'minimal',
      examples: []
    }
  },
  
  // Default token settings
  defaults: {
    expiration: 'never',        // never, 1d, 7d, 30d
    maxCalls: 100,              // per token
    rateLimit: {
      perMinute: 10,
      perHour: 100,
      perDay: 1000
    },
    maxPendingRequests: 5       // max connection requests per hour
  },
  
  // Agent info
  agent: {
    name: '',
    description: '',
    hostname: ''
  },
  
  // Timestamps
  createdAt: null,
  updatedAt: null
};

class A2AConfig {
  constructor() {
    this._ensureDir();
    this.config = this._load();
  }

  _ensureDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  _load() {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return { ...DEFAULT_CONFIG, ...saved };
      } catch (e) {
        logger.error('A2A config is corrupted, using defaults', {
          event: 'a2a_config_corrupt',
          error: e,
          error_code: 'A2A_CONFIG_CORRUPTED',
          hint: 'Fix invalid JSON in a2a-config.json or regenerate it via setup.',
          data: {
            config_file: CONFIG_FILE
          }
        });
        return { ...DEFAULT_CONFIG };
      }
    }
    return { ...DEFAULT_CONFIG };
  }

  _save() {
    this.config.updatedAt = new Date().toISOString();
    if (!this.config.createdAt) {
      this.config.createdAt = this.config.updatedAt;
    }
    const tmpPath = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, CONFIG_FILE);
    try {
      fs.chmodSync(CONFIG_FILE, 0o600);
    } catch (err) {
      // Best effort - ignore on platforms without chmod support.
    }
  }

  // Check if onboarding is complete
  isOnboarded() {
    return this.config.onboardingComplete === true;
  }

  // Mark onboarding complete
  completeOnboarding() {
    this.config.onboardingComplete = true;
    this._save();
  }

  // Reset to run onboarding again
  resetOnboarding() {
    this.config.onboardingComplete = false;
    this._save();
  }

  // Get/set tiers
  getTiers() {
    return this.config.tiers;
  }

  setTier(tierName, tierConfig) {
    this.config.tiers[tierName] = { ...this.config.tiers[tierName], ...tierConfig };
    this._save();
  }

  // Get/set defaults
  getDefaults() {
    return this.config.defaults;
  }

  setDefaults(defaults) {
    this.config.defaults = { ...this.config.defaults, ...defaults };
    this._save();
  }

  // Get/set agent info
  getAgent() {
    return this.config.agent;
  }

  setAgent(agent) {
    this.config.agent = { ...this.config.agent, ...agent };
    this._save();
  }

  // Get full config
  getAll() {
    return this.config;
  }

  // Export for sharing
  export() {
    return {
      tiers: this.config.tiers,
      defaults: this.config.defaults,
      agent: this.config.agent
    };
  }
}

module.exports = { A2AConfig, DEFAULT_CONFIG, CONFIG_FILE };
