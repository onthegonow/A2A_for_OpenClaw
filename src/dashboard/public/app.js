const state = {
  settings: null,
  dashboardStatus: null,
  callbookDevices: [],
  contacts: [],
  calls: [],
  invites: [],
  logs: [],
  logStats: null,
  trace: null
};

function showNotice(message) {
  const el = document.getElementById('notice');
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => {
    el.style.display = 'none';
  }, 3500);
}

async function request(path, options = {}) {
  const res = await fetch(`/api/a2a/dashboard${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || `Request failed: ${res.status}`);
  }
  return payload;
}

function toLines(values) {
  return (values || []).join('\n');
}

function fromLines(value) {
  return value
    .split('\n')
    .map(v => v.trim())
    .filter(Boolean);
}

function fmtDate(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch (err) {
    return String(value);
  }
}

function esc(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function copyText(value) {
  const text = String(value || '');
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // fall back
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch (err) {
    return false;
  }
}

function bindTabs() {
  const activateTab = (tab, options = {}) => {
    const target = String(tab || '').replace(/^#/, '').trim();
    if (!target) return false;
    const btn = Array.from(document.querySelectorAll('.tab')).find(b => b.dataset.tab === target);
    const panel = document.getElementById(`tab-${target}`);
    if (!btn || !panel) return false;

    document.querySelectorAll('.tab').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    panel.classList.add('is-active');

    if (options.updateHash) {
      try { window.location.hash = target; } catch (err) {}
    }
    return true;
  };

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab, { updateHash: true });
    });
  });

  window.addEventListener('hashchange', () => {
    activateTab(window.location.hash);
  });

  // Deep-link into a tab with /dashboard/#logs, etc.
  activateTab(window.location.hash);
}

function renderContacts() {
  const tbody = document.querySelector('#contacts-table tbody');
  tbody.innerHTML = '';
  state.contacts.forEach(contact => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${contact.name || '-'}</td>
      <td>${contact.owner || '-'}</td>
      <td>${contact.status || '-'}</td>
      <td>${contact.call_count || 0}</td>
      <td>${(contact.last_summary || contact.last_owner_summary || '-').slice(0, 120)}</td>
      <td><button data-remove="${esc(contact.id)}">Remove</button></td>
    `;
    tr.addEventListener('click', () => loadCallsForContact(contact.id, contact.name));
    const removeBtn = tr.querySelector('button[data-remove]');
    if (removeBtn) {
      removeBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeBtn.disabled = true;
        try {
          await request(`/contacts/${encodeURIComponent(contact.id)}`, { method: 'DELETE' });
          showNotice('Contact removed');
          await loadContacts();
        } catch (err) {
          showNotice(err.message);
          removeBtn.disabled = false;
        }
      });
    }
    tbody.appendChild(tr);
  });
}

async function loadContacts() {
  const payload = await request('/contacts');
  state.contacts = payload.contacts || [];
  renderContacts();
}

function bindContactsActions() {
  const form = document.getElementById('add-contact-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = document.getElementById('add-contact-url').value.trim();
    const name = document.getElementById('add-contact-name').value.trim();
    const owner = document.getElementById('add-contact-owner').value.trim();
    const tagsRaw = document.getElementById('add-contact-tags').value.trim();
    const tags = tagsRaw
      ? tagsRaw.split(',').map(v => v.trim()).filter(Boolean).slice(0, 30)
      : [];

    try {
      await request('/contacts', {
        method: 'POST',
        body: JSON.stringify({
          invite_url: url,
          name: name || undefined,
          owner: owner || undefined,
          tags
        })
      });
      showNotice('Contact added');
      form.reset();
      await loadContacts();
    } catch (err) {
      showNotice(err.message);
    }
  });
}

function renderCalls() {
  const tbody = document.querySelector('#calls-table tbody');
  tbody.innerHTML = '';
  state.calls.forEach(call => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${call.id}</td>
      <td>${call.contact?.name || call.contact_name || '-'}</td>
      <td>${call.status || '-'}</td>
      <td>${call.message_count || 0}</td>
      <td>${fmtDate(call.last_message_at)}</td>
      <td>${(call.summary || call.owner_summary || '-').slice(0, 120)}</td>
    `;
    tr.addEventListener('click', () => loadCallDetail(call.id));
    tbody.appendChild(tr);
  });
}

async function loadCalls() {
  const payload = await request('/calls?limit=200');
  state.calls = payload.calls || [];
  renderCalls();
}

async function loadCallDetail(conversationId) {
  const payload = await request(`/calls/${encodeURIComponent(conversationId)}?messages=40`);
  const call = payload.call;
  const el = document.getElementById('call-detail');
  const messages = (call.recentMessages || [])
    .map(msg => `[${fmtDate(msg.timestamp)}] ${msg.direction}: ${msg.content}`)
    .join('\n\n');
  el.innerHTML = `
    <h3>Call Detail: ${call.id}</h3>
    <p><strong>Contact:</strong> ${call.contact?.name || call.contact || '-'}</p>
    <p><strong>Status:</strong> ${call.status || '-'}</p>
    <p><strong>Summary:</strong> ${(call.summary || call.ownerContext?.summary || '-')}</p>
    <pre class="summary">${messages || 'No messages recorded.'}</pre>
  `;
}

async function loadCallsForContact(contactId, contactName) {
  const payload = await request(`/contacts/${encodeURIComponent(contactId)}/calls?limit=100`);
  const calls = payload.calls || [];
  const el = document.getElementById('contact-calls');
  const rows = calls.map(call => {
    return `
      <tr>
        <td>${call.id}</td>
        <td>${call.status || '-'}</td>
        <td>${fmtDate(call.last_message_at)}</td>
        <td>${(call.summary || call.owner_summary || '-').slice(0, 140)}</td>
      </tr>
    `;
  }).join('');
  el.innerHTML = `
    <h3>Calls with ${contactName}</h3>
    <table>
      <thead><tr><th>ID</th><th>Status</th><th>Updated</th><th>Summary</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No calls found.</td></tr>'}</tbody>
    </table>
  `;
}

function readLogFilters() {
  const level = document.getElementById('logs-level').value.trim();
  const component = document.getElementById('logs-component').value.trim();
  const event = document.getElementById('logs-event').value.trim();
  const traceId = document.getElementById('logs-trace').value.trim();
  const conversationId = document.getElementById('logs-conversation').value.trim();
  const tokenId = document.getElementById('logs-token').value.trim();
  const search = document.getElementById('logs-search').value.trim();
  const limit = Number.parseInt(document.getElementById('logs-limit').value, 10) || 200;

  const params = new URLSearchParams();
  params.set('limit', String(Math.min(1000, Math.max(1, limit))));
  if (level) params.set('level', level);
  if (component) params.set('component', component);
  if (event) params.set('event', event);
  if (traceId) params.set('trace_id', traceId);
  if (conversationId) params.set('conversation_id', conversationId);
  if (tokenId) params.set('token_id', tokenId);
  if (search) params.set('search', search);

  return params;
}

function renderLogStats() {
  const el = document.getElementById('log-stats');
  if (!state.logStats) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  const stats = state.logStats;
  const levels = Object.entries(stats.by_level || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const components = Object.entries(stats.by_component || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  el.style.display = 'block';
  el.innerHTML = `
    <div class="row">
      <strong>Total:</strong> ${stats.total || 0}
    </div>
    <div class="row">
      <strong>By level:</strong> ${levels.map(([k, v]) => `${esc(k)}=${v}`).join(' · ') || '(none)'}
    </div>
    <div class="row">
      <strong>Top components:</strong> ${components.map(([k, v]) => `${esc(k)}=${v}`).join(' · ') || '(none)'}
    </div>
  `;
}

function renderTraceDetail() {
  const el = document.getElementById('trace-detail');
  if (!state.trace || !Array.isArray(state.trace.logs)) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  const logs = state.trace.logs || [];
  const lines = logs.map(row => {
    const msg = row.message || '';
    const meta = [
      row.component ? row.component : null,
      row.event ? row.event : null,
      row.error_code ? `code=${row.error_code}` : null,
      row.status_code ? `status=${row.status_code}` : null
    ].filter(Boolean).join(' ');
    return `[${fmtDate(row.timestamp)}] ${row.level?.toUpperCase() || ''} ${meta}\n${msg}${row.hint ? `\nHint: ${row.hint}` : ''}`;
  }).join('\n\n');

  el.innerHTML = `
    <div class="row">
      <h3 style="margin:0;">Trace: <span class="mono">${esc(state.trace.trace_id || '')}</span></h3>
      <button id="clear-trace">Clear</button>
    </div>
    <pre class="summary mono">${esc(lines || 'No trace logs.')}</pre>
  `;
  const clearBtn = document.getElementById('clear-trace');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.trace = null;
      renderTraceDetail();
    });
  }
}

function renderLogs() {
  const tbody = document.querySelector('#logs-table tbody');
  tbody.innerHTML = '';

  state.logs.forEach(row => {
    const tr = document.createElement('tr');
    const trace = row.trace_id || '';
    tr.innerHTML = `
      <td>${esc(fmtDate(row.timestamp))}</td>
      <td>${esc(row.level || '-')}</td>
      <td>${esc(row.component || '-')}</td>
      <td>${esc(row.event || '-')}</td>
      <td title="${esc(row.message || '')}">${esc(String(row.message || '').slice(0, 120) || '-')}</td>
      <td class="mono">${esc(trace ? trace.slice(0, 14) + '…' : '-')}</td>
      <td class="mono">${esc(row.conversation_id ? row.conversation_id.slice(0, 14) + '…' : '-')}</td>
      <td class="mono">${esc(row.token_id || '-')}</td>
      <td>${esc(row.error_code || '-')}</td>
      <td>${esc(row.status_code ?? '-')}</td>
    `;
    if (trace) {
      tr.addEventListener('click', () => loadTrace(trace).catch(err => showNotice(err.message)));
    }
    tbody.appendChild(tr);
  });
}

async function loadLogs() {
  const qs = readLogFilters().toString();
  const payload = await request(`/logs?${qs}`);
  state.logs = payload.logs || [];
  renderLogs();
}

async function loadLogStats() {
  const payload = await request('/logs/stats');
  state.logStats = payload.stats || null;
  renderLogStats();
}

async function loadTrace(traceId) {
  const payload = await request(`/logs/trace/${encodeURIComponent(traceId)}?limit=500`);
  state.trace = payload;
  renderTraceDetail();
}

function fillTierSelects() {
  const tiers = (state.settings?.tiers || []).slice().sort((a, b) => a.id.localeCompare(b.id));
  const tierSelect = document.getElementById('tier-select');
  const copyFrom = document.getElementById('copy-from-tier');
  const newTierCopy = document.getElementById('new-tier-copy-from');
  const inviteTier = document.getElementById('invite-tier');

  [tierSelect, copyFrom, inviteTier].forEach(el => { el.innerHTML = ''; });
  newTierCopy.innerHTML = '<option value="">None</option>';

  tiers.forEach(tier => {
    const option = new Option(`${tier.id} (${tier.name || tier.id})`, tier.id);
    tierSelect.add(option.cloneNode(true));
    copyFrom.add(option.cloneNode(true));
    inviteTier.add(option.cloneNode(true));
    newTierCopy.add(option.cloneNode(true));
  });

  if (tiers.length > 0) {
    tierSelect.value = tiers[0].id;
    copyFrom.value = tiers[0].id;
    inviteTier.value = tiers[0].id;
    renderTierEditor(tiers[0].id);
  }
}

function renderTierEditor(tierId) {
  const tier = (state.settings?.tiers || []).find(t => t.id === tierId);
  if (!tier) return;

  document.getElementById('tier-id').value = tier.id;
  document.getElementById('tier-name').value = tier.name || tier.id;
  document.getElementById('tier-description').value = tier.description || '';
  document.getElementById('tier-disclosure').value = tier.disclosure || 'minimal';
  document.getElementById('tier-topics').value = toLines(tier.topics || []);
  document.getElementById('tier-goals').value = toLines(tier.goals || []);
}

function bindSettingsActions() {
  document.getElementById('tier-select').addEventListener('change', (e) => {
    renderTierEditor(e.target.value);
  });

  document.getElementById('tier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tierId = document.getElementById('tier-id').value;
    const body = {
      name: document.getElementById('tier-name').value,
      description: document.getElementById('tier-description').value,
      disclosure: document.getElementById('tier-disclosure').value,
      topics: fromLines(document.getElementById('tier-topics').value),
      goals: fromLines(document.getElementById('tier-goals').value)
    };
    await request(`/settings/tiers/${encodeURIComponent(tierId)}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    showNotice(`Saved tier "${tierId}"`);
    await loadSettings();
  });

  document.getElementById('copy-tier-btn').addEventListener('click', async () => {
    const toTier = document.getElementById('tier-id').value;
    const fromTier = document.getElementById('copy-from-tier').value;
    if (!toTier || !fromTier || toTier === fromTier) return;
    await request(`/settings/tiers/${encodeURIComponent(toTier)}/copy-from/${encodeURIComponent(fromTier)}`, {
      method: 'POST'
    });
    showNotice(`Copied "${fromTier}" -> "${toTier}"`);
    await loadSettings();
    renderTierEditor(toTier);
  });

  document.getElementById('defaults-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await request('/settings/defaults', {
      method: 'PUT',
      body: JSON.stringify({
        expiration: document.getElementById('defaults-expiration').value,
        maxCalls: Number.parseInt(document.getElementById('defaults-max-calls').value, 10) || 100
      })
    });
    showNotice('Saved defaults');
    await loadSettings();
  });

  document.getElementById('new-tier-btn').addEventListener('click', () => {
    document.getElementById('new-tier-id').focus();
  });

  document.getElementById('new-tier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tierId = document.getElementById('new-tier-id').value.trim();
    const name = document.getElementById('new-tier-name').value.trim();
    const copyFrom = document.getElementById('new-tier-copy-from').value;
    if (!tierId) return;
    await request('/settings/tiers', {
      method: 'POST',
      body: JSON.stringify({
        id: tierId,
        name: name || tierId,
        copy_from: copyFrom || undefined
      })
    });
    showNotice(`Created tier "${tierId}"`);
    document.getElementById('new-tier-form').reset();
    await loadSettings();
    document.getElementById('tier-select').value = tierId;
    renderTierEditor(tierId);
  });
}

async function loadSettings() {
  const payload = await request('/settings');
  state.settings = payload;
  fillTierSelects();
  document.getElementById('defaults-expiration').value = payload.defaults?.expiration || '7d';
  document.getElementById('defaults-max-calls').value = payload.defaults?.maxCalls || 100;
}

function renderCallbookStatus() {
  const el = document.getElementById('callbook-status');
  if (!el) return;

  const s = state.dashboardStatus;
  if (!s) {
    el.textContent = 'Loading…';
    return;
  }

  const warnings = Array.isArray(s.warnings) ? s.warnings : [];
  const publicUrl = s.public_dashboard_url || '-';
  const enabled = Boolean(s.callbook && s.callbook.enabled);
  const deviceCount = s.callbook && Number.isFinite(s.callbook.device_count) ? s.callbook.device_count : 0;

  el.innerHTML = `
    <div><strong>Public dashboard URL:</strong> <span class="mono">${esc(publicUrl)}</span></div>
    <div><strong>Callbook session storage:</strong> ${enabled ? 'enabled' : 'disabled'}</div>
    <div><strong>Paired devices:</strong> ${deviceCount}</div>
    ${warnings.length ? `<div style="margin-top:0.5rem;"><strong>Warnings:</strong><br>${warnings.map(w => esc(w)).join('<br>')}</div>` : ''}
  `;
}

async function loadDashboardStatus() {
  const payload = await request('/status');
  state.dashboardStatus = payload;
  renderCallbookStatus();
}

function renderCallbookDevices() {
  const tbody = document.querySelector('#callbook-devices-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const devices = Array.isArray(state.callbookDevices) ? state.callbookDevices : [];
  if (devices.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6">No devices found.</td>';
    tbody.appendChild(tr);
    return;
  }

  devices.forEach(dev => {
    const tr = document.createElement('tr');
    const revoked = Boolean(dev.revoked_at);
    const sessions = dev.active_sessions ?? '-';
    tr.innerHTML = `
      <td>${esc(dev.label || dev.id || '-')}</td>
      <td>${esc(fmtDate(dev.created_at))}</td>
      <td>${esc(fmtDate(dev.last_used_at))}</td>
      <td>${esc(String(sessions))}</td>
      <td>${revoked ? esc(fmtDate(dev.revoked_at)) : '-'}</td>
      <td>
        <button data-revoke="${esc(dev.id)}" ${revoked ? 'disabled' : ''}>Revoke</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-revoke]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const deviceId = btn.dataset.revoke;
      if (!deviceId) return;
      btn.disabled = true;
      try {
        await request(`/callbook/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST' });
        showNotice('Device revoked');
        await loadCallbookDevices();
      } catch (err) {
        showNotice(err.message);
        btn.disabled = false;
      }
    });
  });
}

async function loadCallbookDevices() {
  const payload = await request('/callbook/devices?include_revoked=true');
  state.callbookDevices = payload.devices || [];
  renderCallbookDevices();
}

function bindCallbookActions() {
  const form = document.getElementById('callbook-provision-form');
  if (!form) return;

  const urlEl = document.getElementById('callbook-install-url');
  const labelEl = document.getElementById('callbook-label');
  const warningsEl = document.getElementById('callbook-warnings');

  document.getElementById('callbook-refresh')?.addEventListener('click', () => {
    Promise.all([loadDashboardStatus(), loadCallbookDevices()]).catch(err => showNotice(err.message));
  });

  document.getElementById('callbook-refresh-devices')?.addEventListener('click', () => {
    loadCallbookDevices().catch(err => showNotice(err.message));
  });

  document.getElementById('callbook-logout')?.addEventListener('click', async () => {
    try {
      await request('/callbook/logout', { method: 'POST' });
      showNotice('Logged out (cookie cleared)');
    } catch (err) {
      showNotice(err.message);
    }
  });

  document.getElementById('callbook-copy-url')?.addEventListener('click', async () => {
    const ok = await copyText(urlEl?.value || '');
    showNotice(ok ? 'Copied' : 'Copy failed');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (warningsEl) warningsEl.textContent = '';
    if (urlEl) urlEl.value = '';

    const body = {
      label: labelEl ? labelEl.value : 'Callbook Remote',
      ttl_hours: 24
    };

    try {
      const result = await request('/callbook/provision', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (urlEl) urlEl.value = result.install_url || '';
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      const expiresAt = result.expires_at ? `Expires: ${fmtDate(result.expires_at)}` : '';
      if (warningsEl) {
        warningsEl.textContent = [expiresAt, ...warnings].filter(Boolean).join('\n');
      }
      showNotice('Install link created');
    } catch (err) {
      showNotice(err.message);
    }
  });
}

function renderInvites() {
  const tbody = document.querySelector('#invites-table tbody');
  tbody.innerHTML = '';
  state.invites.forEach(invite => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${invite.id}</td>
      <td>${invite.name || '-'}</td>
      <td>${invite.tier || '-'}</td>
      <td>${invite.calls_made || 0}${invite.max_calls ? `/${invite.max_calls}` : ''}</td>
      <td>${fmtDate(invite.expires_at)}</td>
      <td>${invite.revoked ? 'revoked' : 'active'}</td>
      <td><button data-revoke="${invite.id}" ${invite.revoked ? 'disabled' : ''}>Revoke</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-revoke]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tokenId = btn.dataset.revoke;
      await request(`/invites/${encodeURIComponent(tokenId)}/revoke`, { method: 'POST' });
      showNotice(`Revoked ${tokenId}`);
      await loadInvites();
    });
  });
}

async function loadInvites() {
  const payload = await request('/invites?include_revoked=true');
  state.invites = payload.invites || [];
  renderInvites();
}

function bindInviteActions() {
  document.getElementById('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: document.getElementById('invite-name').value,
      owner: document.getElementById('invite-owner').value,
      tier: document.getElementById('invite-tier').value,
      expires: document.getElementById('invite-expires').value,
      max_calls: Number.parseInt(document.getElementById('invite-max-calls').value, 10),
      notify: document.getElementById('invite-notify').value
    };
    const result = await request('/invites', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    document.getElementById('invite-message').value = result.invite_message || result.invite_url;
    if (result.warnings && result.warnings.length) {
      showNotice(result.warnings[0]);
    } else {
      showNotice('Invite created');
    }
    await loadInvites();
  });
}

function bindRefreshButtons() {
  document.getElementById('refresh-contacts').addEventListener('click', () => loadContacts().catch(err => showNotice(err.message)));
  document.getElementById('refresh-calls').addEventListener('click', () => loadCalls().catch(err => showNotice(err.message)));
  document.getElementById('refresh-invites').addEventListener('click', () => loadInvites().catch(err => showNotice(err.message)));
  document.getElementById('refresh-logs').addEventListener('click', () => loadLogs().catch(err => showNotice(err.message)));
  document.getElementById('refresh-log-stats').addEventListener('click', () => loadLogStats().catch(err => showNotice(err.message)));

  // Auto-refresh logs as filters change (debounced).
  let debounce = null;
  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => loadLogs().catch(err => showNotice(err.message)), 250);
  };
  [
    'logs-level',
    'logs-component',
    'logs-event',
    'logs-trace',
    'logs-conversation',
    'logs-token',
    'logs-search',
    'logs-limit'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', schedule);
    el.addEventListener('change', schedule);
  });
}

async function bootstrap() {
  bindTabs();
  bindContactsActions();
  bindSettingsActions();
  bindCallbookActions();
  bindInviteActions();
  bindRefreshButtons();

  try {
    await Promise.all([
      loadSettings(),
      loadDashboardStatus(),
      loadCallbookDevices(),
      loadContacts(),
      loadCalls(),
      loadInvites(),
      loadLogStats(),
      loadLogs()
    ]);
    showNotice('Dashboard loaded');
  } catch (err) {
    showNotice(err.message);
  }
}

bootstrap();
