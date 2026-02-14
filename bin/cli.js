#!/usr/bin/env node
/**
 * A2A Calling CLI
 * 
 * Usage:
 *   a2a create [options]     Create an A2A token
 *   a2a list                 List active tokens
 *   a2a revoke <id>          Revoke a token
 *   a2a add <url> [name]     Add a contact (alias of "contacts add")
 *   a2a remotes              List contacts (alias of "contacts")
 *   a2a call <url> <msg>     Call a contact (or invite URL)
 *   a2a ping <url>           Ping an invite URL
 *   a2a gui                  Open the local dashboard GUI in a browser
 *   a2a setup                Auto setup (gateway-aware dashboard install)
 */

const { TokenStore } = require('../src/lib/tokens');
const { A2AClient } = require('../src/lib/client');

// Lazy load conversation store (requires better-sqlite3)
let convStore = null;
function getConvStore() {
  if (convStore === false) return null; // Already tried and failed
  if (!convStore) {
    try {
      const { ConversationStore } = require('../src/lib/conversations');
      convStore = new ConversationStore();
      if (!convStore.isAvailable()) {
        console.error(`[a2a] ${convStore.getError()}`);
        convStore = false;
        return null;
      }
    } catch (err) {
      convStore = false;
      return null;
    }
  }
  return convStore;
}

const store = new TokenStore();

// Check onboarding status — warns but does not block
function checkOnboarding(commandName) {
  try {
    const { A2AConfig } = require('../src/lib/config');
    const config = new A2AConfig();
    if (!config.isOnboarded()) {
      console.warn('\n\u26a0\ufe0f  A2A onboarding not complete.');
      console.warn('   Run "a2a quickstart" to complete deterministic onboarding.');
      console.warn('   Without onboarding, invites may use default topics/goals and remote dashboard access may not be configured.\n');
      return false;
    }
    return true;
  } catch (e) {
    return true; // Don't block if config is broken
  }
}

// Format relative time
function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function openInBrowser(url) {
  const { spawn } = require('child_process');

  const platform = process.platform;
  let cmd = null;
  let args = [];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
    return { attempted: true, command: [cmd, ...args].join(' ') };
  } catch (err) {
    return { attempted: false, error: err.message };
  }
}

async function findLocalServerPort(preferredPorts = []) {
  const http = require('http');

  const candidates = [];
  const seen = new Set();
  for (const port of preferredPorts) {
    const n = Number.parseInt(String(port), 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    candidates.push(n);
  }

  const defaultPorts = [3001, 80, 8080, 8443, 9001];
  for (const port of defaultPorts) {
    if (seen.has(port)) continue;
    seen.add(port);
    candidates.push(port);
  }

  const probe = (port) => new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/a2a/ping',
      method: 'GET',
      timeout: 800
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });

  for (const port of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await probe(port);
    if (ok) return port;
  }
  return null;
}

// Parse arguments
function parseArgs(argv) {
  const args = { _: [], flags: {} };
  let i = 2;
  while (i < argv.length) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
      args.flags[key] = val;
    } else if (argv[i].startsWith('-') && argv[i].length === 2) {
      const key = argv[i].slice(1);
      const val = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
      args.flags[key] = val;
    } else {
      args._.push(argv[i]);
    }
    i++;
  }
  return args;
}

async function resolveInviteHostname() {
  const { resolveInviteHost } = require('../src/lib/invite-host');

  try {
    const { A2AConfig } = require('../src/lib/config');
    const config = new A2AConfig();
    const resolved = await resolveInviteHost({
      config,
      defaultPort: process.env.PORT || process.env.A2A_PORT || 3001
    });
    return resolved;
  } catch (err) {
    return resolveInviteHost({
      fallbackHost: process.env.OPENCLAW_HOSTNAME || process.env.HOSTNAME || 'localhost',
      defaultPort: process.env.PORT || process.env.A2A_PORT || 3001
    });
  }
}

// Commands
const commands = {
  create: async (args) => {
    checkOnboarding('create');
    // Parse max-calls: number, 'unlimited', or default (unlimited)
    let maxCalls = null; // Default: unlimited
    if (args.flags['max-calls']) {
      if (args.flags['max-calls'] === 'unlimited') {
        maxCalls = null;
      } else {
        maxCalls = parseInt(args.flags['max-calls']) || null;
      }
    }

    // Parse custom topics if provided
    const customTopics = args.flags.topics ? 
      args.flags.topics.split(',').map(t => t.trim()) : null;

    const { token, record } = store.create({
      name: args.flags.name || args.flags.n || 'unnamed',
      owner: args.flags.owner || args.flags.o || null,
      expires: args.flags.expires || args.flags.e || 'never',
      permissions: args.flags.permissions || args.flags.p || 'public',
      disclosure: args.flags.disclosure || args.flags.d || 'minimal',
      notify: args.flags.notify || 'all',
      maxCalls,
      allowedTopics: customTopics
    });

    const resolvedHost = await resolveInviteHostname();
    const hostname = resolvedHost.host;
    const inviteUrl = `a2a://${hostname}/${token}`;

    const expiresText = record.expires_at 
      ? new Date(record.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'never';

    if (resolvedHost.warnings && resolvedHost.warnings.length) {
      for (const w of resolvedHost.warnings) {
        console.warn(`\n⚠️  ${w}`);
      }
      console.warn('');
    }

    // Auto-link to contact if specified
    const linkContact = args.flags.link || args.flags.l;
    if (linkContact) {
      const linkResult = store.linkTokenToContact(linkContact, record.id);
      if (linkResult.success) {
        console.log(`✅ Token created & linked to ${linkContact}\n`);
      } else {
        console.log(`✅ Token created (link failed: ${linkResult.error})\n`);
      }
    } else {
      console.log(`✅ A2A token created\n`);
    }
    
    console.log(`Name: ${record.name}`);
    if (record.owner) console.log(`Owner: ${record.owner}`);
    console.log(`Expires: ${record.expires_at || 'never'}`);
    console.log(`Tier: ${record.tier}`);
    console.log(`Topics: ${record.allowed_topics.join(', ')}`);
    console.log(`Disclosure: ${record.disclosure}`);
    console.log(`Notify: ${record.notify}`);
    console.log(`Max calls: ${record.max_calls || 'unlimited'}`);
    if (linkContact) console.log(`Linked to: ${linkContact}`);
    console.log(`\nTo revoke: a2a revoke ${record.id}`);
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📋 SHAREABLE INVITE (copy everything below):`);
    console.log(`${'─'.repeat(50)}\n`);
    
    // Generate shareable invite block
    // Special invitation above the fold, agent setup below
    const ownerText = record.owner || 'Someone';
    const agentName = record.name;
    const topicsList = record.allowed_topics.join(' · ');
    const goalsList = (record.allowed_goals || []).join(' · ');

    const invite = `📞🗣️ **Agent-to-Agent Call Invite**

👤 **${ownerText}** would like your agent to call **${agentName}** and explore where our owners might collaborate.

💬 ${topicsList}${goalsList ? `\n🎯 ${goalsList}` : ''}

${inviteUrl}${expiresText === 'never' ? '' : `\n⏰ ${expiresText}`}

── setup ──
npm i -g a2acalling && a2a add "${inviteUrl}" "${agentName}" && a2a call "${agentName}" "Hello from my owner!"
https://github.com/onthegonow/a2a_calling`;

    console.log(invite);
    console.log(`\n${'─'.repeat(50)}`);
  },

  list: () => {
    const tokens = store.list();
    if (tokens.length === 0) {
      console.log('No active A2A tokens.');
      return;
    }

    console.log('Active A2A tokens:\n');
    for (const t of tokens) {
      const expired = t.expires_at && new Date(t.expires_at) < new Date();
      const status = expired ? '⚠️  EXPIRED' : '✅ Active';
      const tier = t.tier || 'public';
      const topics = t.allowed_topics || ['chat'];
      console.log(`${status}  ${t.id}`);
      console.log(`   Name: ${t.name}`);
      console.log(`   Tier: ${tier} → ${topics.join(', ')}`);
      console.log(`   Expires: ${t.expires_at || 'never'}`);
      console.log(`   Calls: ${t.calls_made}${t.max_calls ? '/' + t.max_calls : ''}`);
      console.log();
    }
  },

  revoke: (args) => {
    const id = args._[1];
    if (!id) {
      console.error('Usage: a2a revoke <token_id>');
      process.exit(1);
    }

    const result = store.revoke(id);
    if (!result.success) {
      console.error(`Token not found: ${id}`);
      process.exit(1);
    }

    console.log(`✅ Token revoked: ${result.record.name} (${result.record.id})`);
  },

  add: (args) => {
    const url = args._[1];
    const name = args._[2] || args.flags.name;
    
    if (!url) {
      console.error('Usage: a2a add <invite_url> [name]');
      process.exit(1);
    }

    try {
      const result = store.addContact(url, { name });
      if (!result.success) {
        console.log(`Contact already registered: ${result.existing.name}`);
        return;
      }
      console.log(`✅ Contact added: ${result.contact.name} (${result.contact.host})`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  },

  remotes: () => {
    // Alias for contacts
    commands.contacts({ _: ['contacts'], flags: {} });
  },

  contacts: (args) => {
    const subcommand = args._[1];
    
    // Sub-commands
    if (subcommand === 'add') return commands['contacts:add'](args);
    if (subcommand === 'show') return commands['contacts:show'](args);
    if (subcommand === 'edit') return commands['contacts:edit'](args);
    if (subcommand === 'ping') return commands['contacts:ping'](args);
    if (subcommand === 'link') return commands['contacts:link'](args);
    if (subcommand === 'rm' || subcommand === 'remove') return commands['contacts:rm'](args);

    // Default: list contacts
    const contacts = store.listContacts();
    if (contacts.length === 0) {
      console.log('📇 No contacts yet.\n');
      console.log('Add one with: a2a contacts add <invite_url>');
      return;
    }

    console.log(`📇 Agent Contacts (${contacts.length})\n`);
    for (const r of contacts) {
      const statusIcon = r.status === 'online' ? '🟢' : r.status === 'offline' ? '🔴' : '⚪';
      const ownerText = r.owner ? ` — ${r.owner}` : '';
      
      // Permission badge from linked token (what YOU gave THEM)
      let permBadge = '';
      if (r.linked_token) {
        const tier = r.linked_token.tier || 'public';
        permBadge = tier === 'family' ? ' ⚡' : tier === 'friends' ? ' 🔧' : ' 🌐';
      }
      
      console.log(`${statusIcon} ${r.name}${ownerText}${permBadge}`);
      if (r.tags && r.tags.length > 0) {
        console.log(`   🏷️  ${r.tags.join(', ')}`);
      }
      if (r.last_seen) {
        const ago = formatTimeAgo(new Date(r.last_seen));
        console.log(`   📍 Last seen: ${ago}`);
      }
      console.log();
    }
    
    console.log('Legend: 🌐 public  🔧 friends  ⚡ family');
  },

  'contacts:add': (args) => {
    const url = args._[2];
    if (!url) {
      console.error('Usage: a2a contacts add <invite_url> [options]');
      console.error('Options:');
      console.error('  --name, -n     Agent name');
      console.error('  --owner, -o    Owner name');
      console.error('  --server-name  Server label (optional)');
      console.error('  --notes        Notes about this contact');
      console.error('  --tags         Comma-separated tags');
      console.error('  --link         Link to token ID you gave them');
      process.exit(1);
    }

    const options = {
      name: args.flags.name || args.flags.n,
      owner: args.flags.owner || args.flags.o,
      server_name: args.flags['server-name'] || args.flags.server_name || args.flags.serverName || null,
      notes: args.flags.notes,
      tags: args.flags.tags ? args.flags.tags.split(',').map(t => t.trim()) : [],
      linkedTokenId: args.flags.link || null
    };

    try {
      const result = store.addContact(url, options);
      if (!result.success) {
        console.log(`Contact already exists: ${result.existing.name}`);
        return;
      }
      console.log(`✅ Contact added: ${result.contact.name}`);
      if (result.contact.owner) console.log(`   Owner: ${result.contact.owner}`);
      if (result.contact.server_name) console.log(`   Server: ${result.contact.server_name}`);
      console.log(`   Host: ${result.contact.host}`);
      if (options.linkedTokenId) {
        console.log(`   Linked to token: ${options.linkedTokenId}`);
      } else {
        console.log(`\n💡 Link a token: a2a contacts link ${result.contact.name} <token_id>`);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  },

  'contacts:show': (args) => {
    const name = args._[2];
    if (!name) {
      console.error('Usage: a2a contacts show <name>');
      process.exit(1);
    }

    // Get contact with linked token info
    const contacts = store.listContacts();
    const remote = contacts.find(r => r.name === name || r.id === name);
    if (!remote) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    const statusIcon = remote.status === 'online' ? '🟢' : remote.status === 'offline' ? '🔴' : '⚪';

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`${statusIcon} ${remote.name}`);
    console.log(`${'═'.repeat(50)}\n`);
    
    if (remote.owner) console.log(`👤 Owner: ${remote.owner}`);
    console.log(`🌐 Host: ${remote.host}`);
    
    // Show linked token (permissions you gave them)
    if (remote.linked_token) {
      const t = remote.linked_token;
      const tier = t.tier || 'public';
      const topics = t.allowed_topics || ['chat'];
      const tierIcon = tier === 'family' ? '⚡' : tier === 'friends' ? '🔧' : '🌐';
      console.log(`🔐 Your token to them: ${t.id}`);
      console.log(`   Tier: ${tierIcon} ${tier}`);
      console.log(`   Topics: ${topics.join(', ')}`);
      console.log(`   Calls: ${t.calls_made}${t.max_calls ? '/' + t.max_calls : ''}`);
      if (t.revoked) console.log(`   ⚠️  REVOKED`);
    } else {
      console.log(`🔐 No linked token (you haven't given them access yet)`);
    }
    
    if (remote.tags && remote.tags.length > 0) {
      console.log(`🏷️  Tags: ${remote.tags.join(', ')}`);
    }
    if (remote.notes) {
      console.log(`📝 Notes: ${remote.notes}`);
    }
    
    console.log(`\n📅 Added: ${new Date(remote.added_at).toLocaleDateString()}`);
    if (remote.last_seen) {
      console.log(`📍 Last seen: ${formatTimeAgo(new Date(remote.last_seen))}`);
    }
    if (remote.last_check) {
      console.log(`🔄 Last check: ${formatTimeAgo(new Date(remote.last_check))}`);
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Quick actions:`);
    console.log(`  a2a contacts ping ${name}`);
    console.log(`  a2a call ${name} "Hello!"`);
    if (!remote.linked_token) {
      console.log(`  a2a contacts link ${name} <token_id>`);
    }
    console.log(`${'─'.repeat(50)}\n`);
  },

  'contacts:edit': (args) => {
    const name = args._[2];
    if (!name) {
      console.error('Usage: a2a contacts edit <name> [options]');
      console.error('Options:');
      console.error('  --name         New name');
      console.error('  --owner        Owner name');
      console.error('  --server-name  Server label');
      console.error('  --notes        Notes');
      console.error('  --tags         Comma-separated tags');
      process.exit(1);
    }

    const updates = {};
    if (args.flags.name) updates.name = args.flags.name;
    if (args.flags.owner) updates.owner = args.flags.owner;
    if (args.flags['server-name'] || args.flags.server_name || args.flags.serverName) updates.server_name = args.flags['server-name'] || args.flags.server_name || args.flags.serverName;
    if (args.flags.notes) updates.notes = args.flags.notes;
    if (args.flags.tags) updates.tags = args.flags.tags.split(',').map(t => t.trim());

    if (Object.keys(updates).length === 0) {
      console.error('No updates specified. Use --name, --owner, --notes, or --tags');
      process.exit(1);
    }

    const result = store.updateContact(name, updates);
    if (!result.success) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    console.log(`✅ Contact updated: ${(result.contact || result.remote).name}`);
  },

  'contacts:link': (args) => {
    const contactName = args._[2];
    const tokenId = args._[3];
    
    if (!contactName || !tokenId) {
      console.error('Usage: a2a contacts link <contact_name> <token_id>');
      console.error('\nLinks a token you created to a contact, showing what access they have.');
      console.error('\nExample:');
      console.error('  a2a contacts link Alice tok_abc123');
      process.exit(1);
    }

    const result = store.linkTokenToContact(contactName, tokenId);
    if (!result.success) {
      if (result.error === 'contact_not_found') {
        console.error(`Contact not found: ${contactName}`);
      } else if (result.error === 'token_not_found') {
        console.error(`Token not found: ${tokenId}`);
      }
      process.exit(1);
    }

    const permLabel = result.token.tier === 'family' ? '⚡ family' :
                      result.token.tier === 'friends' ? '🔧 friends' : '🌐 public';
    
    console.log(`✅ Linked token to contact`);
    console.log(`   Contact: ${result.contact?.name || result.remote.name}`);
    console.log(`   Token: ${result.token.id} (${result.token.name})`);
    console.log(`   Permissions: ${permLabel}`);
  },

  'contacts:ping': async (args) => {
    const name = args._[2];
    if (!name) {
      console.error('Usage: a2a contacts ping <name>');
      process.exit(1);
    }

    const remote = store.getContact(name);
    if (!remote) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    const client = new A2AClient({});
    const url = `a2a://${remote.host}/${remote.token}`;

    console.log(`🔍 Pinging ${remote.name}...`);

    try {
      const result = await client.ping(url);
      store.updateContactStatus(name, 'online');
      console.log(`🟢 ${remote.name} is online`);
      console.log(`   Agent: ${result.name}`);
      console.log(`   Version: ${result.version}`);
    } catch (err) {
      store.updateContactStatus(name, 'offline', err.message);
      console.log(`🔴 ${remote.name} is offline`);
      console.log(`   Error: ${err.message}`);
    }
  },

  'contacts:rm': (args) => {
    const name = args._[2];
    if (!name) {
      console.error('Usage: a2a contacts rm <name>');
      process.exit(1);
    }

    const result = store.removeContact(name);
    if (!result.success) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    console.log(`✅ Contact removed: ${(result.contact || result.remote).name}`);
  },

  // ========== CONVERSATIONS ==========

  conversations: (args) => {
    const subcommand = args._[1];
    
    if (subcommand === 'show') return commands['conversations:show'](args);
    if (subcommand === 'end') return commands['conversations:end'](args);

    // Default: list conversations
    const cs = getConvStore();
    if (!cs) {
      console.log('💬 Conversation storage not available.');
      console.log('Install: npm install better-sqlite3');
      return;
    }

    const { contact, status, limit = 20 } = args.flags;
    const conversations = cs.listConversations({
      contactId: contact,
      status,
      limit: parseInt(limit),
      includeMessages: true,
      messageLimit: 1
    });

    if (conversations.length === 0) {
      console.log('💬 No conversations yet.');
      return;
    }

    console.log(`💬 Conversations (${conversations.length})\n`);
    for (const conv of conversations) {
      const statusIcon = conv.status === 'concluded' ? '✅' : conv.status === 'timeout' ? '⏱️' : '💬';
      const timeAgo = formatTimeAgo(new Date(conv.last_message_at));
      const preview = conv.messages?.[0]?.content?.slice(0, 50) || '';
      
      console.log(`${statusIcon} ${conv.id}`);
      console.log(`   Contact: ${conv.contact_name || conv.contact_id || 'unknown'}`);
      console.log(`   Messages: ${conv.message_count} | ${timeAgo}`);
      if (conv.summary) {
        console.log(`   Summary: ${conv.summary.slice(0, 80)}...`);
      } else if (preview) {
        console.log(`   Preview: "${preview}..."`);
      }
      if (conv.owner_relevance) {
        console.log(`   Relevance: ${conv.owner_relevance}`);
      }
      console.log();
    }
  },

  'conversations:show': (args) => {
    const convId = args._[2];
    if (!convId) {
      console.error('Usage: a2a conversations show <conversation_id>');
      process.exit(1);
    }

    const cs = getConvStore();
    if (!cs) {
      console.error('Conversation storage not available. Install: npm install better-sqlite3');
      process.exit(1);
    }

    const context = cs.getConversationContext(convId, args.flags.messages || 20);
    if (!context) {
      console.error(`Conversation not found: ${convId}`);
      process.exit(1);
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`💬 ${context.id}`);
    console.log(`${'═'.repeat(60)}\n`);

    console.log(`👤 Contact: ${context.contact || 'unknown'}`);
    console.log(`📊 Status: ${context.status}`);
    console.log(`📝 Messages: ${context.messageCount}`);
    console.log(`📅 Started: ${new Date(context.startedAt).toLocaleString()}`);
    if (context.endedAt) {
      console.log(`🏁 Ended: ${new Date(context.endedAt).toLocaleString()}`);
    }

    if (context.summary) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`📋 Summary:\n${context.summary}`);
    }

    if (context.ownerContext) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`🔒 Owner Context (private):`);
      console.log(`   Relevance: ${context.ownerContext.relevance || 'unknown'}`);
      if (context.ownerContext.summary) {
        console.log(`   Summary: ${context.ownerContext.summary}`);
      }
      if (context.ownerContext.goalsTouched?.length) {
        console.log(`   Goals: ${context.ownerContext.goalsTouched.join(', ')}`);
      }
      if (context.ownerContext.actionItems?.length) {
        console.log(`   Actions: ${context.ownerContext.actionItems.join(', ')}`);
      }
      if (context.ownerContext.followUp) {
        console.log(`   Follow-up: ${context.ownerContext.followUp}`);
      }
      if (context.ownerContext.notes) {
        console.log(`   Notes: ${context.ownerContext.notes}`);
      }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Recent messages:`);
    console.log(`${'─'.repeat(60)}`);
    for (const msg of context.recentMessages) {
      const role = msg.direction === 'inbound' ? '← In' : '→ Out';
      const time = new Date(msg.timestamp).toLocaleTimeString();
      console.log(`\n[${time}] ${role}:`);
      console.log(msg.content);
    }
    console.log(`\n${'═'.repeat(60)}\n`);
  },

  'conversations:end': async (args) => {
    const convId = args._[2];
    if (!convId) {
      console.error('Usage: a2a conversations end <conversation_id>');
      process.exit(1);
    }

    const cs = getConvStore();
    if (!cs) {
      console.error('Conversation storage not available');
      process.exit(1);
    }

    // For now, conclude without LLM summarizer
    const result = await cs.concludeConversation(convId, {});
    
    if (!result.success) {
      console.error(`Failed to end conversation: ${result.error}`);
      process.exit(1);
    }

    console.log(`✅ Conversation concluded: ${convId}`);
    if (result.summary) {
      console.log(`📋 Summary: ${result.summary}`);
    }
  },

  call: async (args) => {
    checkOnboarding('call');
    let target = args._[1];
    const message = args._.slice(2).join(' ') || args.flags.message || args.flags.m;

    if (!target || !message) {
      console.error('Usage: a2a call <contact_or_url> <message>');
      process.exit(1);
    }

    // Check if target is a contact name (not a URL)
    let url = target;
    let contactName = null;
    if (!target.startsWith('a2a://')) {
      const remote = store.getContact(target);
      if (remote) {
        url = `a2a://${remote.host}/${remote.token}`;
        contactName = remote.name;
      }
    }

    const client = new A2AClient({
      caller: { name: args.flags.name || 'CLI User' }
    });

    try {
      console.log(`📞 Calling ${contactName || url}...`);
      const response = await client.call(url, message);
      
      // Update contact status on success
      if (contactName) {
        store.updateContactStatus(contactName, 'online');
      }
      
      console.log(`\n✅ Response:\n`);
      console.log(response.response);
      if (response.conversation_id) {
        console.log(`\n📝 Conversation ID: ${response.conversation_id}`);
      }
    } catch (err) {
      // Update contact status on failure
      if (contactName) {
        store.updateContactStatus(contactName, 'offline', err.message);
      }
      console.error(`❌ Call failed: ${err.message}`);
      process.exit(1);
    }
  },

  ping: async (args) => {
    const url = args._[1];
    if (!url) {
      console.error('Usage: a2a ping <invite_url>');
      process.exit(1);
    }

    const client = new A2AClient();
    const result = await client.ping(url);
    
    if (result.pong) {
      console.log(`✅ Agent reachable at ${url}`);
      if (result.timestamp) {
        console.log(`   Timestamp: ${result.timestamp}`);
      }
    } else {
      console.log(`❌ Agent not reachable at ${url}`);
      process.exit(1);
    }
  },

  gui: async (args) => {
    // GUI is always safe to open even before onboarding.
    const tab = (args.flags.tab || args.flags.t || '').trim().toLowerCase();
    const allowedTabs = new Set(['contacts', 'calls', 'logs', 'settings', 'invites']);
    const hash = allowedTabs.has(tab) ? `#${tab}` : '';

    const urlFlag = args.flags.url;
    if (urlFlag) {
      const url = String(urlFlag);
      console.log(`Dashboard URL: ${url}`);
      const opened = openInBrowser(url);
      if (opened.attempted) {
        console.log(`Opening browser via: ${opened.command}`);
      } else {
        console.log('Could not auto-open browser.');
      }
      return;
    }

    const preferred = [];
    if (args.flags.port || args.flags.p) preferred.push(args.flags.port || args.flags.p);
    if (process.env.A2A_PORT) preferred.push(process.env.A2A_PORT);
    if (process.env.PORT) preferred.push(process.env.PORT);

    const port = await findLocalServerPort(preferred);
    if (!port) {
      console.log('Dashboard is not reachable on common ports.');
      console.log('Start the server (example):');
      console.log('  A2A_HOSTNAME="localhost:3001" a2a server --port 3001');
      console.log('Then open:');
      console.log('  http://127.0.0.1:3001/dashboard/');
      return;
    }

    const url = `http://127.0.0.1:${port}/dashboard/${hash}`;
    console.log(`Dashboard URL: ${url}`);
    const opened = openInBrowser(url);
    if (opened.attempted) {
      console.log(`Opening browser via: ${opened.command}`);
    } else {
      console.log('Could not auto-open browser; open the URL above manually.');
    }
  },

  dashboard: (args) => {
    // Alias for gui
    return commands.gui(args);
  },

  status: async (args) => {
    const url = args._[1];
    if (!url) {
      console.error('Usage: a2a status <invite_url>');
      process.exit(1);
    }

    const client = new A2AClient();
    try {
      const status = await client.status(url);
      console.log(`A2A status for ${url}:\n`);
      console.log(JSON.stringify(status, null, 2));
    } catch (err) {
      console.error(`❌ Failed to get status: ${err.message}`);
      process.exit(1);
    }
  },

  server: (args) => {
    const explicitPort = args.flags.port || args.flags.p || process.env.PORT;
    if (explicitPort) {
      process.env.PORT = explicitPort;
      console.log(`Starting A2A server on port ${explicitPort}...`);
    } else {
      console.log('Starting A2A server (scanning for available port)...');
    }
    require('../src/server.js');
  },

  quickstart: async (args) => {
    const http = require('http');
    const https = require('https');
    const { A2AConfig } = require('../src/lib/config');
    const disc = require('../src/lib/disclosure');
    const {
      normalizeHostInput,
      splitHostPort,
      isLocalOrUnroutableHost
    } = require('../src/lib/invite-host');
    const { getExternalIp } = require('../src/lib/external-ip');
    const { CallbookStore } = require('../src/lib/callbook');
    const { isPortListening, tryBindPort } = require('../src/lib/port-scanner');

    const workspaceDir = process.env.A2A_WORKSPACE || process.cwd();
    const config = new A2AConfig();

    if (args.flags.force) {
      config.resetOnboarding();
    }

    const backendPort = (() => {
      const raw = args.flags.port || process.env.A2A_PORT || process.env.PORT || 3001;
      const n = Number.parseInt(String(raw), 10);
      return (Number.isFinite(n) && n > 0 && n <= 65535) ? n : 3001;
    })();

    function looksLikePong(body) {
      try {
        const parsed = JSON.parse(String(body || ''));
        if (parsed && typeof parsed === 'object' && parsed.pong === true) return true;
      } catch (err) {
        // ignore
      }
      return String(body || '').includes('"pong":true') || String(body || '').includes('"pong": true');
    }

    function fetchUrlText(url, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        let parsed;
        try {
          parsed = new URL(url);
        } catch (err) {
          reject(new Error('invalid_url'));
          return;
        }
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.request({
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          method: 'GET',
          path: parsed.pathname + parsed.search,
          headers: {
            'User-Agent': `a2acalling/${process.env.npm_package_version || 'dev'} (quickstart)`
          },
          timeout: timeoutMs
        }, (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1024 * 256) {
              req.destroy(new Error('response_too_large'));
            }
          });
          res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
      });
    }

	    async function probeLocalPing(port, timeoutMs = 1000) {
	      try {
	        const res = await fetchUrlText(`http://127.0.0.1:${port}/api/a2a/ping`, timeoutMs);
	        return { ok: looksLikePong(res.body), statusCode: res.statusCode, body: res.body };
	      } catch (err) {
	        return { ok: false, error: err && err.message ? err.message : 'request_failed' };
	      }
	    }

    async function externalPingCheck(targetUrl) {
      const providers = [
        {
          name: 'allorigins',
          buildUrl: () => {
            const u = new URL('https://api.allorigins.win/raw');
            u.searchParams.set('url', targetUrl);
            return u.toString();
          }
        },
        {
          name: 'jina',
          buildUrl: () => `https://r.jina.ai/${targetUrl}`
        }
      ];

      for (const provider of providers) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await fetchUrlText(provider.buildUrl(), 8000);
          if (looksLikePong(res.body)) {
            return { ok: true, provider: provider.name, statusCode: res.statusCode };
          }
        } catch (err) {
          // try next
        }
      }
      return { ok: false };
    }

    function slugify(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    }

    function uniqueNonEmpty(items, limit = 24) {
      const out = [];
      const seen = new Set();
      for (const raw of items) {
        const s = String(raw || '').trim();
        if (!s) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        if (out.length >= limit) break;
      }
      return out;
    }

    function extractSectionBullets(markdown, headingRegex) {
      const text = String(markdown || '');
      const match = text.match(new RegExp(`##\\s*(?:${headingRegex})[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'));
      if (!match) return [];
      return match[1]
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('-') || l.startsWith('*'))
        .map(l => l.replace(/^[\\s\\-\\*]+/, '').trim())
        .filter(Boolean);
    }

    function tierFromManifest(manifest, tier, fallback = []) {
      const t = (manifest && manifest.topics && manifest.topics[tier]) ? manifest.topics[tier] : null;
      if (!t) return fallback;
      const items = []
        .concat(Array.isArray(t.lead_with) ? t.lead_with : [])
        .concat(Array.isArray(t.discuss_freely) ? t.discuss_freely : [])
        .concat(Array.isArray(t.deflect) ? t.deflect : []);
      const topics = items.map(x => (x && x.topic) ? x.topic : '').filter(Boolean);
      return topics.length ? topics : fallback;
    }

    function buildTierRecommendations(contextFiles, manifest) {
      const publicFallback = ['chat', 'openclaw', 'a2a'];
      const friendsFallback = ['chat', 'search', 'openclaw', 'a2a'];
      const familyFallback = ['chat', 'search', 'openclaw', 'a2a', 'tools', 'memory'];

      const rawPublic = tierFromManifest(manifest, 'public', publicFallback);
      const rawFriends = tierFromManifest(manifest, 'friends', friendsFallback);
      const rawFamily = tierFromManifest(manifest, 'family', familyFallback);

      const goalsFromUser = extractSectionBullets(contextFiles.user, 'Goals|Current|Seeking|Working On');
      const baseGoals = goalsFromUser.length
        ? goalsFromUser
        : ['grow network', 'find collaborators', 'build in public'];

      const publicTopics = uniqueNonEmpty(rawPublic.map(slugify).filter(Boolean), 16);
      const friendsTopics = uniqueNonEmpty(rawFriends.map(slugify).filter(Boolean), 20);
      const familyTopics = uniqueNonEmpty(rawFamily.map(slugify).filter(Boolean), 24);

      const goals = uniqueNonEmpty(baseGoals.map(slugify).filter(Boolean), 12);

      return {
        public: { topics: publicTopics, goals: goals.slice(0, 6) },
        friends: { topics: uniqueNonEmpty([...publicTopics, ...friendsTopics], 24), goals: goals.slice(0, 8) },
        family: { topics: uniqueNonEmpty([...publicTopics, ...friendsTopics, ...familyTopics], 30), goals }
      };
    }

    function printTierSummary(tiers) {
      const format = (t) => {
        const topics = (t.topics || []).join(' · ') || '(none)';
        const goals = (t.goals || []).join(' · ') || '(none)';
        return `Topics: ${topics}\nGoals:  ${goals}`;
      };
      console.log('\nProposed permission tiers:\n');
      console.log('PUBLIC');
      console.log(format(tiers.public));
      console.log('\nFRIENDS');
      console.log(format(tiers.friends));
      console.log('\nFAMILY');
      console.log(format(tiers.family));
      console.log('');
    }

    // ── Step 1: Background bootstrap (config + manifest) ─────────
    let contextFiles = {};
    let manifest = {};
	    try {
	      contextFiles = disc.readContextFiles(workspaceDir);
	      const forceManifest = Boolean(args.flags.force || args.flags['regen-manifest'] || args.flags.regenManifest);
	      if (forceManifest) {
	        const generated = disc.generateDefaultManifest(contextFiles);
	        disc.saveManifest(generated);
	        manifest = generated;
	      } else {
	        manifest = disc.loadManifest();
	        if (!manifest || Object.keys(manifest).length === 0) {
	          const generated = disc.generateDefaultManifest(contextFiles);
	          disc.saveManifest(generated);
	          manifest = generated;
	        }
	      }
	    } catch (err) {
	      // Non-fatal: onboarding can proceed even if manifest fails.
	      contextFiles = {};
	      manifest = {};
	    }

    console.log('\nA2A deterministic onboarding');
    console.log('──────────────────────────');

    // ── Step 2: Owner dashboard access (local + optional remote) ─
    config.setOnboarding({ step: 'access' });

    const hostnameFlagRaw = args.flags.hostname !== undefined ? String(args.flags.hostname) : '';
    const normalizedHostname = normalizeHostInput(hostnameFlagRaw);

    // Invite host controls the a2a:// hostname we hand out (and remote dashboard pairing URL).
    let inviteHost = '';
    if (normalizedHostname) {
      const parsed = splitHostPort(normalizedHostname);
      const publicPortRaw = args.flags['public-port'] || args.flags.publicPort || process.env.A2A_PUBLIC_PORT || 443;
      const publicPort = Number.parseInt(String(publicPortRaw), 10);
      inviteHost = parsed.port
        ? normalizedHostname
        : `${parsed.hostname}:${(Number.isFinite(publicPort) && publicPort > 0 && publicPort <= 65535) ? publicPort : 443}`;
      config.setAgent({ hostname: inviteHost });
    } else {
      const existing = normalizeHostInput((config.getAgent() || {}).hostname || '');
      inviteHost = existing || `localhost:${backendPort}`;
      if (!existing) {
        config.setAgent({ hostname: inviteHost });
      }
    }

    const inviteParsed = splitHostPort(inviteHost);
    const invitePort = inviteParsed.port;
    const schemeOverride = String(process.env.A2A_PUBLIC_SCHEME || '').trim();
    const inviteScheme = schemeOverride || ((!invitePort || invitePort === 443) ? 'https' : 'http');
    const expectedPingUrl = `${inviteScheme}://${inviteHost}/api/a2a/ping`;
    const inviteLooksLocal = isLocalOrUnroutableHost(inviteParsed.hostname);

    console.log('\n2️⃣  Owner dashboard access');
    console.log(`Local dashboard: http://127.0.0.1:${backendPort}/dashboard/`);
    console.log(`Invite host:      ${inviteHost}`);

    if (inviteLooksLocal) {
      console.log('Remote dashboard: not configured (invite host looks local/unroutable)');
      console.log('  To enable remote access, rerun with: --hostname YOUR_DOMAIN:443');
    } else {
      const callbookStore = new CallbookStore();
      if (!callbookStore.isAvailable()) {
        console.log('Remote dashboard: Callbook Remote not available (storage unavailable)');
        console.log(`  Hint: ${callbookStore.getDbError ? callbookStore.getDbError() : 'storage_unavailable'}`);
      } else {
        const label = String(args.flags['device-label'] || args.flags.deviceLabel || 'Callbook Remote').trim().slice(0, 120);
        const ttlHoursRaw = args.flags['callbook-ttl-hours'] || args.flags.callbookTtlHours || 24;
        const ttlHours = Math.max(1, Math.min(168, Number.parseInt(String(ttlHoursRaw), 10) || 24));
        const created = callbookStore.createProvisionCode({ label, ttlMs: ttlHours * 60 * 60 * 1000 });
        if (created && created.success) {
          const installUrl = `${inviteScheme}://${inviteHost}/callbook/install#code=${created.code}`;
          console.log(`Remote dashboard: ${installUrl}  (one-time, ${ttlHours}h)`);
        } else {
          console.log('Remote dashboard: failed to create install link');
          console.log(`  Hint: ${created && created.message ? created.message : (created && created.error ? created.error : 'unknown_error')}`);
        }
      }
    }

	    // ── Step 3: Permission tiers (topics + goals) ───────────────
	    const onboardingAfterAccess = config.getOnboarding();
	    if (!onboardingAfterAccess.tiers_confirmed) {
	      const recommendations = buildTierRecommendations(contextFiles, manifest);

	      const parseFreeTextList = (raw) => {
	        if (raw === undefined || raw === null || raw === true) return [];
	        const text = String(raw || '').trim();
	        if (!text) return [];
	        return text
	          .split(/[\n,]+/g)
	          .map(s => s.trim())
	          .filter(Boolean);
	      };

	      const promptLine = async (question) => {
	        const readline = require('readline');
	        return await new Promise(resolve => {
	          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	          rl.question(question, (answer) => {
	            rl.close();
	            resolve(String(answer || '').trim());
	          });
	        });
	      };

	      // Optional owner override: Friends tier topics/interests (most important tier).
	      const interactive = Boolean(
	        args.flags.interactive ||
	        args.flags['ask-friends-topics'] ||
	        args.flags.askFriendsTopics
	      );
	      let friendsTopicsOverride = parseFreeTextList(args.flags['friends-topics'] || args.flags.friendsTopics);
	      const noWorkspaceContext = !contextFiles.user && !contextFiles.heartbeat && !contextFiles.soul &&
	        !contextFiles.memory && !contextFiles.claude;
	      const shouldPromptFriendsTopics = (interactive || noWorkspaceContext) &&
	        friendsTopicsOverride.length === 0 &&
	        process.stdin.isTTY &&
	        process.stdout.isTTY;
	      if (shouldPromptFriendsTopics) {
	        const suggested = (recommendations.friends.topics || []).slice(0, 12).join(', ');
	        const answer = await promptLine(`Friends-tier topics/interests (comma-separated).\nSuggested: ${suggested}\n> `);
	        friendsTopicsOverride = parseFreeTextList(answer);
	      }

	      if (friendsTopicsOverride.length > 0) {
	        const normalized = uniqueNonEmpty(friendsTopicsOverride.map(slugify).filter(Boolean), 24);
	        recommendations.friends.topics = uniqueNonEmpty(
	          [...(recommendations.public.topics || []), ...normalized],
	          24
	        );
	        recommendations.family.topics = uniqueNonEmpty(
	          [...(recommendations.friends.topics || []), ...(recommendations.family.topics || [])],
	          30
	        );
	      }

	      try {
	        config.setTier('public', recommendations.public);
	        config.setTier('friends', recommendations.friends);
	        config.setTier('family', recommendations.family);
	      } catch (err) {
	        console.error('\n❌ Tier configuration validation failed.');
	        console.error(`   ${err.message}`);
	        if (err.hint) {
	          console.error(`   Hint: ${err.hint}`);
	        }
	        console.error('');
	        process.exit(1);
	      }

	      printTierSummary(recommendations);

	      config.setOnboarding({
	        step: 'tiers',
	        tiers_confirmed: true
	      });
	    }

    // ── Step 4: Port scan + reverse proxy guidance (if needed) ──
    console.log('\n4️⃣  Port scan + reverse proxy');
    console.log(`Invite host: ${inviteHost}`);
    console.log(`Expected ping URL: ${expectedPingUrl}\n`);

    const expectsReverseProxy = Boolean(
      (invitePort === 80 && backendPort !== 80) ||
      ((!invitePort || invitePort === 443) && backendPort !== 443)
    );

    if (expectsReverseProxy) {
      const port80Listening = await isPortListening(80, '127.0.0.1', { timeoutMs: 500 });
      const port80Bind = await tryBindPort(80, '0.0.0.0');
      const port80Ping = port80Listening.listening ? await probeLocalPing(80) : { ok: false };

      console.log('Port 80:');
      if (port80Ping.ok) {
        console.log('  ✅ serves /api/a2a/ping (A2A detected on :80)');
      } else if (port80Listening.listening) {
        console.log(`  ⚠️  has a listener (${port80Listening.code || 'in_use'})`);
      } else if (!port80Bind.ok && port80Bind.code === 'EACCES') {
        console.log('  ⚠️  appears free but is not bindable by this user (EACCES)');
      } else if (port80Bind.ok) {
        console.log('  ✅ free and bindable by this user');
      } else {
        console.log(`  ⚠️  not bindable (${port80Bind.code || 'unknown'})`);
      }

      console.log('\nReverse proxy required (example routes):');
      console.log(`  /api/a2a/*   -> http://127.0.0.1:${backendPort}`);
      console.log(`  /dashboard/* -> http://127.0.0.1:${backendPort}`);
      console.log(`  /callbook/*  -> http://127.0.0.1:${backendPort}`);
	      console.log('');
	      console.log('If you have configured your reverse proxy and want to continue, run:');
	      console.log(`  a2a quickstart --hostname ${inviteHost} --port ${backendPort} --confirm-ingress`);
	      console.log('');
	      if (!args.flags['confirm-ingress']) {
	        return;
	      }
    } else {
      console.log('✅ No reverse proxy required based on invite host/port.');
    }

    if (!config.getOnboarding().ingress_confirmed) {
      config.setOnboarding({
        step: 'ingress',
        ingress_confirmed: true
      });
    }

    // ── Step 5: External IP + reachability check ───────────────
    console.log('\n5️⃣  External IP + reachability check');

    if (inviteLooksLocal) {
      console.log('Skipping external IP probe: invite host looks local/unroutable.');
    } else {
      const external = await getExternalIp({ forceRefresh: true });
      if (external && external.ip) {
        console.log(`External IP (${external.source || 'resolver'}): ${external.ip}`);
      } else {
        console.log(`External IP lookup failed: ${external && external.error ? external.error : 'unknown_error'}`);
      }
    }

	    const localListener = await isPortListening(backendPort, '127.0.0.1', { timeoutMs: 500 });
	    if (!localListener.listening) {
	      console.log('\n⚠️  A2A server is not reachable locally yet.');
	      console.log('Start it, then rerun quickstart:');
	      console.log(`  A2A_HOSTNAME="${inviteHost}" a2a server --port ${backendPort}`);
	      console.log('');
	      return;
	    }
	    const localPing = await probeLocalPing(backendPort, inviteLooksLocal ? 250 : 1000);
	    if (!localPing.ok) {
	      if (inviteLooksLocal) {
	        console.log(`\n⚠️  Port ${backendPort} is listening but /api/a2a/ping did not respond within a short timeout.`);
	        console.log('Continuing onboarding anyway (invite host is local/unroutable).');
	      } else {
	        console.log('\n⚠️  A2A server is not responding locally yet.');
	        console.log('Start it, then rerun quickstart:');
	        console.log(`  A2A_HOSTNAME="${inviteHost}" a2a server --port ${backendPort}`);
	        console.log('');
	        return;
	      }
	    }

    if (inviteLooksLocal) {
      console.log('Skipping external reachability check: invite host looks local/unroutable.');
    } else {
      const extPing = await externalPingCheck(expectedPingUrl);
      if (extPing.ok) {
        console.log(`✅ External ping OK (${extPing.provider})`);
	      } else if (!args.flags['skip-verify']) {
	        console.log('⚠️  External ping FAILED (server may not be publicly reachable yet).');
	        console.log('Fix ingress (DNS/reverse proxy/firewall), then rerun with:');
	        console.log(`  a2a quickstart --hostname ${inviteHost} --port ${backendPort} --confirm-ingress`);
	        console.log('');
	        return;
	      } else {
        console.log('⚠️  External ping FAILED (skipped via --skip-verify).');
      }
    }

    if (!config.getOnboarding().verify_confirmed) {
      config.setOnboarding({
        step: 'verify',
        verify_confirmed: true
      });
    }

    config.completeOnboarding();
    console.log('✅ Onboarding complete.');
    console.log('Next: a2a gui   or   a2a create   or   a2a server');
  },

  install: () => {
    require('../scripts/install-openclaw.js');
  },

  setup: () => {
    require('../scripts/install-openclaw.js');
  },

  update: async (args) => {
    const { execSync } = require('child_process');
    const path = require('path');
    const pkg = require('../package.json');
    const currentVersion = pkg.version;
    const checkOnly = args.flags.check || args.flags.c;

    console.log(`\n📦 A2A Update\n${'─'.repeat(50)}\n`);
    console.log(`   Installed: v${currentVersion}`);

    // Detect install method
    const pkgRoot = path.resolve(__dirname, '..');
    const isGitRepo = require('fs').existsSync(path.join(pkgRoot, '.git'));

    if (isGitRepo) {
      // Git clone — use git pull
      console.log(`   Source:    git (${pkgRoot})\n`);

      if (checkOnly) {
        try {
          execSync('git fetch --quiet', { cwd: pkgRoot, stdio: 'pipe' });
          const behind = execSync('git rev-list HEAD..@{u} --count', { cwd: pkgRoot, encoding: 'utf8' }).trim();
          if (behind === '0') {
            console.log('   \u2705 Already up to date.\n');
          } else {
            console.log(`   \u2b06\ufe0f  ${behind} commit(s) behind. Run "a2a update" to pull.\n`);
          }
        } catch (e) {
          console.log('   \u26a0\ufe0f  Could not check remote (no upstream or network error).\n');
        }
        return;
      }

      console.log('   Pulling latest...');
      try {
        const output = execSync('git pull --ff-only 2>&1', { cwd: pkgRoot, encoding: 'utf8' });
        console.log(`   ${output.trim()}\n`);
      } catch (e) {
        const stderr = e.stderr ? e.stderr.toString() : e.message;
        console.error(`   \u274c Git pull failed: ${stderr.trim()}`);
        console.error('   Try: cd ' + pkgRoot + ' && git pull manually.\n');
        process.exit(1);
      }

      // Re-install deps if package.json changed
      console.log('   Installing dependencies...');
      try {
        execSync('npm install --production 2>&1', { cwd: pkgRoot, encoding: 'utf8', timeout: 120000 });
      } catch (e) {
        console.warn('   \u26a0\ufe0f  npm install had warnings (non-fatal).');
      }
    } else {
      // npm global install — use npm update
      console.log('   Source:    npm global\n');

      // Check latest version on npm
      let latestVersion;
      try {
        latestVersion = execSync('npm view a2acalling version 2>/dev/null', { encoding: 'utf8', timeout: 15000 }).trim();
        console.log(`   Latest:    v${latestVersion}`);
      } catch (e) {
        console.error('   \u274c Could not check npm registry. Check your network.\n');
        process.exit(1);
      }

      if (latestVersion === currentVersion) {
        console.log('\n   \u2705 Already up to date.\n');
        return;
      }

      if (checkOnly) {
        console.log(`\n   \u2b06\ufe0f  Update available: v${currentVersion} \u2192 v${latestVersion}`);
        console.log('   Run "a2a update" to install.\n');
        return;
      }

      console.log(`\n   Updating v${currentVersion} \u2192 v${latestVersion}...`);
      try {
        execSync('npm install -g a2acalling@latest 2>&1', { encoding: 'utf8', timeout: 120000 });
        console.log('   \u2705 npm package updated.\n');
      } catch (e) {
        const stderr = e.stderr ? e.stderr.toString() : e.message;
        console.error(`   \u274c npm update failed: ${stderr.trim()}`);
        console.error('   Try: npm install -g a2acalling@latest manually.\n');
        process.exit(1);
      }
    }

    // Re-run install to sync SKILL.md and config
    console.log('   Syncing SKILL.md and config...');
    try {
      const installScript = path.join(pkgRoot, 'scripts', 'install-openclaw.js');
      execSync(`node "${installScript}" install 2>&1`, { encoding: 'utf8', timeout: 30000 });
    } catch (e) {
      console.warn('   \u26a0\ufe0f  Post-update install sync had warnings (non-fatal).');
    }

    // Show new version
    try {
      delete require.cache[require.resolve('../package.json')];
      const newPkg = require('../package.json');
      console.log(`\n   \u2705 Updated to v${newPkg.version}\n`);
    } catch (e) {
      console.log('\n   \u2705 Update complete.\n');
    }
  },

	  onboard: (args) => {
	    const { A2AConfig } = require('../src/lib/config');
	    const { readContextFiles, generateDefaultManifest, saveManifest, MANIFEST_FILE } = require('../src/lib/disclosure');
	    const config = new A2AConfig();
	
	    if (config.isOnboarded() && !args.flags.force) {
	      console.log('\u2705 Onboarding already complete. Use --force to regenerate the disclosure manifest.');
	      return;
	    }

    const workspaceDir = process.env.A2A_WORKSPACE || process.cwd();
    console.log('\n\ud83d\ude80 A2A Onboarding\n' + '\u2550'.repeat(50) + '\n');
    console.log('Scanning workspace for context...\n');

    const contextFiles = readContextFiles(workspaceDir);
    // Print what was found
	    const sources = {
	      'USER.md': contextFiles.user,
	      'HEARTBEAT.md': contextFiles.heartbeat,
	      'SOUL.md': contextFiles.soul,
	      'SKILL.md': contextFiles.skill,
	      'CLAUDE.md': contextFiles.claude,
	      'memory/*.md': contextFiles.memory
	    };
    for (const [name, content] of Object.entries(sources)) {
      console.log(`   ${content ? '\u2705' : '\u274c'} ${name}`);
    }

    const manifest = generateDefaultManifest(contextFiles);
    saveManifest(manifest);

    const agentName = args.flags.name || config.getAgent().name || process.env.A2A_AGENT_NAME || '';
    const hostname = args.flags.hostname || config.getAgent().hostname || process.env.A2A_HOSTNAME || '';
	    if (agentName) config.setAgent({ name: agentName });
	    if (hostname) config.setAgent({ hostname });

	    console.log(`\n\u2705 Disclosure manifest generated.`);
	    console.log(`   Manifest: ${MANIFEST_FILE}`);
	    console.log('   Next: a2a quickstart\n');
	  },

  help: () => {
    console.log(`A2A Calling - Agent-to-Agent Communication

Usage: a2a <command> [options]

Commands:
  create              Create an A2A token
    --name, -n        Token/agent name
    --owner, -o       Owner name (human behind the agent)
    --expires, -e     Expiration (1h, 1d, 7d, 30d, never)
    --permissions, -p Tier (public, friends, family)
    --topics          Custom topics (comma-separated, overrides tier defaults)
    --disclosure, -d  Disclosure level (public, minimal, none)
    --notify          Owner notification (all, summary, none)
    --max-calls       Maximum invocations (default: 100)
    --link, -l        Auto-link to contact name

  list                List active tokens
  revoke <id>         Revoke a token

Contacts:
  contacts            List all contacts (shows permission badges)
  contacts add <url>  Add a contact
    --name, -n        Agent name
    --owner, -o       Owner name
    --server-name     Server label (optional)
    --notes           Notes about this contact
    --tags            Comma-separated tags
    --link            Link to token ID you gave them
  contacts show <n>   Show contact details + linked token
  contacts edit <n>   Edit contact metadata
    --server-name     Server label (optional)
  contacts link <n> <tok>  Link a token to a contact
  contacts ping <n>   Ping contact, update status
  contacts rm <n>     Remove contact

Permission badges: 🌐 public  🔧 friends  ⚡ family

Conversations:
  conversations       List all conversations
    --contact         Filter by contact
    --status          Filter by status (active, concluded, timeout)
    --limit           Max results (default: 20)
  conversations show <id>  Show conversation with messages
    --messages        Number of recent messages (default: 20)
  conversations end <id>   End and summarize conversation

Calling:
  call <contact|url> <msg>  Call a contact (or invite URL)
  ping <url>          Check if agent is reachable
  status <url>        Get A2A status
  gui                 Open the local dashboard GUI in a browser
    --tab, -t         Optional: contacts|calls|logs|settings|invites

Server:
  server              Start the A2A server
    --port, -p        Port to listen on (default: 3001)
  
  quickstart          Onboarding (access → tiers → ingress → verify)
    --hostname        Public hostname for remote access (e.g. myserver.com:443)
    --public-port     Port to assume when --hostname omits a port (default: 443)
    --port            A2A server port to run locally (default: 3001)
    --friends-topics  Override Friends tier topics/interests (comma or newline-separated)
    --interactive     Prompt for Friends tier topics if needed
    --confirm-ingress Confirm reverse proxy/ingress is configured and continue
    --skip-verify     Skip external reachability check (not recommended)
    --force           Reset onboarding + regenerate disclosure manifest
    --regen-manifest  Regenerate disclosure manifest (no onboarding reset)
  
  onboard             Generate disclosure manifest from workspace context
    --force           Re-run even if already onboarded
    --name            Agent name
    --hostname        Agent hostname

  update              Update A2A to latest version (npm or git pull)
    --check, -c       Check for updates without installing

  install             Install A2A for OpenClaw
  setup               Auto setup (gateway-aware dashboard install)

Examples:
  a2a create --name "bappybot" --owner "Benjamin Pollack" --expires 7d
  a2a create --name "custom" --topics "chat,calendar.read,email.read"
  a2a contacts add a2a://host/fed_xxx --name "Alice" --owner "Alice Chen"
  a2a contacts link Alice tok_abc123
  a2a call Alice "Hello!"
  a2a conversations show conv_abc123
  a2a server --port 3001
`);
  }
};

// Main
const args = parseArgs(process.argv);
const command = args._[0] || 'help';

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.log('Run "a2a help" for usage.');
  process.exit(1);
}

// Handle async commands
const result = commands[command](args);
if (result instanceof Promise) {
  result.catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
