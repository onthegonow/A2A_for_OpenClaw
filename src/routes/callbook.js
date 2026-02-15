/**
 * Callbook Remote Install UI
 *
 * A simple HTML+JS page that:
 * - reads the provisioning code from the URL fragment (#code=...)
 * - exchanges it for a long-lived session cookie via /api/a2a/dashboard/callbook/exchange
 * - redirects into the dashboard UI
 *
 * Note: the code lives in the fragment so it is not sent in HTTP logs/referrers.
 */

const express = require('express');

function createCallbookRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    const rawPath = String(req.originalUrl || '').split('?')[0];
    if (rawPath === req.baseUrl) {
      return res.redirect(302, `${req.baseUrl}/install`);
    }
    return next();
  });

  router.get('/install', (req, res) => {
    return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Callbook Remote Install</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; padding: 2rem; max-width: 760px; margin: 0 auto; }
    h1 { margin-top: 0; }
    .card { border: 1px solid #d7dee6; border-radius: 12px; padding: 1rem; background: #fbfdff; }
    label { display: block; margin: 0.8rem 0 0.35rem; }
    input { width: 100%; padding: 0.55rem 0.65rem; border-radius: 10px; border: 1px solid #d7dee6; font: inherit; }
    button { margin-top: 0.9rem; padding: 0.55rem 0.75rem; border-radius: 10px; border: 1px solid #d7dee6; background: #fff; font: inherit; cursor: pointer; }
    button:hover { border-color: #1466c1; color: #1466c1; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f4f6f8; padding: 0.75rem; border-radius: 10px; }
    .muted { color: #4b5d73; }
    .error { color: #8a1f1f; }
    .ok { color: #1b5e20; }
  </style>
</head>
<body>
  <h1>Install Callbook Remote</h1>
  <p class="muted">This pairs your browser with the server dashboard so you can manage contacts, calls, logs, and settings remotely.</p>

  <div class="card">
    <div id="status" class="muted">Reading install code…</div>

    <label for="label">Device label</label>
    <input id="label" type="text" placeholder="e.g. Ben’s MacBook">

    <button id="connect" disabled>Connect</button>
    <button id="open-dashboard" style="display:none;">Open Dashboard</button>

    <details style="margin-top: 1rem;">
      <summary>Having trouble?</summary>
      <p class="muted">This URL must include a fragment like <code>#code=cbk_...</code>.</p>
      <pre id="debug"></pre>
    </details>
  </div>

  <script>
    const statusEl = document.getElementById('status');
    const debugEl = document.getElementById('debug');
    const labelEl = document.getElementById('label');
    const connectBtn = document.getElementById('connect');
    const openBtn = document.getElementById('open-dashboard');

    function setStatus(text, cls) {
      statusEl.textContent = text;
      statusEl.className = cls || 'muted';
    }

    function parseInstallCode() {
      const hash = String(window.location.hash || '').replace(/^#/, '');
      const params = new URLSearchParams(hash);
      return params.get('code');
    }

    async function exchange(code) {
      const label = String(labelEl.value || '').trim();
      const res = await fetch('/api/a2a/dashboard/callbook/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, label })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.success === false) {
        const msg = payload.message || payload.error || ('Request failed: ' + res.status);
        throw new Error(msg);
      }
      return payload;
    }

    const code = parseInstallCode();
    debugEl.textContent = 'hash=' + window.location.hash + '\\ncode=' + (code ? '[present]' : '[missing]');

    if (!labelEl.value) {
      const guess = (navigator.platform || navigator.userAgent || '').replace(/\\s+/g, ' ').trim();
      labelEl.value = guess ? ('Callbook Remote (' + guess.slice(0, 36) + ')') : 'Callbook Remote';
    }

    if (!code) {
      setStatus('Missing install code in URL fragment. Ask your agent to generate a new install link.', 'error');
    } else {
      setStatus('Install code found. Click Connect to pair this device.', 'muted');
      connectBtn.disabled = false;
      connectBtn.addEventListener('click', async () => {
        connectBtn.disabled = true;
        setStatus('Connecting…', 'muted');
        try {
          const result = await exchange(code);
          setStatus('Connected. Session cookie stored in your browser.', 'ok');
          openBtn.style.display = 'inline-block';
          openBtn.addEventListener('click', () => {
            window.location.href = result.dashboard_path || '/api/a2a/dashboard/';
          });
          window.setTimeout(() => {
            window.location.href = result.dashboard_path || '/api/a2a/dashboard/';
          }, 350);
        } catch (err) {
          setStatus('Failed: ' + err.message, 'error');
          connectBtn.disabled = false;
        }
      });
    }
  </script>
</body>
</html>`);
  });

  return router;
}

module.exports = {
  createCallbookRouter
};

