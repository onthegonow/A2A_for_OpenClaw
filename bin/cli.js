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
    const invite = `🤝 Agent-to-Agent Invite

${record.name} is inviting your agent to connect!

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
    const remotes = store.listRemotes();
    if (remotes.length === 0) {
      console.log('No remote agents registered.');
      return;
    }

    console.log('Remote agents:\n');
    for (const r of remotes) {
      console.log(`📡 ${r.name}`);
      console.log(`   Host: ${r.host}`);
      console.log(`   Added: ${r.added_at}`);
      console.log();
    }
  },

  call: async (args) => {
    const url = args._[1];
    const message = args._.slice(2).join(' ') || args.flags.message || args.flags.m;

    if (!url || !message) {
      console.error('Usage: a2a call <invite_url> <message>');
      process.exit(1);
    }

    const client = new A2AClient({
      caller: { name: args.flags.name || 'CLI User' }
    });

    try {
      console.log(`📞 Calling ${url}...`);
      const response = await client.call(url, message);
      console.log(`\n✅ Response:\n`);
      console.log(response.response);
      if (response.conversation_id) {
        console.log(`\n📝 Conversation ID: ${response.conversation_id}`);
      }
    } catch (err) {
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

  install: () => {
    require('../scripts/install-openclaw.js');
  },

  help: () => {
    console.log(`A2A Calling - Agent-to-Agent Communication

Usage: a2a <command> [options]

Commands:
  create              Create a federation token
    --name, -n        Token name
    --expires, -e     Expiration (1h, 1d, 7d, 30d, never)
    --permissions, -p Permission level (chat-only, tools-read, tools-write)
    --disclosure, -d  Disclosure level (public, minimal, none)
    --notify          Owner notification (all, summary, none)
    --max-calls       Maximum invocations (default: 100)

  list                List active tokens
  revoke <id>         Revoke a token
  
  add <url> [name]    Add a remote agent
  remotes             List remote agents
  
  call <url> <msg>    Call a remote agent
  ping <url>          Check if agent is reachable
  status <url>        Get federation status

  server              Start the federation server
    --port, -p        Port to listen on (default: 3001)
  
  install             Install A2A for OpenClaw
  
Examples:
  a2a create --name "Alice" --expires 7d
  a2a call oclaw://host/fed_xxx "Hello, can you help?"
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
