'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');
const Database = require('better-sqlite3');
const { A2AClient, TokenStore } = require('a2acalling');

const repoDir = process.argv[2] || '/workspace/a2acalling';
const serverScript = require.resolve('a2acalling/src/server.js');

const children = [];
const tunnelPids = [];

function log(message, data) {
  if (data) {
    console.log(`[internet] ${message}`, data);
    return;
  }
  console.log(`[internet] ${message}`);
}

function attachOutput(prefix, stream) {
  stream.on('data', (chunk) => {
    const text = String(chunk || '');
    for (const line of text.split('\n')) {
      if (line.trim()) {
        console.log(`[${prefix}] ${line}`);
      }
    }
  });
}

function startServer(options) {
  const env = {
    ...process.env,
    A2A_RUNTIME: 'generic',
    A2A_RUNTIME_FAILOVER: 'true',
    A2A_DISABLE_QUICK_TUNNEL: 'true',
    A2A_CONFIG_DIR: options.configDir,
    A2A_HOSTNAME: options.hostname,
    A2A_PORT: String(options.port),
    A2A_AGENT_NAME: options.agentName,
    A2A_OWNER_NAME: options.ownerName,
    A2A_LOG_LEVEL: 'debug',
    NODE_ENV: 'test',
    ...(options.extraEnv || {})
  };

  const child = spawn(process.execPath, [serverScript, String(options.port)], {
    env,
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  attachOutput(options.name, child.stdout);
  attachOutput(options.name, child.stderr);

  child.on('exit', (code, signal) => {
    log(`${options.name} exited`, { code, signal });
  });

  children.push(child);
  return child;
}

function stopServer(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // best effort
      }
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function stopAllServers() {
  for (const child of children.splice(0, children.length)) {
    await stopServer(child);
  }
}

function killPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // best effort
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((err) => {
        if (err) return reject(err);
        resolve(port);
      });
    });
  });
}

function describeFetchError(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.name) parts.push(`name=${err.name}`);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.message) parts.push(`message=${err.message}`);
  const cause = err.cause;
  if (cause && typeof cause === 'object') {
    if (cause.code) parts.push(`cause_code=${cause.code}`);
    if (cause.errno) parts.push(`cause_errno=${cause.errno}`);
    if (cause.syscall) parts.push(`cause_syscall=${cause.syscall}`);
    if (cause.address) parts.push(`cause_addr=${cause.address}`);
    if (cause.port) parts.push(`cause_port=${cause.port}`);
    if (cause.message) parts.push(`cause_msg=${cause.message}`);
  }
  return parts.length ? parts.join(' ') : String(err);
}

async function waitForHttpOk(url, timeoutMs = 180000) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) {
        return;
      }
      lastError = new Error(`status=${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for ${url}: ${describeFetchError(lastError)}`);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const bodyText = await res.text();
  let json = null;

  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch (err) {
    throw new Error(`Invalid JSON from ${url}: ${bodyText}`);
  }

  return { res, json };
}

function writeSubagentBridgeScript(scriptPath) {
  const source = `'use strict';

const fs = require('fs');

function parseInvite(inviteUrl) {
  const match = String(inviteUrl || '').match(/^a2a:\\/\\/([^/]+)\\/(.+)$/);
  if (!match) {
    throw new Error('Invalid A2A_SUBAGENT_INVITE');
  }
  return { host: match[1], token: match[2] };
}

function resolveHttpParts(host) {
  const isLocalhost = host === 'localhost' || host.startsWith('localhost:') || host.startsWith('127.');
  const hasExplicitPort = host.includes(':');
  const port = hasExplicitPort ? Number.parseInt(host.split(':')[1], 10) : (isLocalhost ? 80 : 443);
  const protocol = isLocalhost || (hasExplicitPort && port !== 443) ? 'http' : 'https';
  const hostname = host.split(':')[0];
  return { protocol, hostname, port };
}

async function invokeSubagent(inviteUrl, payload) {
  const { host, token } = parseInvite(inviteUrl);
  const { protocol, hostname, port } = resolveHttpParts(host);
  const traceId = payload?.context?.traceId || payload?.context?.trace_id || '';
  const url = \`\${protocol}://\${hostname}:\${port}/api/a2a/invoke\`;

  const body = {
    message: payload?.message || 'No message provided',
    caller: {
      name: payload?.context?.callerName || 'internet-agent-b',
      owner: payload?.context?.callerOwner || 'Internet Owner B',
      instance: 'internet-subagent-bridge'
    }
  };

  const headers = {
    Authorization: \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  };
  if (traceId) {
    headers['x-trace-id'] = traceId;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(\`Subagent returned non-JSON response: \${text}\`);
  }

  if (!res.ok || !json.success) {
    throw new Error(\`Subagent invoke failed status=\${res.status} body=\${text}\`);
  }

  const snippet = String(json.response || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  return {
    subConversationId: json.conversation_id || null,
    snippet
  };
}

async function main() {
  const invite = process.env.A2A_SUBAGENT_INVITE || '';
  if (!invite) {
    throw new Error('A2A_SUBAGENT_INVITE env not set');
  }

  const raw = fs.readFileSync(0, 'utf8');
  const payload = raw ? JSON.parse(raw) : {};
  const result = await invokeSubagent(invite, payload);

  process.stdout.write(
    \`SUBAGENT_OK sub_conv=\${result.subConversationId || 'none'} text=\${result.snippet || 'none'}\`
  );
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(\`subagent bridge failed: \${message}\\n\`);
  process.exit(1);
});
`;

  fs.writeFileSync(scriptPath, source, { mode: 0o755 });
}

async function main() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-internet-lane-'));
  const agentBConfig = path.join(runDir, 'agent-b-config');
  const agentCConfig = path.join(runDir, 'agent-c-config');
  const tunnelConfig = path.join(runDir, 'tunnel-config');

  fs.mkdirSync(agentBConfig, { recursive: true });
  fs.mkdirSync(agentCConfig, { recursive: true });
  fs.mkdirSync(tunnelConfig, { recursive: true });

  const portB = await getFreePort();
  const portC = await getFreePort();

  // Prepare C token for B->C.
  const tokenStoreC = new TokenStore(agentCConfig);
  const { token: tokenForBtoC } = tokenStoreC.create({
    name: 'internet-agent-b-access',
    permissions: 'friends',
    expires: '1d',
    disclosure: 'minimal'
  });

  // Start C first.
  log('Starting subagent (agent-c)', { portC, runDir });
  startServer({
    name: 'agent-c',
    port: portC,
    hostname: `127.0.0.1:${portC}`,
    configDir: agentCConfig,
    agentName: 'internet-agent-c',
    ownerName: 'Internet Owner C'
  });

  await waitForHttpOk(`http://127.0.0.1:${portC}/api/a2a/ping`);

  // Boot quick tunnels.
  process.env.A2A_CONFIG_DIR = tunnelConfig;
  const { ensureCloudflaredBinary, ensureQuickTunnel } = require('a2acalling/src/lib/quick-tunnel');

  log('Ensuring cloudflared binary (may download)');
  const binary = await ensureCloudflaredBinary();

  log('Starting quick tunnel for agent-c');
  const tunnelC = await ensureQuickTunnel({ localPort: portC, binaryPath: binary.path, timeoutMs: 30000 });
  assert.ok(tunnelC && tunnelC.host, 'agent-c tunnel must provide host');

  const inviteToC = `a2a://${tunnelC.host}/${tokenForBtoC}`;

  // Prepare bridge script and wrapper to inject invite.
  const bridgeScript = path.join(runDir, 'subagent-bridge.js');
  writeSubagentBridgeScript(bridgeScript);

  const bridgeWrapper = path.join(runDir, 'subagent-bridge-wrapper.sh');
  fs.writeFileSync(
    bridgeWrapper,
    `#!/usr/bin/env bash\nexport A2A_SUBAGENT_INVITE=${inviteToC}\nexec node ${bridgeScript}\n`,
    { mode: 0o755 }
  );

  // Prepare B token for A->B.
  const tokenStoreB = new TokenStore(agentBConfig);
  const { token: tokenForAtoB } = tokenStoreB.create({
    name: 'internet-agent-a-access',
    permissions: 'friends',
    expires: '1d',
    disclosure: 'minimal'
  });

  log('Starting router (agent-b) with subagent bridge', { portB });
  startServer({
    name: 'agent-b',
    port: portB,
    hostname: `127.0.0.1:${portB}`,
    configDir: agentBConfig,
    agentName: 'internet-agent-b',
    ownerName: 'Internet Owner B',
    extraEnv: {
      A2A_AGENT_COMMAND: bridgeWrapper
    }
  });

  await waitForHttpOk(`http://127.0.0.1:${portB}/api/a2a/ping`);

  log('Starting quick tunnel for agent-b');
  const tunnelB = await ensureQuickTunnel({ localPort: portB, binaryPath: binary.path, timeoutMs: 30000 });
  assert.ok(tunnelB && tunnelB.host, 'agent-b tunnel must provide host');

  tunnelPids.push(tunnelB.pid, tunnelC.pid);

  // Verify tunnels work end-to-end.
  await waitForHttpOk(`https://${tunnelB.host}/api/a2a/ping`);
  await waitForHttpOk(`https://${tunnelC.host}/api/a2a/ping`);

  const inviteToB = `a2a://${tunnelB.host}/${tokenForAtoB}`;

  const clientA = new A2AClient({
    timeout: 25000,
    caller: {
      name: 'internet-agent-a',
      owner: 'Internet Owner A',
      instance: 'internet-lane'
    }
  });

  log('Running invoke -> continue -> end (A->B via tunnel, B->C via tunnel)');
  const first = await clientA.call(inviteToB, 'Hello from internet lane. Please respond with one collaboration idea.');
  assert.strictEqual(first.success, true, 'first call should succeed');
  assert.ok(first.conversation_id, 'first call should return conversation_id');
  assert.ok(
    typeof first.response === 'string' && first.response.includes('SUBAGENT_OK'),
    'first response should come from subagent bridge'
  );

  const conversationId = first.conversation_id;

  const second = await clientA.call(
    inviteToB,
    'Follow-up: summarize in one line what we agreed to do next.',
    { conversationId }
  );
  assert.strictEqual(second.success, true, 'second call should succeed');
  assert.strictEqual(second.conversation_id, conversationId, 'conversation_id should stay stable');
  assert.ok(
    typeof second.response === 'string' && second.response.includes('SUBAGENT_OK'),
    'second response should come from subagent bridge'
  );

  const ended = await clientA.end(inviteToB, conversationId);
  assert.strictEqual(ended.success, true, 'end should succeed');

  log('Injecting invalid-token failure path (internet ingress)');
  const invalidInvoke = await fetch(`https://${tunnelB.host}/api/a2a/invoke`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer fed_invalid_internet_token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: 'this should fail' })
  });
  assert.strictEqual(invalidInvoke.status, 401, 'invalid token invoke should return 401');

  log('Asserting dashboard log APIs (local access)');
  const logsByConv = await fetchJson(
    `http://127.0.0.1:${portB}/api/a2a/dashboard/logs?conversation_id=${encodeURIComponent(conversationId)}&limit=250`
  );
  assert.strictEqual(logsByConv.res.status, 200, 'logs by conversation should return 200');
  assert.ok(logsByConv.json && logsByConv.json.success, 'logs by conversation should return success=true');
  assert.ok(Array.isArray(logsByConv.json.logs), 'logs payload should contain logs array');
  assert.ok(logsByConv.json.logs.length > 0, 'logs array should not be empty');

  const traceLog = logsByConv.json.logs.find((entry) => entry.trace_id);
  assert.ok(traceLog, 'at least one log entry should include trace_id');
  const traceId = traceLog.trace_id;

  const logsByTrace = await fetchJson(
    `http://127.0.0.1:${portB}/api/a2a/dashboard/logs/trace/${encodeURIComponent(traceId)}?limit=250`
  );
  assert.strictEqual(logsByTrace.res.status, 200, 'logs by trace should return 200');
  assert.ok(logsByTrace.json && logsByTrace.json.success, 'logs by trace should return success=true');
  assert.ok(logsByTrace.json.logs.length > 0, 'trace logs should not be empty');
  assert.ok(logsByTrace.json.logs.every((entry) => entry.trace_id === traceId), 'trace filter should be strict');

  const logsByError = await fetchJson(
    `http://127.0.0.1:${portB}/api/a2a/dashboard/logs?error_code=TOKEN_INVALID_OR_EXPIRED&limit=50`
  );
  assert.strictEqual(logsByError.res.status, 200, 'logs by error should return 200');
  assert.ok(logsByError.json.logs.length > 0, 'error_code filter should return entries');
  assert.ok(
    logsByError.json.logs.some((entry) => typeof entry.hint === 'string' && entry.hint.toLowerCase().includes('fresh invite token')),
    'error_code logs should include actionable hint'
  );

  log('Asserting DB persistence');
  const logDbPath = path.join(agentBConfig, 'a2a-logs.db');
  const convDbPath = path.join(agentBConfig, 'a2a-conversations.db');
  const subagentConvDbPath = path.join(agentCConfig, 'a2a-conversations.db');

  assert.ok(fs.existsSync(logDbPath), 'log db file should exist');
  assert.ok(fs.existsSync(convDbPath), 'conversation db file should exist');
  assert.ok(fs.existsSync(subagentConvDbPath), 'subagent conversation db file should exist');

  const logDb = new Database(logDbPath, { readonly: true });
  const invalidTokenLog = logDb
    .prepare('SELECT error_code, hint FROM logs WHERE error_code = ? ORDER BY id DESC LIMIT 1')
    .get('TOKEN_INVALID_OR_EXPIRED');
  assert.ok(invalidTokenLog, 'TOKEN_INVALID_OR_EXPIRED should be persisted');
  assert.ok(invalidTokenLog.hint && invalidTokenLog.hint.length > 0, 'error log should include hint');
  logDb.close();

  const convDb = new Database(convDbPath, { readonly: true });
  const conversationRow = convDb
    .prepare('SELECT id, status, message_count FROM conversations WHERE id = ?')
    .get(conversationId);
  assert.ok(conversationRow, 'conversation row should exist');
  assert.strictEqual(conversationRow.status, 'concluded', 'conversation should be concluded');
  convDb.close();

  const subagentConvDb = new Database(subagentConvDbPath, { readonly: true });
  const subagentConversationCount = subagentConvDb
    .prepare('SELECT COUNT(*) AS count FROM conversations')
    .get()
    .count;
  const subagentMessageCount = subagentConvDb
    .prepare('SELECT COUNT(*) AS count FROM messages')
    .get()
    .count;
  subagentConvDb.close();

  assert.ok(subagentConversationCount >= 1, 'subagent should receive routed conversations over internet');
  assert.ok(subagentMessageCount >= 2, 'subagent should persist routed conversation messages');

  const result = {
    lane: 'internet',
    tunnels: {
      b: tunnelB.host,
      c: tunnelC.host
    },
    ports: { b: portB, c: portC },
    conversation_id: conversationId,
    trace_id: traceId,
    subagent_conversations: subagentConversationCount,
    subagent_messages: subagentMessageCount
  };

  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  log('PASS', result);
}

main()
  .catch(async (err) => {
    console.error('[internet] FAIL', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const pid of tunnelPids) {
      killPid(pid);
    }
    await stopAllServers();
  });
