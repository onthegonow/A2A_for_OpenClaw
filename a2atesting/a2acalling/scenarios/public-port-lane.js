'use strict';

const assert = require('assert');
const { setTimeout: delay } = require('timers/promises');

function log(message, data) {
  if (data) {
    console.log(`[public-port] ${message}`, data);
    return;
  }
  console.log(`[public-port] ${message}`);
}

function envBool(name) {
  const raw = process.env[name];
  if (!raw) return false;
  const normalized = String(raw).trim().toLowerCase();
  return !(normalized === '0' || normalized === 'false' || normalized === 'no');
}

function randomId(prefix) {
  const buf = Buffer.from(Array.from({ length: 8 }, () => Math.floor(Math.random() * 256)));
  return `${prefix}_${buf.toString('hex')}`;
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

async function fetchText(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const { res, text } = await fetchText(url, options, timeoutMs);
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text}`);
  }
  return { res, json };
}

async function waitForOk(url, timeoutMs = 60000) {
  const start = Date.now();
  let lastErr = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const { res } = await fetchText(url, { method: 'GET' }, 8000);
      if (res.ok) {
        return;
      }
      lastErr = new Error(`status=${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for ${url}: ${describeFetchError(lastErr)}`);
}

function requireEnv(name) {
  const value = process.env[name] || '';
  if (!String(value).trim()) {
    throw new Error(`${name} is required`);
  }
  return String(value).trim();
}

async function main() {
  const required = envBool('A2A_PUBLIC_REQUIRED');
  const baseUrlRaw = (process.env.A2A_PUBLIC_BASE_URL || '').trim();

  if (!baseUrlRaw) {
    const msg = 'A2A_PUBLIC_BASE_URL not set; skipping public-port lane.';
    if (required) {
      throw new Error(`${msg} (A2A_PUBLIC_REQUIRED=1)`);
    }
    log(msg);
    return;
  }

  let baseUrl;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch (err) {
    throw new Error(`A2A_PUBLIC_BASE_URL must be a valid URL (got: ${baseUrlRaw})`);
  }

  const adminToken = (process.env.A2A_PUBLIC_ADMIN_TOKEN || '').trim();
  if (!adminToken) {
    const msg = 'A2A_PUBLIC_ADMIN_TOKEN not set; skipping public-port lane.';
    if (required) {
      throw new Error(`${msg} (A2A_PUBLIC_REQUIRED=1)`);
    }
    log(msg);
    return;
  }

  const expectMarker = (process.env.A2A_PUBLIC_EXPECT_MARKER || 'SUBAGENT_OK').trim();

  const pingUrl = new URL('/api/a2a/ping', baseUrl).toString();
  const statusUrl = new URL('/api/a2a/status', baseUrl).toString();
  const dashboardStatusUrl = new URL('/api/a2a/dashboard/status', baseUrl).toString();
  const dashboardInvitesUrl = new URL('/api/a2a/dashboard/invites', baseUrl).toString();

  log('Waiting for remote server ping', { pingUrl });
  await waitForOk(pingUrl, 90000);

  log('Checking /status');
  const statusRes = await fetchJson(statusUrl, {}, 15000);
  assert.ok(statusRes.json && statusRes.json.a2a, '/status must report a2a=true');

  log('Checking dashboard status');
  const dashStatusRes = await fetchJson(dashboardStatusUrl, {
    headers: {
      'x-admin-token': adminToken
    }
  }, 15000);
  assert.ok(dashStatusRes.json && dashStatusRes.json.success, 'dashboard /status must succeed');

  log('Creating invite token via dashboard');
  const inviteRes = await fetchJson(dashboardInvitesUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify({
      tier: 'friends',
      name: 'public-port-probe',
      owner: 'a2atesting',
      expires: '1h',
      disclosure: 'minimal',
      notify: 'none',
      max_calls: 10,
      topics: ['chat']
    })
  }, 20000);

  assert.ok(inviteRes.json && inviteRes.json.success, 'invite creation must succeed');
  assert.ok(inviteRes.json.invite_url, 'invite response must include invite_url');
  assert.ok(inviteRes.json.token && inviteRes.json.token.id, 'invite response must include token record');

  const inviteUrl = String(inviteRes.json.invite_url);
  const tokenId = String(inviteRes.json.token.id);

  const tokenMatch = inviteUrl.match(/^a2a:\/\/[^/]+\/(.+)$/);
  assert.ok(tokenMatch && tokenMatch[1], 'invite_url must contain token');
  const token = tokenMatch[1];

  const traceId = randomId('public');

  log('Invoking remote /invoke (internet ingress)', { traceId });
  const invokeUrl = new URL('/api/a2a/invoke', baseUrl).toString();
  const invokeRes = await fetchJson(invokeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-trace-id': traceId
    },
    body: JSON.stringify({
      message: `Public port probe ${new Date().toISOString()}. Return marker ${expectMarker}.`,
      caller: {
        name: 'public-port-probe',
        owner: 'a2atesting',
        instance: 'github-runner'
      }
    })
  }, 30000);

  assert.ok(invokeRes.json && invokeRes.json.success, 'invoke must succeed');
  assert.ok(invokeRes.json.conversation_id, 'invoke must return conversation_id');
  assert.ok(typeof invokeRes.json.response === 'string', 'invoke must return response text');
  assert.ok(
    invokeRes.json.response.includes(expectMarker),
    `invoke response must include marker "${expectMarker}" (ensure server is configured to force subagent hop)`
  );

  const echoedTrace = invokeRes.res.headers.get('x-trace-id');
  assert.strictEqual(echoedTrace, traceId, 'server must echo x-trace-id');

  const conversationId = String(invokeRes.json.conversation_id);

  log('Ending conversation');
  const endUrl = new URL('/api/a2a/end', baseUrl).toString();
  const endRes = await fetchJson(endUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-trace-id': traceId
    },
    body: JSON.stringify({
      conversation_id: conversationId
    })
  }, 30000);

  assert.ok(endRes.json && endRes.json.success, 'end must succeed');

  log('Fetching trace logs via dashboard');
  const traceUrl = new URL(`/api/a2a/dashboard/logs/trace/${encodeURIComponent(traceId)}?limit=500`, baseUrl).toString();
  const traceRes = await fetchJson(traceUrl, {
    headers: {
      'x-admin-token': adminToken
    }
  }, 20000);

  assert.ok(traceRes.json && traceRes.json.success, 'trace logs must succeed');
  assert.ok(Array.isArray(traceRes.json.logs), 'trace logs must include logs[]');
  assert.ok(traceRes.json.logs.length > 0, 'trace logs must not be empty');
  assert.ok(
    traceRes.json.logs.every(row => row.trace_id === traceId),
    'trace logs must all share trace_id'
  );

  const hasInvokeLog = traceRes.json.logs.some(row => row.event === 'invoke');
  assert.ok(hasInvokeLog, 'trace logs should include invoke event');

  const hasTurnLogs = traceRes.json.logs.some(row => row.event === 'call_turn_start') &&
    traceRes.json.logs.some(row => row.event === 'call_turn_complete');
  assert.ok(hasTurnLogs, 'trace logs should include call_turn_start and call_turn_complete');

  log('Revoking token');
  const revokeUrl = new URL(`/api/a2a/dashboard/invites/${encodeURIComponent(tokenId)}/revoke`, baseUrl).toString();
  const revokeRes = await fetchJson(revokeUrl, {
    method: 'POST',
    headers: {
      'x-admin-token': adminToken
    }
  }, 15000);
  assert.ok(revokeRes.json && revokeRes.json.success, 'revoke must succeed');

  const result = {
    lane: 'public-port',
    base_url: baseUrl.toString(),
    trace_id: traceId,
    conversation_id: conversationId,
    token_id: tokenId,
    logs_found: traceRes.json.logs.length
  };

  log('PASS', result);
}

main().catch((err) => {
  console.error('[public-port] FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
