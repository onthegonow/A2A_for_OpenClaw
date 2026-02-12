#!/usr/bin/env node
/**
 * A2A Calling CLI
 * 
 * Usage:
 *   a2a create [options]     Create a federation token
 *   a2a list                 List active tokens
 *   a2a revoke <id>          Revoke a token
 *   a2a add <url> [name]     Add a remote agent
 *   a2a remotes              List remote agents
 *   a2a call <url> <msg>     Call a remote agent
 *   a2a ping <url>           Ping a remote agent
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

// Get hostname for invite URLs
function getHostname() {
  return process.env.A2A_HOSTNAME || process.env.OPENCLAW_HOSTNAME || process.env.HOSTNAME || 'localhost';
}

// Commands
const commands = {
  create: (args) => {
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
      permissions: args.flags.permissions || args.flags.p || 'chat-only',
      disclosure: args.flags.disclosure || args.flags.d || 'minimal',
      notify: args.flags.notify || 'all',
      maxCalls,
      allowedTopics: customTopics
    });

    const hostname = getHostname();
    const inviteUrl = `a2a://${hostname}/${token}`;

    const expiresText = record.expires_at 
      ? new Date(record.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'never';

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
      console.log(`✅ Federation token created\n`);
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
    // Human-friendly above the fold, agent instructions below
    const ownerText = record.owner || 'Someone';
    const agentName = record.name;
    const topicsList = record.allowed_topics.join(', ');
    
    const invite = `🤝 **${ownerText}** is inviting you to connect agents!

Your agent can reach ${agentName} for: ${topicsList}

${inviteUrl}

${expiresText === 'never' ? '' : `⏰ Expires: ${expiresText}\n`}
━━━ For your agent ━━━

npm install -g a2acalling
a2a add "${inviteUrl}" "${agentName}"
a2a call "${agentName}" "Hello!"

📚 https://github.com/onthegonow/A2A_for_OpenClaw`;

    console.log(invite);
    console.log(`\n${'─'.repeat(50)}`);
  },

  list: () => {
    const tokens = store.list();
    if (tokens.length === 0) {
      console.log('No active federation tokens.');
      return;
    }

    console.log('Active federation tokens:\n');
    for (const t of tokens) {
      const expired = t.expires_at && new Date(t.expires_at) < new Date();
      const status = expired ? '⚠️  EXPIRED' : '✅ Active';
      const tier = t.tier || t.permissions;  // backward compat
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
      const result = store.addRemote(url, name);
      if (!result.success) {
        console.log(`Remote already registered: ${result.existing.name}`);
        return;
      }
      console.log(`✅ Remote agent added: ${result.remote.name} (${result.remote.host})`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  },

  remotes: () => {
    // Legacy alias for contacts
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
    const remotes = store.listRemotes();
    if (remotes.length === 0) {
      console.log('📇 No contacts yet.\n');
      console.log('Add one with: a2a contacts add <invite_url>');
      return;
    }

    console.log(`📇 Agent Contacts (${remotes.length})\n`);
    for (const r of remotes) {
      const statusIcon = r.status === 'online' ? '🟢' : r.status === 'offline' ? '🔴' : '⚪';
      const ownerText = r.owner ? ` — ${r.owner}` : '';
      
      // Permission badge from linked token (what YOU gave THEM)
      let permBadge = '';
      if (r.linked_token) {
        const tier = r.linked_token.tier || r.linked_token.permissions;
        permBadge = tier === 'tools-write' ? ' ⚡' : tier === 'tools-read' ? ' 🔧' : ' 🌐';
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
    
    console.log('Legend: 🌐 chat-only  🔧 tools-read  ⚡ tools-write');
  },

  'contacts:add': (args) => {
    const url = args._[2];
    if (!url) {
      console.error('Usage: a2a contacts add <invite_url> [options]');
      console.error('Options:');
      console.error('  --name, -n     Agent name');
      console.error('  --owner, -o    Owner name');
      console.error('  --notes        Notes about this contact');
      console.error('  --tags         Comma-separated tags');
      console.error('  --link         Link to token ID you gave them');
      process.exit(1);
    }

    const options = {
      name: args.flags.name || args.flags.n,
      owner: args.flags.owner || args.flags.o,
      notes: args.flags.notes,
      tags: args.flags.tags ? args.flags.tags.split(',').map(t => t.trim()) : [],
      linkedTokenId: args.flags.link || null
    };

    try {
      const result = store.addRemote(url, options);
      if (!result.success) {
        console.log(`Contact already exists: ${result.existing.name}`);
        return;
      }
      console.log(`✅ Contact added: ${result.remote.name}`);
      if (result.remote.owner) console.log(`   Owner: ${result.remote.owner}`);
      console.log(`   Host: ${result.remote.host}`);
      if (options.linkedTokenId) {
        console.log(`   Linked to token: ${options.linkedTokenId}`);
      } else {
        console.log(`\n💡 Link a token: a2a contacts link ${result.remote.name} <token_id>`);
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
    const remotes = store.listRemotes();
    const remote = remotes.find(r => r.name === name || r.id === name);
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
      const tier = t.tier || t.permissions;
      const topics = t.allowed_topics || ['chat'];
      const tierIcon = tier === 'tools-write' ? '⚡' : tier === 'tools-read' ? '🔧' : '🌐';
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
      console.error('  --notes        Notes');
      console.error('  --tags         Comma-separated tags');
      process.exit(1);
    }

    const updates = {};
    if (args.flags.name) updates.name = args.flags.name;
    if (args.flags.owner) updates.owner = args.flags.owner;
    if (args.flags.notes) updates.notes = args.flags.notes;
    if (args.flags.tags) updates.tags = args.flags.tags.split(',').map(t => t.trim());

    if (Object.keys(updates).length === 0) {
      console.error('No updates specified. Use --name, --owner, --notes, or --tags');
      process.exit(1);
    }

    const result = store.updateRemote(name, updates);
    if (!result.success) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    console.log(`✅ Contact updated: ${result.remote.name}`);
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

    const permLabel = result.token.permissions === 'tools-write' ? '⚡ tools-write' : 
                      result.token.permissions === 'tools-read' ? '🔧 tools-read' : '🌐 chat-only';
    
    console.log(`✅ Linked token to contact`);
    console.log(`   Contact: ${result.remote.name}`);
    console.log(`   Token: ${result.token.id} (${result.token.name})`);
    console.log(`   Permissions: ${permLabel}`);
  },

  'contacts:ping': async (args) => {
    const name = args._[2];
    if (!name) {
      console.error('Usage: a2a contacts ping <name>');
      process.exit(1);
    }

    const remote = store.getRemote(name);
    if (!remote) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    const client = new A2AClient({});
    const url = `a2a://${remote.host}/${remote.token}`;

    console.log(`🔍 Pinging ${remote.name}...`);

    try {
      const result = await client.ping(url);
      store.updateRemoteStatus(name, 'online');
      console.log(`🟢 ${remote.name} is online`);
      console.log(`   Agent: ${result.name}`);
      console.log(`   Version: ${result.version}`);
    } catch (err) {
      store.updateRemoteStatus(name, 'offline', err.message);
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

    const result = store.removeRemote(name);
    if (!result.success) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    console.log(`✅ Contact removed: ${result.remote.name}`);
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
      const remote = store.getRemote(target);
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
        store.updateRemoteStatus(contactName, 'online');
      }
      
      console.log(`\n✅ Response:\n`);
      console.log(response.response);
      if (response.conversation_id) {
        console.log(`\n📝 Conversation ID: ${response.conversation_id}`);
      }
    } catch (err) {
      // Update contact status on failure
      if (contactName) {
        store.updateRemoteStatus(contactName, 'offline', err.message);
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

  status: async (args) => {
    const url = args._[1];
    if (!url) {
      console.error('Usage: a2a status <invite_url>');
      process.exit(1);
    }

    const client = new A2AClient();
    try {
      const status = await client.status(url);
      console.log(`Federation status for ${url}:\n`);
      console.log(JSON.stringify(status, null, 2));
    } catch (err) {
      console.error(`❌ Failed to get status: ${err.message}`);
      process.exit(1);
    }
  },

  server: (args) => {
    const port = args.flags.port || args.flags.p || process.env.PORT || 3001;
    process.env.PORT = port;
    console.log(`Starting A2A federation server on port ${port}...`);
    require('../src/server.js');
  },

  quickstart: (args) => {
    const hostname = process.env.A2A_HOSTNAME || process.env.HOSTNAME || 'localhost:3001';
    const name = args.flags.name || args.flags.n || 'My Agent';
    const owner = args.flags.owner || args.flags.o || null;
    
    console.log(`\n🚀 A2A Quickstart\n${'═'.repeat(50)}\n`);
    
    // Step 1: Check server
    console.log('1️⃣  Checking server status...');
    const http = require('http');
    const serverHost = hostname.split(':')[0];
    const serverPort = hostname.split(':')[1] || 3001;
    
    const checkServer = () => new Promise((resolve) => {
      const req = http.request({
        hostname: serverHost === 'localhost' ? '127.0.0.1' : serverHost,
        port: serverPort,
        path: '/api/federation/ping',
        timeout: 2000
      }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });

    checkServer().then(serverOk => {
      if (!serverOk) {
        console.log('   ⚠️  Server not running!');
        console.log(`   Run: A2A_HOSTNAME="${hostname}" a2a server\n`);
      } else {
        console.log('   ✅ Server running\n');
      }

      // Step 2: Create invite
      console.log('2️⃣  Creating your first invite...\n');
      const { token, record } = store.create({
        name,
        owner,
        expires: '7d',
        permissions: 'chat-only',
        maxCalls: 100
      });

      const inviteUrl = `a2a://${hostname}/${token}`;
      const expiresText = new Date(record.expires_at).toLocaleDateString('en-US', { 
        month: 'short', day: 'numeric', year: 'numeric' 
      });

      // Step 3: Show the invite
      const ownerText = owner ? `${owner}'s agent ${name}` : name;
      console.log('3️⃣  Share this invite:\n');
      console.log('─'.repeat(50));
      console.log(`
🤝 Agent-to-Agent Invite

${ownerText} is inviting your agent to connect!

📡 Connection URL:
${inviteUrl}

⏰ Expires: ${expiresText}
🔐 Permissions: chat-only
📊 Limits: 100 calls, 10/min rate limit

━━━ Quick Setup ━━━

1. Install: npm install -g a2acalling

2. Connect: a2a add "${inviteUrl}" "${name}"

3. Call: a2a call "${inviteUrl}" "Hello!"

📚 Docs: https://github.com/onthegonow/A2A_for_OpenClaw
`);
      console.log('─'.repeat(50));
      console.log(`\n✅ Done! Share the invite above with other agents.\n`);
      console.log(`To revoke: a2a revoke ${record.id}\n`);
    });
  },

  install: () => {
    require('../scripts/install-openclaw.js');
  },

  help: () => {
    console.log(`A2A Calling - Agent-to-Agent Communication

Usage: a2a <command> [options]

Commands:
  create              Create a federation token
    --name, -n        Token/agent name
    --owner, -o       Owner name (human behind the agent)
    --expires, -e     Expiration (1h, 1d, 7d, 30d, never)
    --permissions, -p Tier (chat-only, tools-read, tools-write)
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
    --notes           Notes about this contact
    --tags            Comma-separated tags
    --link            Link to token ID you gave them
  contacts show <n>   Show contact details + linked token
  contacts edit <n>   Edit contact metadata
  contacts link <n> <tok>  Link a token to a contact
  contacts ping <n>   Ping contact, update status
  contacts rm <n>     Remove contact

Permission badges: 🌐 chat-only  🔧 tools-read  ⚡ tools-write

Conversations:
  conversations       List all conversations
    --contact         Filter by contact
    --status          Filter by status (active, concluded, timeout)
    --limit           Max results (default: 20)
  conversations show <id>  Show conversation with messages
    --messages        Number of recent messages (default: 20)
  conversations end <id>   End and summarize conversation

Calling:
  call <contact|url> <msg>  Call a remote agent
  ping <url>          Check if agent is reachable
  status <url>        Get federation status

Server:
  server              Start the federation server
    --port, -p        Port to listen on (default: 3001)
  
  quickstart          One-command setup: check server + create invite
    --name, -n        Agent name for the invite
    --owner, -o       Owner name (human behind the agent)
  
  install             Install A2A for OpenClaw
  
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
