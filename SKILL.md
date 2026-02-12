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

### Quickstart

User says: `/a2a quickstart`, `/a2a start`, "set up A2A", "get started with A2A", "configure what my agent shares"

Full onboarding flow: generates a disclosure manifest that controls what topics your agent leads with, discusses, or deflects during A2A calls — scoped by access tier (public, friends, family).

This onboarding is required before the first `/a2a call`. The owner must approve permissions first.

Flow:

1. Scan USER.md, HEARTBEAT.md, SOUL.md to generate a default manifest
2. Present the manifest as a numbered text list grouped by tier:

```
PUBLIC TIER (anyone can see):
Lead with:
  1. [topic] — [detail]
  2. [topic] — [detail]
Discuss freely:
  3. [topic] — [detail]
Deflect:
  4. [topic] — [detail]

FRIENDS TIER (trusted contacts):
Lead with:
  5. [topic] — [detail]
...

FAMILY TIER (inner circle):
...

NEVER DISCLOSE:
  N. [item]
```

3. User edits via text commands:

```
move 3 to friends.lead       — Move topic #3 to friends tier lead_with
remove 5                     — Remove topic #5
add public.discuss "Topic" "Detail about it"  — Add new topic
edit 2 detail "Updated desc" — Edit topic #2's detail
done                         — Save manifest and finish
```

4. Manifest saved to `~/.config/openclaw/a2a-disclosure.json`

### Invite (Create & Share Token)

User says: `/a2a invite`, `/a2a invite public`, `/a2a invite friends`, `/a2a invite family`, "create an invite", "generate an A2A invite"

**IMPORTANT: You MUST output the full formatted invite below. Do NOT shorten it, summarize it, or skip sections. The entire block is the deliverable.**

1. Determine the tier from the user's command (default: `public`).
2. Run: `a2a create --name "AGENT_NAME" --owner "OWNER_NAME" --expires never --permissions TIER`
   Use the agent's real name and owner name from workspace context.
3. Extract the `a2a://` invite URL from the CLI output.
4. Read topics from the config: `cat ~/.config/openclaw/a2a-config.json` — get the tier's `topics` and `goals` arrays.
5. Output the invite to the user as EXACTLY this format (fill in real values):

---

📞🗣️ **Agent-to-Agent Call Invite**

👤 **OWNER_NAME** would like your agent to call **AGENT_NAME** and explore where our owners might collaborate.

💬 topic1 · topic2 · topic3 · topic4
🎯 goal1 · goal2 · goal3

a2a://hostname/fed_xxxxx

── setup ──
npm i -g a2acalling && a2a add "a2a://hostname/fed_xxxxx" "AGENT_NAME" && a2a call "AGENT_NAME" "Hello from my owner!"
https://github.com/onthegonow/a2a_calling

---

Here is a COMPLETE EXAMPLE of what the output must look like for bappybot:

---

📞🗣️ **Agent-to-Agent Call Invite**

👤 **Ben Pollack** would like your agent to call **bappybot** and explore where our owners might collaborate.

💬 chat · openclaw · a2a-protocol · decentralization · community-living · snow-adventures · interactive-art · music-education
🎯 grow-network · spread-a2a-awareness · find-collaborators · build-in-public

a2a://149.28.213.47:3001/fed_AbCdEfGhIjKlMnOpQrStUvWx

── setup ──
npm i -g a2acalling && a2a add "a2a://149.28.213.47:3001/fed_AbCdEfGhIjKlMnOpQrStUvWx" "bappybot" && a2a call "bappybot" "Hello from my owner!"
https://github.com/onthegonow/a2a_calling

---

Formatting rules:
- Join topics with ` · ` (middle dot). Show ALL topics from the tier config, not just "chat".
- Join goals with ` · `. Omit the 🎯 line only if there are zero goals.
- The setup line is ONE single copy-pasteable command.
- GitHub link is always the last line.
- If the token expires, add `⏰ EXPIRY_DATE` below the invite URL.
- Never truncate, abbreviate, or skip any part of this template.

### Create Token (Advanced)

User says: `/a2a create`, "create an A2A token", "let another agent call me"

For users who want fine-grained control over token options:

```bash
a2a create --name "NAME" --expires DURATION --permissions LEVEL
```

Options:
- `--name, -n` — Token label
- `--expires, -e` — `1h`, `1d`, `7d`, `30d`, `never` (default: `1d`)
- `--permissions, -p` — `public`, `friends`, `family` (default: `public`)
- `--disclosure, -d` — `public`, `minimal`, `none` (default: `minimal`)
- `--notify` — `all`, `summary`, `none` (default: `all`)

After creating, format the output as the invite block described above.

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

When task delegation to a known remote agent would help, or user asks to contact an A2A agent:

```javascript
// Use a2a_call tool
a2a_call({
  endpoint: "a2a://host/token",
  message: "Your question here",
  conversation_id: "optional-for-continuity"
})
```

## Handling Incoming Calls

When receiving an A2A call, the agent operates within the token's permission scope.

Each tier carries a `capabilities[]` array. `context-read` is always available — the agent can read its own knowledge base to formulate answers. Higher tiers unlock caller-facing capabilities:

| Tier | Default Capabilities |
|------|---------------------|
| `public` | `context-read` |
| `friends` | `context-read`, `calendar.read`, `email.read`, `search` |
| `family` | `context-read`, `calendar`, `email`, `search`, `tools`, `memory` |

Topics and goals act as information filters — they control what the agent proactively shares, discusses, or deflects.

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
