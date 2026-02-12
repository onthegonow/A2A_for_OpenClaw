# CLAUDE.md - A2A for OpenClaw

## Quick Context

A2A Calling enables agent-to-agent communication across OpenClaw instances. Users create tokens with scoped permissions, share invite URLs, and remote agents can call in.

## GitHub Access

```bash
# Token in .env (gitignored)
source .env
# Or for git operations:
git remote set-url origin https://${GH_TOKEN}@github.com/onthegonow/A2A_for_OpenClaw.git
```

## What This Does

1. **Token Management** - Create expiring tokens with permissions (chat-only/tools-read/tools-write)
2. **Inbound Calls** - Express routes handle `/api/a2a/invoke` from remote agents
3. **Outbound Calls** - `A2AClient` calls remote agents via their invite URLs
4. **Owner Notifications** - Configurable alerts when your agent gets called

## Token Flow

```
User: /a2a create --name "Alice" --expires 7d
Bot:  ✅ a2a://myhost.com/fed_abc123

User shares URL with Alice...

Alice's agent: POST /api/a2a/invoke
               Authorization: Bearer fed_abc123
               {"message": "Hey, can you help?"}

Your agent responds within permission scope.
You get notified (if configured).
```

## Files to Know

- `src/lib/tokens.js` - All token CRUD + validation
- `src/lib/client.js` - `A2AClient` for outbound calls
- `src/routes/a2a.js` - Express router (mount at `/api/a2a`)
- `docs/protocol.md` - Full protocol spec

## Testing

```bash
node bin/cli.js create --name "Test" --expires 1h
node bin/cli.js list
node bin/cli.js revoke <id>
```
