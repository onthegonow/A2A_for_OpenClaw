'use strict';

const assert = require('assert');
const { A2AClient } = require('a2acalling');

function log(message, data) {
  if (data) {
    console.log(`[nightly-real] ${message}`, data);
    return;
  }
  console.log(`[nightly-real] ${message}`);
}

async function main() {
  const invite = process.env.A2A_REAL_INVITE_URL || '';
  const required = String(process.env.A2A_REAL_REQUIRED || '').toLowerCase() === '1';

  if (!invite) {
    const msg = 'A2A_REAL_INVITE_URL not set; skipping nightly-real lane.';
    if (required) {
      throw new Error(`${msg} (A2A_REAL_REQUIRED=1)`);
    }
    log(msg);
    return;
  }

  const timeout = Number.parseInt(process.env.A2A_REAL_TIMEOUT_MS || '20000', 10) || 20000;
  const message = process.env.A2A_REAL_MESSAGE ||
    'Nightly real-runtime canary from a2atesting. Reply with one short confirmation line.';

  const client = new A2AClient({
    timeout,
    caller: {
      name: 'a2a-nightly-canary',
      owner: 'A2A Testing Harness',
      instance: 'nightly-real-lane'
    }
  });

  log('Checking remote status');
  const status = await client.status(invite);
  assert.ok(status && status.a2a, 'status check must indicate a2a=true');

  log('Sending canary invoke');
  const first = await client.call(invite, message);
  assert.strictEqual(first.success, true, 'real lane call should succeed');

  let endResult = null;
  if (first.conversation_id) {
    log('Ending canary conversation');
    endResult = await client.end(invite, first.conversation_id);
    assert.strictEqual(endResult.success, true, 'real lane end should succeed');
  }

  const result = {
    lane: 'nightly-real',
    status_version: status.version || null,
    conversation_id: first.conversation_id || null,
    ended: Boolean(endResult && endResult.success)
  };

  log('PASS', result);
}

main().catch((err) => {
  console.error('[nightly-real] FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
