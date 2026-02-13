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

function deepMerge(base, override) {
  const baseIsObject = base && typeof base === 'object' && !Array.isArray(base);
  const overrideIsObject = override && typeof override === 'object' && !Array.isArray(override);
  if (!overrideIsObject) {
    return override === undefined ? base : override;
  }
  const out = baseIsObject ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    const baseValue = baseIsObject ? base[key] : undefined;
    const bothObjects = baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue) &&
      value && typeof value === 'object' && !Array.isArray(value);
    out[key] = bothObjects ? deepMerge(baseValue, value) : value;
  }
  return out;
}

const DEFAULT_CONFIG = {
  onboarding: {
    version: 2,
    step: 'not_started', // not_started|tiers|ingress|verify|complete
    tiers_confirmed: false,
    ingress_confirmed: false,
    verify_confirmed: false,
    last_run_at: null
  },
  
  // Permission tiers
  tiers: {
    public: {
      name: 'Public',
      description: 'Basic networking - safe for anyone',
      capabilities: ['context-read'],
      topics: ['chat'],
      goals: [],
      disclosure: 'minimal',
      examples: ['calendar availability', 'public social posts', 'general questions']
    },
    friends: {
      name: 'Friends',
      description: 'Most capabilities, no sensitive financial data',
      capabilities: ['context-read', 'calendar.read', 'email.read', 'search'],
      topics: ['chat', 'search', 'openclaw', 'a2a'],
      goals: [],
      disclosure: 'public',
      examples: ['email summaries', 'schedule meetings', 'project discussions']
    },
    family: {
      name: 'Family',
      description: 'Full access - only for your inner circle',
      capabilities: ['context-read', 'calendar', 'email', 'search', 'tools', 'memory'],
      topics: ['chat', 'search', 'openclaw', 'a2a', 'tools', 'memory'],
      goals: [],
      disclosure: 'public',
      examples: ['deep collaboration', 'private project context', 'personal notes']
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
        return deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), saved);
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
        return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      }
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
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
    return this.config.onboarding &&
      this.config.onboarding.version === 2 &&
      this.config.onboarding.step === 'complete';
  }

  // Mark onboarding complete
  completeOnboarding() {
    this.config.onboarding = this.config.onboarding || {};
    this.config.onboarding.version = 2;
    this.config.onboarding.step = 'complete';
    this.config.onboarding.tiers_confirmed = true;
    this.config.onboarding.ingress_confirmed = true;
    this.config.onboarding.verify_confirmed = true;
    this.config.onboarding.last_run_at = new Date().toISOString();
    this._save();
  }

  // Reset to run onboarding again
  resetOnboarding() {
    this.config.onboarding = this.config.onboarding || {};
    this.config.onboarding.version = 2;
    this.config.onboarding.step = 'not_started';
    this.config.onboarding.tiers_confirmed = false;
    this.config.onboarding.ingress_confirmed = false;
    this.config.onboarding.verify_confirmed = false;
    this.config.onboarding.last_run_at = new Date().toISOString();
    this._save();
  }

  getOnboarding() {
    const ob = (this.config && this.config.onboarding && typeof this.config.onboarding === 'object')
      ? this.config.onboarding
      : {};
    return deepMerge(DEFAULT_CONFIG.onboarding, ob);
  }

  setOnboarding(patch = {}) {
    const current = this.getOnboarding();
    const merged = deepMerge(current, patch);
    merged.version = 2;
    merged.last_run_at = new Date().toISOString();
    this.config.onboarding = merged;
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
