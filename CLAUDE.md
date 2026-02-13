# CLAUDE.md - A2A for OpenClaw

## Quick Context

A2A Calling enables agent-to-agent communication across OpenClaw instances. Users create tokens with scoped permissions, share invite URLs, and remote agents can call in.

## GitHub Access

```bash
# Maintainer tokens live in .env (gitignored). DO NOT COMMIT or delete this file.
set -a
source .env
set +a

# Recommended: use gh for git auth (avoid embedding tokens in remotes)
gh auth status
gh auth setup-git
```

## Publishing (GitHub + npm Together)

This repo is published as both:
- GitHub: `onthegonow/a2a_calling`
- npm: `a2acalling`

Required `.env` keys (gitignored):
- `GH_TOKEN` (GitHub PAT)
- `NPM_TOKEN` (npm publish token)

Quick release checklist:

```bash
npm version patch --no-git-tag-version
npm test
git add package.json
git commit -m "chore: release $(node -p \"require('./package.json').version\")"
env -u GIT_ASKPASS -u VSCODE_GIT_ASKPASS_NODE -u VSCODE_GIT_IPC_HANDLE -u VSCODE_GIT_IPC_AUTH_TOKEN git push origin main
npm_config_cache=/tmp/npm-cache npm publish --access public
VERSION=$(node -p "require('./package.json').version")
git tag "v${VERSION}"
env -u GIT_ASKPASS -u VSCODE_GIT_ASKPASS_NODE -u VSCODE_GIT_IPC_HANDLE -u VSCODE_GIT_IPC_AUTH_TOKEN git push origin "v${VERSION}"
gh release create "v${VERSION}" --generate-notes
```

## What This Does

1. **Token Management** - Create expiring tokens with tier-based permissions (public/friends/family) and capabilities
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
