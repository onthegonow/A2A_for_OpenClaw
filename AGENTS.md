# Agent Runbook (A2A for OpenClaw)

This file is the operational source of truth for AI agents working in this repository.

## GitHub Access

GitHub token is stored in `.env` (gitignored). Load it before git operations:

```bash
export GH_TOKEN=$(grep GH_TOKEN .env | cut -d= -f2)
git remote set-url origin https://${GH_TOKEN}@github.com/onthegonow/A2A_for_OpenClaw.git
```

Or use `gh` CLI which reads `GH_TOKEN` automatically.

## Project Structure

```
a2acalling/
├── bin/cli.js           # CLI entry point (a2a command)
├── src/
│   ├── index.js         # Main library export
│   ├── lib/
│   │   ├── tokens.js    # Token storage & validation
│   │   └── client.js    # Outbound A2A client
│   └── routes/
│       └── a2a.js # Express routes for /api/a2a
├── docs/
│   └── protocol.md      # Protocol specification
└── .env                  # Secrets (gitignored)
```

## Development Commands

```bash
# Test CLI
node bin/cli.js help
node bin/cli.js create --name "Test" --expires 1h

# Test library
node -e "const a2a = require('./src'); console.log(a2a.version)"
```

## Key Design Decisions

1. **Token format**: `a2a://<host>/<token>` - simple, copy-pasteable
2. **Permission presets**: `chat-only` (default), `tools-read`, `tools-write`  
3. **Disclosure levels**: `public`, `minimal` (default), `none`
4. **Rate limits**: 10/min, 100/hr, 1000/day per token
5. **Storage**: JSON file at `~/.config/openclaw/a2a.json`

## Integration Points

This package is designed to integrate with OpenClaw:

1. **Gateway routes**: Mount `createRoutes()` at `/api/a2a`
2. **Agent tool**: Add `a2a_call` tool using `A2AClient`
3. **Commands**: Wire `/a2a` commands to CLI functions

## Commit Convention

Use conventional commits:
- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation
- `refactor:` code changes without feature/fix
