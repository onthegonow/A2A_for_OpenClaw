---
name: a2a
description: "Agent-to-agent A2A for OpenClaw. Create tokens to let remote agents call yours as a subagent with scoped permissions. Use when setting up cross-instance agent communication, creating A2A tokens, managing remote agent access, or calling other OpenClaw agents."
metadata:
  {
    "openclaw":
      {
        "emoji": "🤝",
        "requires": { "bins": ["node"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "node",
              "package": "a2acalling",
              "bins": ["a2a"],
              "label": "Install A2A Calling (npm)",
            },
          ],
        "routes": "/api/a2a",
        "tools": ["a2a_call"],
      },
  }
---

# A2A

Enable agent-to-agent communication across OpenClaw instances.

## Commands

### Create Token

User says: `/a2a create`, "create an A2A token", "let another agent call me"

```bash
a2a create --name "NAME" --expires DURATION --permissions LEVEL
```

Options:
- `--name, -n` — Token label
- `--expires, -e` — `1h`, `1d`, `7d`, `30d`, `never` (default: `1d`)
- `--permissions, -p` — `chat-only`, `tools-read`, `tools-write` (default: `chat-only`)
- `--disclosure, -d` — `public`, `minimal`, `none` (default: `minimal`)
- `--notify` — `all`, `summary`, `none` (default: `all`)

Reply with the invite URL: `a2a://hostname/fed_xxxxx`

### List Tokens

```bash
a2a list
```

### Revoke Token

```bash
a2a revoke TOKEN_ID
```

### Add Remote Agent

When user shares an invite URL:

```bash
a2a add "a2a://host/token" "Agent Name"
```

## Calling Remote Agents

When task delegation to a known remote agent would help, or user asks to contact a A2A agent:

```javascript
// Use a2a_call tool
a2a_call({
  endpoint: "a2a://host/token",
  message: "Your question here",
  conversation_id: "optional-for-continuity"
})
```

## Handling Incoming Calls

When receiving an A2A call, the agent operates within the token's permission scope:

| Permission | Allowed |
|------------|---------|
| `chat-only` | Conversation only. No tools, files, memory. |
| `tools-read` | Chat + read-only tools |
| `tools-write` | Chat + read/write tools |

Apply disclosure level:
- `public` — Share any non-private info
- `minimal` — Direct answers only, no owner context
- `none` — Confirm capability only

## Owner Notifications

When `notify: all`, send to owner:

```
🤝 A2A call received

From: [Caller] ([host])
Token: "[name]" (expires [date])

---
[Transcript]
---

📊 [N] calls | Expires in [time]
```

Owner can reply to inject into the conversation.

## Rate Limits

Per token: 10/min, 100/hr, 1000/day

## Protocol Reference

See [docs/protocol.md](docs/protocol.md) for full specification.
