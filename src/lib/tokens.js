/**
 * Token management for A2A
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Default config path
const DEFAULT_CONFIG_DIR = process.env.A2A_CONFIG_DIR || 
  process.env.OPENCLAW_CONFIG_DIR || 
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const DB_FILENAME = 'a2a.json';

class TokenStore {
  constructor(configDir = DEFAULT_CONFIG_DIR) {
    this.configDir = configDir;
    this.dbPath = path.join(configDir, DB_FILENAME);
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  _load() {
    if (fs.existsSync(this.dbPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      } catch (e) {
        // Corrupted file - backup and start fresh
        const backupPath = `${this.dbPath}.corrupt.${Date.now()}`;
        fs.renameSync(this.dbPath, backupPath);
        console.error(`[a2a] Corrupted DB backed up to ${backupPath}`);
        return { tokens: [], remotes: [], calls: [] };
      }
    }
    return { tokens: [], remotes: [], calls: [] };
  }

  _save(db) {
    // Atomic write: write to temp file, then rename
    const tmpPath = `${this.dbPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
    fs.renameSync(tmpPath, this.dbPath);
  }

  /**
   * Generate a secure A2A token
   */
  static generateToken() {
    const bytes = crypto.randomBytes(24);
    return 'fed_' + bytes.toString('base64url');
  }

  /**
   * Hash a token for storage
   */
  static hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Parse duration string (1h, 1d, 7d, 30d, never) to milliseconds
   */
  static parseDuration(str) {
    if (!str || str === 'never') return null;
    const match = str.match(/^(\d+)(h|d)$/);
    if (!match) throw new Error(`Invalid duration: ${str}`);
    const [, num, unit] = match;
    return unit === 'h' 
      ? parseInt(num) * 60 * 60 * 1000 
      : parseInt(num) * 24 * 60 * 60 * 1000;
  }

  /**
   * Create a new A2A token
   * 
   * Default limits (anti-abuse):
   * - Expires in 1 day
   * - Max 100 calls total
   * - Rate limited: 10/min, 100/hr, 1000/day (enforced server-side)
   * - Timeout: 5-300 seconds (enforced server-side)
   */
  create(options = {}) {
    const {
      name = 'unnamed',
      owner = null,
      expires = '1d',
      permissions = 'public',
      disclosure = 'minimal',
      notify = 'all',
      maxCalls = 100,  // Default limit, not unlimited
      capabilities = null,  // Array of capability strings, snapshotted at creation
      // Snapshot of actual capabilities at creation time
      allowedTopics = null,  // Array of topic strings, e.g. ['chat', 'calendar.read']
      allowedGoals = null,   // Array of goal strings, e.g. ['grow-network', 'find-collaborators']
      tierSettings = null    // Object with tier-specific settings
    } = options;

    // Map legacy tier values to labels
    const tier = TokenStore.LEGACY_TIER_MAP[permissions] || permissions;

    const token = TokenStore.generateToken();
    const tokenHash = TokenStore.hashToken(token);
    const durationMs = TokenStore.parseDuration(expires);
    const expiresAt = durationMs ? new Date(Date.now() + durationMs).toISOString() : null;

    // Load tier definitions from config (if available)
    let configTiers = {};
    try {
      const configPath = path.join(this.configDir, 'a2a-config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.tiers) {
          configTiers = config.tiers;
        }
      }
    } catch (e) {
      // Config not available, use defaults
    }

    // Default topics based on tier label (snapshot at creation)
    // User config overrides these defaults
    const defaultTopics = {
      'public': configTiers.public?.topics || ['chat'],
      'friends': configTiers.friends?.topics || ['chat', 'calendar.read', 'email.read', 'search'],
      'family': configTiers.family?.topics || ['chat', 'calendar', 'email', 'search', 'tools']
    };

    // Default goals based on tier label (snapshot at creation)
    const defaultGoals = {
      'public': configTiers.public?.goals || [],
      'friends': configTiers.friends?.goals || [],
      'family': configTiers.family?.goals || []
    };

    // Resolve capabilities: explicit > config > defaults
    const defaultCapabilities = (configTiers[tier]?.capabilities?.length)
      ? configTiers[tier].capabilities
      : (TokenStore.DEFAULT_CAPABILITIES[tier] || ['context-read']);

    // Use separate random ID (not derived from token) to prevent prefix attacks
    const record = {
      id: 'tok_' + crypto.randomBytes(8).toString('hex'),
      token_hash: tokenHash,
      name,
      owner,
      tier,
      capabilities: capabilities || defaultCapabilities,
      allowed_topics: allowedTopics || defaultTopics[tier] || ['chat'],
      allowed_goals: allowedGoals || defaultGoals[tier] || [],
      tier_settings: tierSettings || {},  // Snapshot of settings at creation
      disclosure,
      notify,
      max_calls: maxCalls,
      calls_made: 0,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      revoked: false
    };

    const db = this._load();
    db.tokens.push(record);
    this._save(db);

    return { token, record };
  }

  /**
   * List all tokens (optionally including revoked)
   */
  list(includeRevoked = false) {
    const db = this._load();
    return includeRevoked ? db.tokens : db.tokens.filter(t => !t.revoked);
  }

  /**
   * Find a token by ID prefix
   */
  findById(idPrefix) {
    const db = this._load();
    return db.tokens.find(t => t.id === idPrefix || t.id.startsWith(idPrefix));
  }

  /**
   * Validate an incoming token, returns validation result
   */
  validate(token) {
    const db = this._load();
    const tokenHash = TokenStore.hashToken(token);
    const record = db.tokens.find(t => t.token_hash === tokenHash);

    if (!record) {
      return { valid: false, error: 'token_not_found' };
    }

    if (record.revoked) {
      return { valid: false, error: 'token_revoked' };
    }

    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      return { valid: false, error: 'token_expired' };
    }

    if (record.max_calls && record.calls_made >= record.max_calls) {
      return { valid: false, error: 'max_calls_exceeded' };
    }

    // Increment call count
    record.calls_made++;
    record.last_used = new Date().toISOString();
    this._save(db);

    // Map legacy tier values to labels for old records
    const tier = TokenStore.LEGACY_TIER_MAP[record.tier] || record.tier || record.permissions || 'public';

    // Resolve capabilities: stored > defaults
    const capabilities = record.capabilities
      || TokenStore.DEFAULT_CAPABILITIES[tier]
      || ['context-read'];

    return {
      valid: true,
      id: record.id,
      name: record.name,
      tier,
      capabilities,
      allowed_topics: record.allowed_topics || ['chat'],
      allowed_goals: record.allowed_goals || [],
      tier_settings: record.tier_settings || {},
      disclosure: record.disclosure,
      notify: record.notify,
      calls_remaining: record.max_calls ? record.max_calls - record.calls_made : null
    };
  }

  /**
   * Revoke a token by ID
   */
  revoke(idPrefix) {
    const db = this._load();
    const record = db.tokens.find(t => t.id === idPrefix || t.id.startsWith(idPrefix));
    
    if (!record) {
      return { success: false, error: 'not_found' };
    }

    record.revoked = true;
    record.revoked_at = new Date().toISOString();
    this._save(db);

    return { success: true, record };
  }

  /**
   * Add a remote agent endpoint (contact)
   * Note: Token is encrypted at rest using a derived key
   * 
   * @param {string} inviteUrl - a2a://host/token format
   * @param {object} options - Contact metadata
   * @param {string} options.name - Agent name
   * @param {string} options.owner - Human owner name
   * @param {string} options.notes - Freeform notes
   * @param {string[]} options.tags - Grouping tags
   * @param {string} options.trust - Trust level (trusted, verified, unknown)
   */
  addRemote(inviteUrl, options = {}) {
    // Handle legacy signature: addRemote(url, name)
    if (typeof options === 'string') {
      options = { name: options };
    }

    const match = inviteUrl.match(/^(?:a2a|oclaw):\/\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid invite URL: ${inviteUrl}. Expected format: a2a://host/token`);
    }

    const [, host, token] = match;
    const remoteName = options.name || host;

    const db = this._load();
    
    // Check for duplicate by host + token hash
    const tokenHash = TokenStore.hashToken(token);
    const existing = db.remotes.find(r => r.host === host && r.token_hash === tokenHash);
    if (existing) {
      return { success: false, error: 'duplicate', existing };
    }

    // Encrypt token for storage (simple XOR with derived key - not production-grade but better than plaintext)
    const encryptionKey = crypto.createHash('sha256').update(this.dbPath + 'remote-key').digest();
    const tokenBuffer = Buffer.from(token, 'utf8');
    const encrypted = Buffer.alloc(tokenBuffer.length);
    for (let i = 0; i < tokenBuffer.length; i++) {
      encrypted[i] = tokenBuffer[i] ^ encryptionKey[i % encryptionKey.length];
    }

    const remote = {
      id: crypto.randomBytes(8).toString('hex'),
      name: remoteName,
      owner: options.owner || null,
      host,
      token_hash: tokenHash,
      token_enc: encrypted.toString('base64'),
      notes: options.notes || null,
      tags: options.tags || [],
      linked_token_id: options.linkedTokenId || null,  // Token you gave them
      status: 'unknown',
      last_seen: null,
      added_at: new Date().toISOString()
    };

    db.remotes.push(remote);
    this._save(db);

    return { success: true, remote: { ...remote, token: undefined, token_enc: undefined } };
  }

  /**
   * Decrypt a remote token
   */
  _decryptRemoteToken(remote) {
    if (remote.token) return remote.token; // Legacy plaintext
    if (!remote.token_enc) return null;
    
    const encryptionKey = crypto.createHash('sha256').update(this.dbPath + 'remote-key').digest();
    const encrypted = Buffer.from(remote.token_enc, 'base64');
    const decrypted = Buffer.alloc(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      decrypted[i] = encrypted[i] ^ encryptionKey[i % encryptionKey.length];
    }
    return decrypted.toString('utf8');
  }

  /**
   * List remote agents with linked token info
   */
  listRemotes() {
    const db = this._load();
    return db.remotes.map(r => {
      if (r.linked_token_id) {
        const token = db.tokens.find(t => t.id === r.linked_token_id);
        if (token) {
          return { ...r, linked_token: token };
        }
      }
      return r;
    });
  }

  /**
   * Link a token to a contact
   */
  linkTokenToContact(contactNameOrId, tokenId) {
    const db = this._load();
    const remote = db.remotes.find(r => 
      r.name === contactNameOrId || r.id === contactNameOrId
    );
    const token = db.tokens.find(t => 
      t.id === tokenId || t.id.startsWith(tokenId)
    );

    if (!remote) return { success: false, error: 'contact_not_found' };
    if (!token) return { success: false, error: 'token_not_found' };

    remote.linked_token_id = token.id;
    this._save(db);
    return { success: true, remote, token };
  }

  /**
   * Get a remote by name or host (with decrypted token)
   */
  getRemote(nameOrHost) {
    const db = this._load();
    const remote = db.remotes.find(r => 
      r.name === nameOrHost || 
      r.host === nameOrHost ||
      r.id === nameOrHost
    );
    if (!remote) return null;
    
    // Return with decrypted token
    return {
      ...remote,
      token: this._decryptRemoteToken(remote),
      token_enc: undefined
    };
  }

  /**
   * Update a remote agent's metadata
   */
  updateRemote(nameOrHost, updates) {
    const db = this._load();
    const remote = db.remotes.find(r => 
      r.name === nameOrHost || 
      r.host === nameOrHost ||
      r.id === nameOrHost
    );
    
    if (!remote) {
      return { success: false, error: 'not_found' };
    }

    // Only allow updating specific fields
    const allowed = ['name', 'owner', 'notes', 'tags', 'linked_token_id'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        remote[key] = updates[key];
      }
    }
    remote.updated_at = new Date().toISOString();

    this._save(db);
    return { success: true, remote };
  }

  /**
   * Update contact status after ping/call
   */
  updateRemoteStatus(nameOrHost, status, error = null) {
    const db = this._load();
    const remote = db.remotes.find(r => 
      r.name === nameOrHost || 
      r.host === nameOrHost ||
      r.id === nameOrHost
    );
    
    if (!remote) return;

    remote.status = status; // 'online', 'offline', 'error'
    remote.last_seen = status === 'online' ? new Date().toISOString() : remote.last_seen;
    remote.last_error = error;
    remote.last_check = new Date().toISOString();
    
    this._save(db);
  }

  /**
   * Remove a remote agent
   */
  removeRemote(nameOrHost) {
    const db = this._load();
    const idx = db.remotes.findIndex(r => 
      r.name === nameOrHost || 
      r.host === nameOrHost ||
      r.id === nameOrHost
    );
    
    if (idx === -1) {
      return { success: false, error: 'not_found' };
    }

    const [removed] = db.remotes.splice(idx, 1);
    this._save(db);
    return { success: true, remote: removed };
  }
}

// Legacy tier values from old records → label mapping
TokenStore.LEGACY_TIER_MAP = {
  'chat-only': 'public',
  'tools-read': 'friends',
  'tools-write': 'family'
};

// Default capabilities per tier label (used when config has none)
TokenStore.DEFAULT_CAPABILITIES = {
  'public': ['context-read'],
  'friends': ['context-read', 'calendar.read', 'email.read', 'search'],
  'family': ['context-read', 'calendar', 'email', 'search', 'tools', 'memory']
};

module.exports = { TokenStore };
