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
    // Parse max-calls: number, 'unlimited', or default (100)
    let maxCalls = 100; // Safe default
    if (args.flags['max-calls']) {
      if (args.flags['max-calls'] === 'unlimited') {
        maxCalls = null;
      } else {
        maxCalls = parseInt(args.flags['max-calls']) || 100;
      }
    }

    const { token, record } = store.create({
      name: args.flags.name || args.flags.n || 'unnamed',
      owner: args.flags.owner || args.flags.o || null,
      expires: args.flags.expires || args.flags.e || '1d',
      permissions: args.flags.permissions || args.flags.p || 'chat-only',
      disclosure: args.flags.disclosure || args.flags.d || 'minimal',
      notify: args.flags.notify || 'all',
      maxCalls
    });

    const hostname = getHostname();
    const inviteUrl = `oclaw://${hostname}/${token}`;

    const expiresText = record.expires_at 
      ? new Date(record.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'never';

    console.log(`✅ Federation token created\n`);
    console.log(`Name: ${record.name}`);
    if (record.owner) console.log(`Owner: ${record.owner}`);
    console.log(`Expires: ${record.expires_at || 'never'}`);
    console.log(`Permissions: ${record.permissions}`);
    console.log(`Disclosure: ${record.disclosure}`);
    console.log(`Notify: ${record.notify}`);
    console.log(`Max calls: ${record.max_calls || 'unlimited'}`);
    console.log(`\nTo revoke: a2a revoke ${record.id}`);
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📋 SHAREABLE INVITE (copy everything below):`);
    console.log(`${'─'.repeat(50)}\n`);
    
    // Generate shareable invite block
    const maxCallsText = record.max_calls ? `${record.max_calls} calls` : 'unlimited';
    const ownerText = record.owner ? `${record.owner}'s agent ${record.name}` : record.name;
    const invite = `🤝 Agent-to-Agent Invite

${ownerText} is inviting your agent to connect!

📡 Connection URL:
${inviteUrl}

⏰ Expires: ${expiresText}
🔐 Permissions: ${record.permissions}
📊 Limits: ${maxCallsText} total, 10/min rate limit

━━━ Quick Setup ━━━

1. Install A2A Calling:
   npm install -g a2acalling

2. Add this remote:
   a2a add "${inviteUrl}" "${record.name}"

3. Call the agent:
   a2a call "${inviteUrl}" "Hello!"

Or in code:
   const { A2AClient } = require('a2acalling');
   const client = new A2AClient({ caller: { name: 'Your Agent' } });
   await client.call('${inviteUrl}', 'Hello!');

📚 Docs: https://github.com/onthegonow/A2A_for_OpenClaw`;

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
      console.log(`${status}  ${t.id}`);
      console.log(`   Name: ${t.name}`);
      console.log(`   Permissions: ${t.permissions}`);
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
      const trustBadge = r.trust === 'trusted' ? ' ⭐' : r.trust === 'verified' ? ' ✓' : '';
      console.log(`${statusIcon} ${r.name}${ownerText}${trustBadge}`);
      if (r.tags && r.tags.length > 0) {
        console.log(`   🏷️  ${r.tags.join(', ')}`);
      }
      if (r.last_seen) {
        const ago = formatTimeAgo(new Date(r.last_seen));
        console.log(`   📍 Last seen: ${ago}`);
      }
      console.log();
    }
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
      console.error('  --trust        Trust level (trusted, verified, unknown)');
      process.exit(1);
    }

    const options = {
      name: args.flags.name || args.flags.n,
      owner: args.flags.owner || args.flags.o,
      notes: args.flags.notes,
      tags: args.flags.tags ? args.flags.tags.split(',').map(t => t.trim()) : [],
      trust: args.flags.trust || 'unknown'
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

    const remote = store.getRemote(name);
    if (!remote) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    const statusIcon = remote.status === 'online' ? '🟢' : remote.status === 'offline' ? '🔴' : '⚪';
    const trustBadge = remote.trust === 'trusted' ? '⭐ Trusted' : remote.trust === 'verified' ? '✓ Verified' : '? Unknown';

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`${statusIcon} ${remote.name}`);
    console.log(`${'═'.repeat(50)}\n`);
    
    if (remote.owner) console.log(`👤 Owner: ${remote.owner}`);
    console.log(`🌐 Host: ${remote.host}`);
    console.log(`🔐 Trust: ${trustBadge}`);
    
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
    console.log(`  a2a contacts edit ${name} --trust trusted`);
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
      console.error('  --trust        Trust level (trusted, verified, unknown)');
      process.exit(1);
    }

    const updates = {};
    if (args.flags.name) updates.name = args.flags.name;
    if (args.flags.owner) updates.owner = args.flags.owner;
    if (args.flags.notes) updates.notes = args.flags.notes;
    if (args.flags.tags) updates.tags = args.flags.tags.split(',').map(t => t.trim());
    if (args.flags.trust) updates.trust = args.flags.trust;

    if (Object.keys(updates).length === 0) {
      console.error('No updates specified. Use --name, --owner, --notes, --tags, or --trust');
      process.exit(1);
    }

    const result = store.updateRemote(name, updates);
    if (!result.success) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    console.log(`✅ Contact updated: ${result.remote.name}`);
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
    const url = `oclaw://${remote.host}/${remote.token}`;

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
    if (!target.startsWith('oclaw://')) {
      const remote = store.getRemote(target);
      if (remote) {
        url = `oclaw://${remote.host}/${remote.token}`;
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

      const inviteUrl = `oclaw://${hostname}/${token}`;
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
    --permissions, -p Permission level (chat-only, tools-read, tools-write)
    --disclosure, -d  Disclosure level (public, minimal, none)
    --notify          Owner notification (all, summary, none)
    --max-calls       Maximum invocations (default: 100)

  list                List active tokens
  revoke <id>         Revoke a token

Contacts:
  contacts            List all contacts
  contacts add <url>  Add a contact
    --name, -n        Agent name
    --owner, -o       Owner name
    --notes           Notes about this contact
    --tags            Comma-separated tags
    --trust           Trust level (trusted, verified, unknown)
  contacts show <n>   Show contact details
  contacts edit <n>   Edit contact metadata
  contacts ping <n>   Ping contact, update status
  contacts rm <n>     Remove contact

Legacy:
  add <url> [name]    Add a remote (use 'contacts add')
  remotes             List remotes (use 'contacts')
  
  call <url> <msg>    Call a remote agent
  ping <url>          Check if agent is reachable
  status <url>        Get federation status

  server              Start the federation server
    --port, -p        Port to listen on (default: 3001)
  
  quickstart          One-command setup: check server + create invite
    --name, -n        Agent name for the invite
    --owner, -o       Owner name (human behind the agent)
  
  install             Install A2A for OpenClaw
  
Examples:
  a2a create --name "bappybot" --owner "Benjamin Pollack" --expires 7d
  a2a contacts add oclaw://host/fed_xxx --name "Alice" --owner "Alice Chen" --trust verified
  a2a contacts ping Alice
  a2a call Alice "Hello!"
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
