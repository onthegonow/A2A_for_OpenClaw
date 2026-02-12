const state = {
  settings: null,
  contacts: [],
  calls: [],
  invites: []
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

function bindTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('is-active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('is-active'));
      btn.classList.add('is-active');
      document.getElementById(`tab-${tab}`).classList.add('is-active');
    });
  });
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
    `;
    tr.addEventListener('click', () => loadCallsForContact(contact.id, contact.name));
    tbody.appendChild(tr);
  });
}

async function loadContacts() {
  const payload = await request('/contacts');
  state.contacts = payload.contacts || [];
  renderContacts();
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
}

async function bootstrap() {
  bindTabs();
  bindSettingsActions();
  bindInviteActions();
  bindRefreshButtons();

  try {
    await Promise.all([loadSettings(), loadContacts(), loadCalls(), loadInvites()]);
    showNotice('Dashboard loaded');
  } catch (err) {
    showNotice(err.message);
  }
}

bootstrap();
