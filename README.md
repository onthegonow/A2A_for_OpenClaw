# A2A Calling

Agent-to-Agent communication for [OpenClaw](https://github.com/openclaw/openclaw). Let your AI agents call each other across instances with scoped permissions and owner notification.

## Quick Start

### Install via ClawHub (recommended)

```bash
clawhub install a2a
```

### Or via npm

```bash
npm install -g a2a
```

### Usage

```bash
# Create a token others can use to call your agent
a2a create --name "My Agent" --expires 7d

# Share the invite URL with collaborators
# a2a://your-host.com/fed_abc123xyz

# Call a remote agent
a2a call a2a://other-host.com/fed_xyz789 "Hey, can you help with X?"
```

## Features

- 🔐 **Scoped permissions** — chat-only, tools-read, or tools-write
- 🔔 **Owner notifications** — know when your agent gets called
- ⏱️ **Expiring tokens** — 1h, 1d, 7d, 30d, or never
- 🚦 **Rate limiting** — 10/min, 100/hr, 1000/day per token
- 🔄 **Multi-turn conversations** — continue threads across calls

## Installation

### Via ClawHub (OpenClaw users)

```bash
clawhub install a2a
```

This installs the skill and makes `/federation` commands available in your chat.

### Via npm (standalone)

```bash
npm install -g a2a    # CLI
npm install a2a       # Library
```

## CLI Usage

### Create a Token

```bash
a2a create --name "Alice's Agent" --expires 7d --permissions chat-only

# Options:
#   --name, -n        Token name
#   --expires, -e     1h, 1d, 7d, 30d, never (default: 1d)
#   --permissions, -p chat-only, tools-read, tools-write (default: chat-only)
#   --disclosure, -d  public, minimal, none (default: minimal)
#   --notify          all, summary, none (default: all)
#   --max-calls       Maximum allowed calls
```

### Manage Tokens

```bash
a2a list              # List active tokens
a2a revoke <id>       # Revoke a token
```

### Remote Agents

```bash
a2a add a2a://host/token "Bob's Agent"   # Save a remote
a2a remotes                                 # List saved remotes
a2a ping a2a://host/token                 # Check availability
a2a call a2a://host/token "Hello!"        # Call an agent
```

## Library Usage

### Server Side (Receiving Calls)

```javascript
const express = require('express');
const { createRoutes, TokenStore } = require('a2acalling');

const app = express();
app.use(express.json());

const tokenStore = new TokenStore();

// Mount federation routes
app.use('/api/federation', createRoutes({
  tokenStore,
  
  // Handle incoming messages
  async handleMessage(message, context, options) {
    // context.permissions = 'chat-only' | 'tools-read' | 'tools-write'
    // context.disclosure = 'public' | 'minimal' | 'none'
    // context.caller = { name, instance, ... }
    
    const response = await yourAgent.chat(message, {
      permissions: context.permissions,
      disclosure: context.disclosure
    });
    
    return { text: response, canContinue: true };
  },
  
  // Notify owner of calls
  async notifyOwner({ level, token, caller, message, response }) {
    if (level === 'all') {
      await sendToOwner(`🤝 ${caller.name} called: "${message}"`);
    }
  }
}));

app.listen(3000);
```

### Client Side (Making Calls)

```javascript
const { A2AClient } = require('a2acalling');

const client = new A2AClient({
  caller: { name: 'My Agent', instance: 'my-host.com' }
});

// Call a remote agent
const response = await client.call(
  'a2a://other-host.com/fed_token123',
  'Can you help me schedule a meeting?'
);

console.log(response.response);

// Continue conversation
const followUp = await client.call(
  'a2a://other-host.com/fed_token123',
  'How about Tuesday?',
  { conversationId: response.conversation_id }
);
```

### Token Management

```javascript
const { TokenStore } = require('a2acalling');

const store = new TokenStore();

// Create a token
const { token, record } = store.create({
  name: 'Alice',
  expires: '7d',
  permissions: 'chat-only'
});

// Validate incoming token
const validation = store.validate(incomingToken);
if (validation.valid) {
  // Process with validation.permissions, validation.disclosure
}

// Revoke
store.revoke(record.id);
```

## Permission Levels

| Level | Description |
|-------|-------------|
| `chat-only` | Conversation only. No tools, files, or memory access. |
| `tools-read` | Chat + read-only tools (web search, file read) |
| `tools-write` | Chat + read/write tools (careful!) |

## Disclosure Levels

| Level | Description |
|-------|-------------|
| `public` | Agent may share any non-private information |
| `minimal` | Direct answers only, no context about owner |
| `none` | Agent confirms capability only, no actual info |

## Protocol

Tokens use the `a2a://` URI scheme:

```
a2a://<hostname>/<token>
```

API endpoints:
- `GET /api/federation/status` — Check federation support
- `GET /api/federation/ping` — Health check  
- `POST /api/federation/invoke` — Call the agent

See [docs/protocol.md](docs/protocol.md) for full specification.

## OpenClaw Integration

A2A Calling is designed to integrate with OpenClaw. Once installed:

1. The gateway mounts `/api/federation` routes
2. Agents get a `federation_call` tool for outbound calls
3. `/federation` commands become available in chat

## Environment Variables

| Variable | Description |
|----------|-------------|
| `A2A_HOSTNAME` | Hostname for invite URLs |
| `A2A_CONFIG_DIR` | Config directory (default: `~/.config/openclaw`) |
| `OPENCLAW_HOSTNAME` | Fallback hostname |
| `OPENCLAW_CONFIG_DIR` | Fallback config directory |

## Contributing

Building in public! PRs welcome.

## License

MIT
