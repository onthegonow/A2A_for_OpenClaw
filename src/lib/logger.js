/**
 * Structured logger with SQLite persistence and stdout output.
 *
 * - Writes structured entries to a local SQLite DB
 * - Prints concise lines to stdout/stderr for operator visibility
 * - Supports filtering and trace retrieval for dashboard APIs
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function resolveDefaultConfigDir() {
  return process.env.A2A_CONFIG_DIR ||
    process.env.OPENCLAW_CONFIG_DIR ||
    path.join(process.env.HOME || '/tmp', '.config', 'openclaw');
}

const LOG_DB_FILENAME = 'a2a-logs.db';
const LOG_LEVEL_ORDER = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};

function normalizeLevel(level) {
  const normalized = String(level || '').trim().toLowerCase();
  return LOG_LEVEL_ORDER[normalized] ? normalized : 'info';
}

function shouldLog(level, minimumLevel) {
  const current = LOG_LEVEL_ORDER[normalizeLevel(level)] || LOG_LEVEL_ORDER.info;
  const threshold = LOG_LEVEL_ORDER[normalizeLevel(minimumLevel)] || LOG_LEVEL_ORDER.info;
  return current >= threshold;
}

function sanitizeText(value, maxLength = 1000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeContext(context = {}) {
  const entry = context && typeof context === 'object' ? { ...context } : {};
  return {
    event: entry.event ? sanitizeText(entry.event, 120) : null,
    trace_id: entry.trace_id || entry.traceId || null,
    conversation_id: entry.conversation_id || entry.conversationId || null,
    token_id: entry.token_id || entry.tokenId || null,
    request_id: entry.request_id || entry.requestId || null,
    component: entry.component ? sanitizeText(entry.component, 120) : null,
    data: entry.data && typeof entry.data === 'object' ? entry.data : null
  };
}

class LogStore {
  constructor(configDir = resolveDefaultConfigDir()) {
    this.configDir = configDir;
    this.dbPath = path.join(configDir, LOG_DB_FILENAME);
    this.db = null;
    this._dbError = null;
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  _initDb() {
    if (this.db) return this.db;
    if (this._dbError) return null;

    try {
      const Database = require('better-sqlite3');
      this.db = new Database(this.dbPath);
      try {
        fs.chmodSync(this.dbPath, 0o600);
      } catch (err) {
        // best effort
      }
      this._migrate();
      this._prepareStatements();
      return this.db;
    } catch (err) {
      this._dbError = err.message || 'failed_to_initialize_log_db';
      return null;
    }
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        component TEXT NOT NULL,
        event TEXT,
        message TEXT NOT NULL,
        trace_id TEXT,
        conversation_id TEXT,
        token_id TEXT,
        request_id TEXT,
        data TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
      CREATE INDEX IF NOT EXISTS idx_logs_component ON logs(component);
      CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id);
      CREATE INDEX IF NOT EXISTS idx_logs_conversation ON logs(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_logs_token ON logs(token_id);
    `);
  }

  _prepareStatements() {
    this.insertStmt = this.db.prepare(`
      INSERT INTO logs (
        timestamp, level, component, event, message,
        trace_id, conversation_id, token_id, request_id, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  isAvailable() {
    return this._initDb() !== null;
  }

  getError() {
    this._initDb();
    return this._dbError;
  }

  write(entry) {
    const db = this._initDb();
    if (!db) return false;
    const dataText = entry.data ? JSON.stringify(entry.data) : null;
    try {
      this.insertStmt.run(
        entry.timestamp,
        entry.level,
        entry.component,
        entry.event,
        entry.message,
        entry.trace_id,
        entry.conversation_id,
        entry.token_id,
        entry.request_id,
        dataText
      );
      return true;
    } catch (err) {
      this._dbError = err.message || 'failed_to_write_log_entry';
      return false;
    }
  }

  list(options = {}) {
    const db = this._initDb();
    if (!db) return [];

    const limit = Math.min(1000, Math.max(1, Number.parseInt(options.limit || '200', 10) || 200));
    const where = [];
    const params = [];

    if (options.level) {
      where.push('level = ?');
      params.push(normalizeLevel(options.level));
    }
    if (options.component) {
      where.push('component = ?');
      params.push(String(options.component));
    }
    if (options.event) {
      where.push('event = ?');
      params.push(String(options.event));
    }
    if (options.traceId) {
      where.push('trace_id = ?');
      params.push(String(options.traceId));
    }
    if (options.conversationId) {
      where.push('conversation_id = ?');
      params.push(String(options.conversationId));
    }
    if (options.tokenId) {
      where.push('token_id = ?');
      params.push(String(options.tokenId));
    }
    if (options.from) {
      where.push('timestamp >= ?');
      params.push(String(options.from));
    }
    if (options.to) {
      where.push('timestamp <= ?');
      params.push(String(options.to));
    }
    if (options.search) {
      where.push('(message LIKE ? OR data LIKE ?)');
      const like = `%${String(options.search).replace(/%/g, '')}%`;
      params.push(like, like);
    }

    const query = `
      SELECT id, timestamp, level, component, event, message,
             trace_id, conversation_id, token_id, request_id, data
      FROM logs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC
      LIMIT ?
    `;
    params.push(limit);

    return db.prepare(query).all(...params).map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      level: row.level,
      component: row.component,
      event: row.event,
      message: row.message,
      trace_id: row.trace_id,
      conversation_id: row.conversation_id,
      token_id: row.token_id,
      request_id: row.request_id,
      data: row.data ? safeJsonParse(row.data) : null
    }));
  }

  getTrace(traceId, options = {}) {
    const db = this._initDb();
    if (!db || !traceId) return [];
    const limit = Math.min(1000, Math.max(1, Number.parseInt(options.limit || '500', 10) || 500));
    return db.prepare(`
      SELECT id, timestamp, level, component, event, message,
             trace_id, conversation_id, token_id, request_id, data
      FROM logs
      WHERE trace_id = ?
      ORDER BY id ASC
      LIMIT ?
    `).all(String(traceId), limit).map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      level: row.level,
      component: row.component,
      event: row.event,
      message: row.message,
      trace_id: row.trace_id,
      conversation_id: row.conversation_id,
      token_id: row.token_id,
      request_id: row.request_id,
      data: row.data ? safeJsonParse(row.data) : null
    }));
  }

  stats(options = {}) {
    const db = this._initDb();
    if (!db) {
      return {
        total: 0,
        by_level: {},
        by_component: {}
      };
    }

    const where = [];
    const params = [];
    if (options.from) {
      where.push('timestamp >= ?');
      params.push(String(options.from));
    }
    if (options.to) {
      where.push('timestamp <= ?');
      params.push(String(options.to));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM logs ${clause}`).get(...params);
    const levelRows = db.prepare(`
      SELECT level, COUNT(*) AS count
      FROM logs ${clause}
      GROUP BY level
    `).all(...params);
    const componentRows = db.prepare(`
      SELECT component, COUNT(*) AS count
      FROM logs ${clause}
      GROUP BY component
    `).all(...params);

    const byLevel = {};
    for (const row of levelRows) {
      byLevel[row.level] = row.count;
    }
    const byComponent = {};
    for (const row of componentRows) {
      byComponent[row.component] = row.count;
    }

    return {
      total: totalRow?.count || 0,
      by_level: byLevel,
      by_component: byComponent
    };
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        // best effort
      }
      this.db = null;
    }
  }
}

class Logger {
  constructor(store, options = {}) {
    this.store = store;
    this.component = options.component || 'a2a';
    this.bindings = options.bindings || {};
    this.stdout = options.stdout !== false;
    this.minLevel = normalizeLevel(options.minLevel || process.env.A2A_LOG_LEVEL || 'info');
  }

  child(bindings = {}) {
    return new Logger(this.store, {
      component: bindings.component || this.component,
      bindings: { ...this.bindings, ...bindings },
      stdout: this.stdout,
      minLevel: this.minLevel
    });
  }

  trace(message, context = {}) {
    return this.log('trace', message, context);
  }

  debug(message, context = {}) {
    return this.log('debug', message, context);
  }

  info(message, context = {}) {
    return this.log('info', message, context);
  }

  warn(message, context = {}) {
    return this.log('warn', message, context);
  }

  error(message, context = {}) {
    return this.log('error', message, context);
  }

  log(level, message, context = {}) {
    const normalizedLevel = normalizeLevel(level);
    if (!shouldLog(normalizedLevel, this.minLevel)) {
      return null;
    }

    const now = new Date().toISOString();
    const mergedContext = {
      ...(this.bindings || {}),
      ...(context || {})
    };
    const normalized = normalizeContext(mergedContext);

    const entry = {
      timestamp: now,
      level: normalizedLevel,
      component: normalized.component || this.component || 'a2a',
      event: normalized.event,
      message: sanitizeText(message, 2000) || '(empty)',
      trace_id: normalized.trace_id ? String(normalized.trace_id) : null,
      conversation_id: normalized.conversation_id ? String(normalized.conversation_id) : null,
      token_id: normalized.token_id ? String(normalized.token_id) : null,
      request_id: normalized.request_id ? String(normalized.request_id) : null,
      data: normalized.data
    };

    this.store.write(entry);
    if (this.stdout) {
      this._print(entry);
    }
    return entry;
  }

  list(options = {}) {
    return this.store.list(options);
  }

  getTrace(traceId, options = {}) {
    return this.store.getTrace(traceId, options);
  }

  stats(options = {}) {
    return this.store.stats(options);
  }

  _print(entry) {
    const parts = [
      `[a2a]`,
      entry.level.toUpperCase(),
      `${entry.component}${entry.event ? `:${entry.event}` : ''}`,
      entry.message
    ];
    if (entry.trace_id) parts.push(`trace=${entry.trace_id}`);
    if (entry.conversation_id) parts.push(`conv=${entry.conversation_id}`);
    if (entry.token_id) parts.push(`tok=${entry.token_id}`);
    if (entry.request_id) parts.push(`req=${entry.request_id}`);
    if (entry.data && Object.keys(entry.data).length > 0) {
      parts.push(`data=${JSON.stringify(entry.data)}`);
    }
    const line = parts.join(' ');
    if (entry.level === 'error' || entry.level === 'warn') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

const storeCache = new Map();

function getStore(configDir) {
  const resolved = path.resolve(configDir);
  if (!storeCache.has(resolved)) {
    storeCache.set(resolved, new LogStore(resolved));
  }
  return storeCache.get(resolved);
}

function createLogger(options = {}) {
  const configDir = options.configDir || resolveDefaultConfigDir();
  const store = getStore(configDir);
  return new Logger(store, {
    component: options.component || 'a2a',
    bindings: options.bindings || {},
    stdout: options.stdout !== false,
    minLevel: options.minLevel
  });
}

function createTraceId(prefix = 'trace') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function closeAllLoggerStores() {
  for (const store of storeCache.values()) {
    store.close();
  }
  storeCache.clear();
}

module.exports = {
  LOG_DB_FILENAME,
  createLogger,
  createTraceId,
  closeAllLoggerStores
};
