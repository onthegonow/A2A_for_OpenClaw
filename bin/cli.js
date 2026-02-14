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
 *   a2a uninstall            Stop server and remove local A2A config
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { TokenStore } = require('../src/lib/tokens');
const { A2AClient } = require('../src/lib/client');

const CONFIG_PATH = path.join(os.homedir(), '.config', 'openclaw', 'a2a-config.json');
const ONBOARDING_EXEMPT = new Set([
  'quickstart',
  'help',
  'version',
  'update',
  'uninstall',
  'onboard'
]);

function isOnboarded() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return config.onboarding?.step === 'complete';
  } catch (err) {
    return false;
  }
}

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

function enforceOnboarding(command) {
  if (ONBOARDING_EXEMPT.has(command)) {
    return;
  }

  if (!isOnboarded()) {
    console.log('\n⚠️  A2A not configured yet.');
    console.log('');
    console.log('Run this first:');
    console.log('  a2a quickstart --hostname YOUR_DOMAIN:PORT');
    console.log('');
    console.log('Example:');
    console.log('  a2a quickstart --hostname myserver.com:3001');
    process.exit(1);
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

async function promptYesNo(question) {
  const readline = require('readline');
  return await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
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
    const { A2AConfig } = require('../src/lib/config');
    const { isPortListening } = require('../src/lib/port-scanner');
    const {
      readContextFiles,
      generateDefaultManifest,
      saveManifest
    } = require('../src/lib/disclosure');
    const {
      normalizeHostInput,
      splitHostPort,
      isLocalOrUnroutableHost
    } = require('../src/lib/invite-host');

    const config = new A2AConfig();
    const workspaceDir = process.env.A2A_WORKSPACE || process.cwd();

    if (args.flags.force) {
      config.resetOnboarding();
    }

    function parsePort(raw, fallback) {
      const parsed = Number.parseInt(String(raw || '').trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
        return parsed;
      }
      return fallback;
    }

    function uniqueNonEmpty(values, limit = 80) {
      const normalizeValue = (value) => {
        if (typeof value === 'string') {
          return String(value || '').trim();
        }
        if (value && typeof value === 'object' && !Array.isArray(value) && 'topic' in value) {
          return String(value.topic || '').trim();
        }
        return '';
      };

      const out = [];
      const seen = new Set();
      for (const value of values) {
        const text = normalizeValue(value);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= limit) break;
      }
      return out;
    }

    function normalizeTopicRecord(raw) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return {
          topic: String(raw.topic || '').trim(),
          detail: String(raw.detail || '').trim()
        };
      }
      return {
        topic: String(raw || '').trim(),
        detail: ''
      };
    }

    function uniqueTopicRecords(values, limit = 80) {
      const out = [];
      const seen = new Set();
      for (const value of values) {
        const item = normalizeTopicRecord(value);
        if (!item.topic) continue;
        const key = item.topic.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= limit) break;
      }
      return out;
    }

    function sanitizeSectionItems(values, limit = 80) {
      return uniqueTopicRecords(values, limit).map(item => ({
        topic: item.topic,
        detail: item.detail || ''
      }));
    }

    function cloneDraft(draft = {}) {
      return JSON.parse(JSON.stringify(draft));
    }

    function makeDraft(manifest) {
      const src = (manifest && manifest.topics) ? manifest.topics : {};
      return {
        public: {
          lead_with: sanitizeSectionItems((src.public && src.public.lead_with) || [], 60),
          discuss_freely: sanitizeSectionItems((src.public && src.public.discuss_freely) || [], 60),
          deflect: sanitizeSectionItems((src.public && src.public.deflect) || [], 60)
        },
        friends: {
          lead_with: sanitizeSectionItems((src.friends && src.friends.lead_with) || [], 60),
          discuss_freely: sanitizeSectionItems((src.friends && src.friends.discuss_freely) || [], 60),
          deflect: sanitizeSectionItems((src.friends && src.friends.deflect) || [], 60)
        },
        family: {
          lead_with: sanitizeSectionItems((src.family && src.family.lead_with) || [], 60),
          discuss_freely: sanitizeSectionItems((src.family && src.family.discuss_freely) || [], 60),
          deflect: sanitizeSectionItems((src.family && src.family.deflect) || [], 60)
        }
      };
    }

    function summarizeLine(content, maxLen = 60) {
      const text = String(content || '').split('\n').map((line) => line.trim()).find((line) => {
        return line && !line.startsWith('#') && !line.startsWith('---') && line.length <= 220;
      });
      if (!text) {
        return 'found';
      }
      return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
    }

    function countMemoryDocs(root) {
      try {
        const dir = path.join(root, 'memory');
        if (!fs.existsSync(dir)) return 0;
        return fs.readdirSync(dir).filter(name => name.endsWith('.md')).length;
      } catch (err) {
        return 0;
      }
    }

    function renderWorkspaceScan(contextFiles) {
      const memoryCount = countMemoryDocs(workspaceDir);
      console.log('\n🔍 Scanning workspace for context...\n');
      console.log('Found:');
      const rows = [
        { label: 'USER.md', found: Boolean(contextFiles.user), note: summarizeLine(contextFiles.user, 72) },
        { label: 'SOUL.md', found: Boolean(contextFiles.soul), note: summarizeLine(contextFiles.soul, 72) },
        { label: 'HEARTBEAT.md', found: Boolean(contextFiles.heartbeat), note: 'contains agent tasks, not disclosure topics' },
        { label: 'SKILL.md', found: Boolean(contextFiles.skill), note: null },
        { label: 'memory/*.md', found: memoryCount > 0, note: `${memoryCount} file${memoryCount === 1 ? '' : 's'}` }
      ];

      for (const row of rows) {
        const check = row.found ? '✅' : '❌';
        const note = row.found && row.note ? ` — ${row.note}` : '';
        const skip = row.label === 'HEARTBEAT.md' && row.found ? ' (skipped)' : '';
        console.log(`  ${check} ${row.label}${skip}${note}`);
      }
      console.log('');
    }

    function sectionLabel(sectionName) {
      if (sectionName === 'lead_with') return 'Lead with';
      if (sectionName === 'discuss_freely') return 'Discuss freely';
      return 'Deflect';
    }

    function flattenDraft(draft) {
      const flat = [];
      let index = 1;
      ['public', 'friends', 'family'].forEach((tier) => {
        ['lead_with', 'discuss_freely', 'deflect'].forEach((section) => {
          (draft[tier][section] || []).forEach((item, itemIndex) => {
            flat.push({
              index,
              tier,
              section,
              item,
              itemIndex,
              list: draft[tier][section]
            });
            index += 1;
          });
        });
      });
      return flat;
    }

    function renderDraft(draft, neverDisclose) {
      console.log('\n📋 Proposed Permission Tiers');
      console.log('═'.repeat(60));

      let index = 1;
      const titleByTier = {
        public: 'PUBLIC (anyone can see):',
        friends: 'FRIENDS (trusted contacts):',
        family: 'FAMILY (inner circle):'
      };

      ['public', 'friends', 'family'].forEach((tier) => {
        console.log(`\n${titleByTier[tier]}`);
        ['lead_with', 'discuss_freely', 'deflect'].forEach((section) => {
          console.log(`  ${sectionLabel(section)}:`);
          const list = draft[tier][section] || [];
          if (list.length === 0) {
            console.log('    (none)');
            return;
          }
          list.forEach((item) => {
            const detail = item.detail ? ` — ${item.detail}` : '';
            console.log(`    ${index}. ${item.topic}${detail}`);
            index += 1;
          });
        });
      });

      console.log('\nNEVER DISCLOSE:');
      const staticNever = (neverDisclose || ['API keys', 'Other users\' data', 'Financial figures']);
      staticNever.forEach((item) => console.log(`  • ${item}`));
      console.log('═'.repeat(60));
      return flattenDraft(draft);
    }

    function parseSections(target) {
      if (!target) return null;
      const [tierRaw, sectionRaw] = String(target).toLowerCase().split('.');
      if (!tierRaw || !sectionRaw) return null;
      if (!['public', 'friends', 'family'].includes(tierRaw)) return null;

      const section = {
        lead: 'lead_with',
        lead_with: 'lead_with',
        discuss: 'discuss_freely',
        discuss_freely: 'discuss_freely',
        deflect: 'deflect'
      }[sectionRaw];

      if (!section) return null;
      return { tier: tierRaw, section };
    }

    function splitCommand(input) {
      const raw = String(input || '').trim();
      if (!raw) return [];
      const match = raw.match(/"([^"]*)"|'([^']*)'|`([^`]*)`|\S+/g);
      if (!match) return [];
      return match.map((token) => {
        if ((token.startsWith('"') && token.endsWith('"')) ||
            (token.startsWith("'") && token.endsWith("'")) ||
            (token.startsWith('`') && token.endsWith('`'))) {
          return token.slice(1, -1);
        }
        return token;
      });
    }

    function findByIndex(draft, index) {
      const target = flattenDraft(draft).find(item => item.index === index);
      return target || null;
    }

    function readNameFromUserContext(content) {
      const lines = String(content || '').split('\n');
      for (const line of lines) {
        const trimmed = String(line || '').trim();
        if (!trimmed) continue;

        const nameMatch = trimmed.match(/^\*{0,2}Name:\*{0,2}\s*(.+)$/i);
        if (nameMatch && nameMatch[1]) {
          return String(nameMatch[1]).trim();
        }

        if (/^(owner|ownername):/i.test(trimmed)) {
          const ownerMatch = trimmed.replace(/^[^:]+:\s*/, '');
          if (ownerMatch) return ownerMatch.trim();
        }

        if (trimmed.startsWith('-') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
          continue;
        }

        if (/^[A-Za-z][\w\-,.\s]{2,}$/i.test(trimmed)) {
          const candidate = trimmed.split('|')[0].split('\t')[0].trim();
          if (candidate && candidate.length <= 80) {
            return candidate;
          }
        }
      }
      return '';
    }

    function flattenTopicStrings(section) {
      return uniqueNonEmpty((section || []).map(item => String(item && item.topic || '').trim()), 200)
        .filter(Boolean);
    }

    async function editLoop(draft, neverDisclose, reloadManifest) {
      const shouldPrompt = process.stdin.isTTY && process.stdout.isTTY;
      if (!shouldPrompt) {
        console.log('\n⏩ Non-interactive shell detected. Proceeding with proposed topics.');
        renderDraft(draft, neverDisclose);
        return draft;
      }

      console.log('\nEdit commands:');
      console.log('  move N to TIER.SECTION     — Move topic #N to a section');
      console.log('  remove N                   — Remove topic #N');
      console.log('  add TIER.SECTION "Topic" "Detail"  — Add a topic');
      console.log('  edit N topic "new"         — Edit topic #N label');
      console.log('  edit N detail "new"        — Edit topic #N detail');
      console.log('  reset                      — Rescan workspace and regenerate');
      console.log('  done                       — Save and continue\n');

      let done = false;
      renderDraft(draft, neverDisclose);

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return await new Promise((resolve) => {
        const finish = () => {
          if (!done) {
            done = true;
            resolve(draft);
          }
        };

        const prompt = () => {
          rl.question('Your choice: ', (answer) => {
            const parts = splitCommand(answer);
            const command = String(parts[0] || '').toLowerCase();
            if (!parts.length) {
              renderDraft(draft, neverDisclose);
              return prompt();
            }

            if (command === 'done') {
              rl.close();
              return finish();
            }

            if (command === 'reset') {
              draft = cloneDraft(reloadManifest());
              renderDraft(draft, neverDisclose);
              return prompt();
            }

            if (command === 'remove') {
              const target = findByIndex(draft, Number.parseInt(parts[1], 10));
              if (!target) {
                console.log(`Could not find topic #${parts[1]}.`);
              } else {
                target.list.splice(target.itemIndex, 1);
                console.log(`Removed topic #${parts[1]}.`);
              }
              renderDraft(draft, neverDisclose);
              return prompt();
            }

            if (command === 'move') {
              const target = findByIndex(draft, Number.parseInt(parts[1], 10));
              const destination = parseSections(parts[2] === 'to' ? parts[3] : parts[2]);
              if (!target) {
                console.log(`Could not find topic #${parts[1]}.`);
              } else if (!destination) {
                console.log('Invalid target. Use format: move N to friends.lead');
              } else {
                target.list.splice(target.itemIndex, 1);
                draft[destination.tier][destination.section].push(target.item);
                console.log(`Moved topic #${parts[1]} to ${destination.tier}.${destination.section}`);
              }
              renderDraft(draft, neverDisclose);
              return prompt();
            }

            if (command === 'add') {
              const destination = parseSections(parts[1]);
              const topic = parts[2];
              const detail = parts[3] || '';
              if (!destination || !topic) {
                console.log('Add format: add TIER.SECTION "Topic" "Detail"');
              } else {
                draft[destination.tier][destination.section].push({ topic, detail });
                console.log(`Added topic to ${destination.tier}.${destination.section}.`);
              }
              renderDraft(draft, neverDisclose);
              return prompt();
            }

            if (command === 'edit') {
              const target = findByIndex(draft, Number.parseInt(parts[1], 10));
              const field = String(parts[2] || '').toLowerCase();
              const value = parts[3] || '';
              if (!target || !field || !['topic', 'detail'].includes(field)) {
                console.log('Edit format: edit N topic "new" | edit N detail "new"');
              } else {
                target.item[field] = value;
                console.log(`Updated topic #${parts[1]} ${field}.`);
              }
              renderDraft(draft, neverDisclose);
              return prompt();
            }

            console.log('Unknown command.');
            renderDraft(draft, neverDisclose);
            return prompt();
          });
        };

        rl.on('close', finish);
        prompt();
      });
    }

    async function probePing(port) {
      return await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/api/a2a/ping',
          method: 'GET',
          timeout: 1200
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += String(chunk || ''); });
          res.on('end', () => {
            const ok = body.includes('"pong":true') || body.includes('"pong": true');
            resolve({ ok, statusCode: res.statusCode || 0, body });
          });
        });
        req.on('error', () => resolve({ ok: false }));
        req.on('timeout', () => {
          req.destroy(new Error('timeout'));
          resolve({ ok: false });
        });
        req.end();
      });
    }

    async function waitForLocalServer(port) {
      for (let i = 0; i < 18; i++) {
        const listening = await isPortListening(port, '127.0.0.1', { timeoutMs: 250 });
        if (!listening.listening) {
          await new Promise(r => setTimeout(r, 250));
          continue;
        }

        const probe = await probePing(port);
        if (probe.ok) {
          return true;
        }
      }
      return false;
    }

    async function startServer(port) {
      const listening = await isPortListening(port, '127.0.0.1', { timeoutMs: 250 });
      if (listening.listening) {
        return false;
      }

      const serverScript = path.join(__dirname, '../src/server.js');
      const child = spawn(process.execPath, [serverScript], {
        env: {
          ...process.env,
          PORT: String(port),
          A2A_WORKSPACE: workspaceDir
        },
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      await new Promise(r => setTimeout(r, 300));
      return true;
    }

    function looksLikePong(body) {
      return String(body || '').includes('"pong":true') || String(body || '').includes('"pong": true');
    }

    // Step 1: discover context
    const contextFiles = (() => {
      try {
        return readContextFiles(workspaceDir);
      } catch (err) {
        return {};
      }
    })();

    renderWorkspaceScan(contextFiles);

    const backendPort = parsePort(args.flags.port || args.flags.p || process.env.A2A_PORT || process.env.PORT, 3001);
    const hostFlag = normalizeHostInput(
      args.flags.hostname !== undefined
        ? String(args.flags.hostname)
        : (config.getAgent().hostname || `localhost:${backendPort}`)
    );
    const parsedHost = splitHostPort(hostFlag || `localhost:${backendPort}`);
    const inviteHost = parsedHost.port
      ? `${parsedHost.hostname}:${parsedHost.port}`
      : `${parsedHost.hostname || 'localhost'}:${backendPort}`;

    // Step 2: seed draft from workspace context
    let manifest = generateDefaultManifest(contextFiles);
    let draft = makeDraft(manifest);
    const neverDisclose = uniqueNonEmpty(manifest.never_disclose || [
      'API keys',
      'Other users\' data',
      'Financial figures'
    ], 30);

    draft = await editLoop(draft, neverDisclose, () => {
      try {
        const refreshedContext = readContextFiles(workspaceDir);
        const freshManifest = generateDefaultManifest(refreshedContext);
        manifest = freshManifest;
        return makeDraft(freshManifest);
      } catch (err) {
        return draft;
      }
    });

    const finalManifest = {
      version: 1,
      generated_at: manifest.generated_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      topics: {
        public: {
          lead_with: sanitizeSectionItems(draft.public.lead_with, 80),
          discuss_freely: sanitizeSectionItems(draft.public.discuss_freely, 80),
          deflect: sanitizeSectionItems(draft.public.deflect, 80)
        },
        friends: {
          lead_with: sanitizeSectionItems(draft.friends.lead_with, 80),
          discuss_freely: sanitizeSectionItems(draft.friends.discuss_freely, 80),
          deflect: sanitizeSectionItems(draft.friends.deflect, 80)
        },
        family: {
          lead_with: sanitizeSectionItems(draft.family.lead_with, 80),
          discuss_freely: sanitizeSectionItems(draft.family.discuss_freely, 80),
          deflect: sanitizeSectionItems(draft.family.deflect, 80)
        }
      },
      never_disclose: neverDisclose,
      personality_notes: manifest.personality_notes || ''
    };

    const finalManifestForStore = finalManifest;

    // Keep config in sync with the edited disclosure.
    try {
      config.setTier('public', {
        topics: flattenTopicStrings([...finalManifest.topics.public.lead_with, ...finalManifest.topics.public.discuss_freely, ...finalManifest.topics.public.deflect]),
        disclosure: 'public'
      });

      config.setTier('friends', {
        topics: flattenTopicStrings([
          ...finalManifest.topics.public.lead_with,
          ...finalManifest.topics.public.discuss_freely,
          ...finalManifest.topics.public.deflect,
          ...finalManifest.topics.friends.lead_with,
          ...finalManifest.topics.friends.discuss_freely,
          ...finalManifest.topics.friends.deflect
        ]),
        disclosure: 'public'
      });

      config.setTier('family', {
        topics: flattenTopicStrings([
          ...finalManifest.topics.public.lead_with,
          ...finalManifest.topics.public.discuss_freely,
          ...finalManifest.topics.public.deflect,
          ...finalManifest.topics.friends.lead_with,
          ...finalManifest.topics.friends.discuss_freely,
          ...finalManifest.topics.friends.deflect,
          ...finalManifest.topics.family.lead_with,
          ...finalManifest.topics.family.discuss_freely,
          ...finalManifest.topics.family.deflect
        ]),
        disclosure: 'public'
      });

      saveManifest(finalManifestForStore);
      config.setOnboarding({ step: 'tiers', tiers_confirmed: true });
    } catch (err) {
      console.error('\n❌ Failed to save tier updates.');
      console.error(`   ${err.message}`);
      throw err;
    }

    console.log('\n🚀 Starting A2A server...');
    console.log(`Port: ${backendPort}`);
    console.log(`Hostname: ${inviteHost}`);

    const started = await startServer(backendPort);
    const localRunning = await waitForLocalServer(backendPort);
    if (!localRunning) {
      console.log('⚠️  Local server not reachable. Start it manually and retry if needed:');
      console.log(`  A2A_HOSTNAME="${inviteHost}" a2a server --port ${backendPort}`);
    } else {
      console.log('✅ Server running!');
      if (started) {
        console.log('🟢 Local server started automatically.');
      }
    }

    const dashboard = `http://127.0.0.1:${backendPort}/dashboard/`;

    const hostSplit = splitHostPort(inviteHost);
    const isPrivateHost = isLocalOrUnroutableHost(hostSplit.hostname);
    const expectedPingUrl = `${isPrivateHost ? 'http' : (hostSplit.port === 443 ? 'https' : 'http')}://${inviteHost}/api/a2a/ping`;

    if (isPrivateHost) {
      console.log('✅ External ping OK (local testing host)');
    } else {
      const external = await new Promise(resolve => {
        const req = http.get(expectedPingUrl, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            resolve({ ok: looksLikePong(body), statusCode: res.statusCode || 0, body });
          });
        });
        req.on('error', () => resolve({ ok: false }));
        req.setTimeout(1500, () => {
          req.destroy(new Error('timeout'));
          resolve({ ok: false });
        });
      });

      if (!external.ok && !args.flags['confirm-ingress'] && !args.flags['skip-verify']) {
        console.log('⚠️  External ping FAILED. Fix host/reachability and rerun quickstart, or use --skip-verify.');
        console.log(`  a2a quickstart --hostname ${inviteHost} --port ${backendPort} --skip-verify`);
        return;
      }

      if (!external.ok) {
        console.log('⚠️  External ping FAILED (continuing).');
      } else {
        console.log(`✅ External ping OK (${expectedPingUrl})`);
      }
    }

    console.log(`Dashboard: ${dashboard}`);

    // Step 5: generate first invite
    const publicTopicsForInvite = flattenTopicStrings([
      ...draft.public.lead_with,
      ...draft.public.discuss_freely
    ]);
    const goalItems = ['grow-network', 'find-collaborators', 'build-in-public'];

    const ownerName = args.flags.owner || config.getAgent().name || readNameFromUserContext(contextFiles.user) || 'Someone';
    const peerName = args.flags.name || 'bappybot';

    config.setAgent({ name: ownerName, hostname: inviteHost });

    const { token, record } = store.create({
      name: peerName,
      owner: ownerName,
      permissions: 'public',
      disclosure: 'minimal',
      expires: 'never',
      maxCalls: null,
      allowedTopics: publicTopicsForInvite,
      allowedGoals: goalItems,
      notify: 'all'
    });

    const inviteUrl = `a2a://${inviteHost}/${token}`;
    const topicLine = publicTopicsForInvite.length > 0 ? publicTopicsForInvite.slice(0, 6).join(' · ') : 'chat';
    const goalLine = goalItems.join(' · ');

    console.log('\n📞 Your first invite (public tier):\n');
    console.log('─'.repeat(60));
    const inviteText = `📞🗣️ **Agent-to-Agent Call Invite**

👤 **${ownerName}** would like your agent to call **${peerName}**

💬 ${topicLine}
🎯 ${goalLine}

${inviteUrl}

── setup ──
npm i -g a2acalling && a2a add "${inviteUrl}" "${peerName}" && a2a call "${peerName}" "Hello!"
https://github.com/onthegonow/a2a_calling`;
    console.log(inviteText);
    console.log('─'.repeat(60));
    console.log('Share this invite to let other agents call you!\n');

    config.completeOnboarding();

    console.log('✅ A2A setup complete!\n');
    console.log('Your agent is now:');
    console.log(`  • Listening on ${inviteHost}`);
    console.log('  • Ready to receive calls');
    console.log(`  • Configured with ${Object.keys(finalManifest.topics).length} permission tiers`);
    console.log('\nNext steps:');
    console.log('  a2a invite friends    — Create a friends-tier invite');
    console.log('  a2a contacts          — View your contacts');
    console.log('  a2a gui               — Open the dashboard\n');
    console.log('Happy calling! 🤝');
  },

  install: () => {
    require('../scripts/install-openclaw.js');
  },

  setup: () => {
    require('../scripts/install-openclaw.js');
  },

  uninstall: async (args) => {
    const fs = require('fs');
    const path = require('path');
    const { spawnSync } = require('child_process');

    const keepConfig = Boolean(args.flags['keep-config'] || args.flags.keepConfig);
    const force = Boolean(args.flags.force || args.flags.f);

    const configDir = process.env.A2A_CONFIG_DIR ||
      process.env.OPENCLAW_CONFIG_DIR ||
      path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

    const configFile = path.join(configDir, 'a2a-config.json');
    const disclosureFile = path.join(configDir, 'a2a-disclosure.json');
    const dbFile = path.join(configDir, 'a2a-conversations.db');

    console.log(`\n🗑️  A2A Uninstall`);
    console.log('─────────────────\n');

    if (!keepConfig && !force) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error('Refusing to prompt without a TTY. Re-run with --force to confirm uninstall.');
        process.exit(1);
      }

      const existing = [configFile, disclosureFile, dbFile].filter(f => fs.existsSync(f));
      const list = existing.length ? existing.map(f => `  - ${f}`).join('\n') : '  (no local config/database files found)';
      const ok = await promptYesNo(
        `This will stop the pm2 process "a2a" and delete:\n${list}\nProceed? (y/N) `
      );
      if (!ok) {
        console.log('\nCancelled.\n');
        return;
      }
    }

    function pm2Exists() {
      const res = spawnSync('pm2', ['--version'], { stdio: 'ignore', timeout: 4000 });
      if (res.error && res.error.code === 'ENOENT') return false;
      return res.status === 0;
    }

    function pm2HasProcess(name) {
      const res = spawnSync('pm2', ['describe', name], { encoding: 'utf8', timeout: 6000 });
      if (res.error && res.error.code === 'ENOENT') return false;
      return res.status === 0;
    }

    function pm2StopAndDelete(name) {
      if (!pm2Exists()) return { ok: true, skipped: true };
      if (!pm2HasProcess(name)) return { ok: true, skipped: true };

      const stop = spawnSync('pm2', ['stop', name], { encoding: 'utf8', timeout: 8000 });
      if (stop.status !== 0) {
        const msg = (stop.stderr || stop.stdout || '').trim();
        return { ok: false, error: msg || 'pm2 stop failed' };
      }

      const del = spawnSync('pm2', ['delete', name], { encoding: 'utf8', timeout: 8000 });
      if (del.status !== 0) {
        const msg = (del.stderr || del.stdout || '').trim();
        return { ok: false, error: msg || 'pm2 delete failed' };
      }

      return { ok: true };
    }

    function rmFileSafe(filePath) {
      try {
        fs.rmSync(filePath, { force: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    process.stdout.write('Stopping server... ');
    const stopped = pm2StopAndDelete('a2a');
    if (!stopped.ok) {
      console.log('❌');
      console.error(`  ${stopped.error}`);
      process.exit(1);
    }
    console.log('✅');

    let configOk = true;
    let dbOk = true;

    if (!keepConfig) {
      process.stdout.write('Removing config... ');
      const c1 = rmFileSafe(configFile);
      const c2 = rmFileSafe(disclosureFile);
      configOk = Boolean(c1.ok && c2.ok);
      console.log(configOk ? '✅' : '❌');
      if (!configOk) {
        if (!c1.ok) console.error(`  ${configFile}: ${c1.error}`);
        if (!c2.ok) console.error(`  ${disclosureFile}: ${c2.error}`);
      }

      process.stdout.write('Removing database... ');
      const d1 = rmFileSafe(dbFile);
      dbOk = Boolean(d1.ok);
      console.log(dbOk ? '✅' : '❌');
      if (!dbOk) {
        console.error(`  ${dbFile}: ${d1.error}`);
      }

      if (!configOk || !dbOk) {
        process.exit(1);
      }
    } else {
      console.log('Removing config... ⏭️');
      console.log('Removing database... ⏭️');
    }

    console.log('\nTo complete removal:');
    console.log('  npm uninstall -g a2acalling\n');
    console.log(`Config preserved: ${keepConfig ? 'yes' : 'no'}`);
    console.log(`Location: ${configDir}`);
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
    const {
      readContextFiles,
      buildExtractionPrompt,
      validateDisclosureSubmission,
      saveManifest,
      MANIFEST_FILE
    } = require('../src/lib/disclosure');
    const config = new A2AConfig();

    // ── Submit mode: agent sends structured JSON ──────────────
    const submitRaw = args.flags.submit;
    if (submitRaw) {
      let parsed;
      try {
        parsed = JSON.parse(String(submitRaw));
      } catch (e) {
        console.error('\n\u274c Invalid JSON in --submit flag.');
        console.error(`   Parse error: ${e.message}\n`);
        process.exit(1);
      }

      const result = validateDisclosureSubmission(parsed);
      if (!result.valid) {
        console.error('\n\u274c Disclosure submission validation failed:\n');
        result.errors.forEach(err => console.error(`   \u2022 ${err}`));
        console.error(`\nFix the errors above and resubmit with: a2a onboard --submit '<json>'\n`);
        process.exit(1);
      }

      saveManifest(result.manifest);

      const agentName = args.flags.name || config.getAgent().name || process.env.A2A_AGENT_NAME || '';
      const hostname = args.flags.hostname || config.getAgent().hostname || process.env.A2A_HOSTNAME || '';
      if (agentName) config.setAgent({ name: agentName });
      if (hostname) config.setAgent({ hostname });

      console.log('\n\u2705 Disclosure manifest saved.');
      console.log(`   Manifest: ${MANIFEST_FILE}`);
      console.log('   Next: a2a quickstart\n');
      return;
    }

    // ── Prompt mode: print extraction instructions for agent ──
    if (config.isOnboarded() && !args.flags.force) {
      console.log('\u2705 Onboarding already complete. Use --force to regenerate.');
      return;
    }

    const workspaceDir = process.env.A2A_WORKSPACE || process.cwd();
    const contextFiles = readContextFiles(workspaceDir);

    const availableFiles = {
      'USER.md': Boolean(contextFiles.user),
      'SOUL.md': Boolean(contextFiles.soul),
      'HEARTBEAT.md': Boolean(contextFiles.heartbeat),
      'SKILL.md': Boolean(contextFiles.skill),
      'CLAUDE.md': Boolean(contextFiles.claude),
      'memory/*.md': Boolean(contextFiles.memory)
    };

    console.log(buildExtractionPrompt(availableFiles));
    console.log('\n---');
    console.log('After the owner confirms, submit with:');
    console.log("  a2a onboard --submit '<json>'\n");
  },

  version: () => {
    const pkg = require('../package.json');
    console.log(pkg.version);
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
  uninstall           Stop server and remove local config/DB
    --keep-config     Preserve config/DB (for reinstall)
    --force           Skip confirmation prompt
  version             Show installed package version

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

enforceOnboarding(command);

// Handle async commands
const result = commands[command](args);
if (result instanceof Promise) {
  result.catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
