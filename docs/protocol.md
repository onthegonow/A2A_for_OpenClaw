# A2A Protocol v0 Reference

## Overview

A2A enables OpenClaw agents to call each other across instances with scoped permissions and owner notification.

## Token Format

```
a2a://<hostname>/<token>
```

Example: `a2a://my-server.example.com/fed_abc123xyz`

Token structure: `fed_<base64url(24 random bytes)>`

## API Endpoints

All endpoints are prefixed with `/api/a2a/`

### GET /status

Check if A2A is enabled.

Response:
```json
{
  "a2a": true,
  "version": "0.1.0",
  "capabilities": ["invoke", "multi-turn"],
  "rate_limits": {
    "per_minute": 10,
    "per_hour": 100,
    "per_day": 1000
  }
}
```

### GET /ping

Health check endpoint.

Response:
```json
{
  "pong": true,
  "timestamp": "2026-02-11T17:54:00Z"
}
```

### POST /invoke

Call the agent.

Headers:
```
Authorization: Bearer fed_abc123xyz
Content-Type: application/json
```

Request body:
```json
{
  "message": "Your question or request",
  "conversation_id": "optional-for-multi-turn",
  "caller": {
    "name": "Alice's Agent",
    "instance": "alice.example.com",
    "context": "Why I'm calling"
  },
  "timeout_seconds": 60
}
```

Success response:
```json
{
  "success": true,
  "conversation_id": "conv_123456",
  "response": "The agent's response text",
  "can_continue": true,
  "tokens_remaining": 47
}
```

Error responses:
```json
{"success": false, "error": "token_expired", "message": "..."}
{"success": false, "error": "token_revoked", "message": "..."}
{"success": false, "error": "permission_denied", "message": "..."}
{"success": false, "error": "rate_limited", "message": "..."}
{"success": false, "error": "missing_token", "message": "..."}
{"success": false, "error": "missing_message", "message": "..."}
```

### POST /end

Explicitly end a conversation and trigger conclusion/summarization.

Headers:
```
Authorization: Bearer fed_abc123xyz
Content-Type: application/json
```

Request body:
```json
{
  "conversation_id": "conv_123456"
}
```

Success response:
```json
{
  "success": true,
  "conversation_id": "conv_123456",
  "status": "concluded",
  "summary": "Optional summary text"
}
```

Error responses:
```json
{"success": false, "error": "unauthorized", "message": "..."}
{"success": false, "error": "missing_conversation_id", "message": "..."}
{"success": false, "error": "internal_error", "message": "..."}
```

## Traceability and Log APIs

A2A persists structured runtime logs to `~/.config/openclaw/a2a-logs.db` (or `$A2A_CONFIG_DIR/a2a-logs.db`).

Primary log fields:
- `trace_id`
- `conversation_id`
- `token_id`
- `error_code`
- `status_code`
- `hint`

Dashboard API endpoints:
- `GET /api/a2a/dashboard/logs`
- `GET /api/a2a/dashboard/logs/trace/:traceId`
- `GET /api/a2a/dashboard/logs/stats`

Example filters for `/logs`: `trace_id`, `conversation_id`, `token_id`, `error_code`, `status_code`, `component`, `event`, `level`, `search`, `from`, `to`.

## Permission Scopes

| Scope | Tools | Files | Memory | Actions |
|-------|-------|-------|--------|---------|
| `chat-only` | ❌ | ❌ | ❌ | ❌ |
| `tools-read` | Read | Read | ❌ | ❌ |
| `tools-write` | All | All | ❌ | Notify owner |

## Disclosure Levels

| Level | Behavior |
|-------|----------|
| `public` | Agent may share any non-private information |
| `minimal` | Agent gives direct answers only, no context about owner |
| `none` | Agent confirms capability only, provides no actual information |

## Token Storage Schema

Stored in `~/.config/openclaw/a2a.json`:

```json
{
  "tokens": [
    {
      "id": "fed_abc123xyz789",
      "token_hash": "sha256...",
      "name": "Alice's agent",
      "permissions": "chat-only",
      "disclosure": "minimal",
      "notify": "all",
      "max_calls": null,
      "calls_made": 5,
      "created_at": "2026-02-11T17:54:00Z",
      "expires_at": "2026-02-18T17:54:00Z",
      "last_used": "2026-02-12T10:30:00Z",
      "revoked": false
    }
  ],
  "remotes": [
    {
      "id": "remote_xyz",
      "name": "Bob's agent",
      "host": "bob.example.com",
      "token": "fed_bobtoken123",
      "added_at": "2026-02-11T18:00:00Z"
    }
  ],
  "calls": []
}
```

## Rate Limits

Default per-token limits:
- 10 requests per minute
- 100 requests per hour
- 1000 requests per day

Limits reset on natural boundaries (minute, hour, day UTC).

## Security Considerations

1. **Token hashing**: Tokens stored as SHA-256 hashes server-side
2. **TLS required**: All A2A calls should use HTTPS
3. **No credential forwarding**: Tokens are never forwarded to other agents
4. **Audit logging**: All invocations are logged with caller info
5. **Auto-revocation**: Tokens may auto-revoke after repeated errors

## Multi-turn Conversations

To continue a conversation, include `conversation_id` from the previous response:

```json
{
  "message": "Follow-up question",
  "conversation_id": "conv_123456"
}
```

When finished, either:
- Call `POST /end` with the same `conversation_id` for explicit conclusion, or
- Let the receiver auto-conclude on idle timeout/max duration (if enabled).

Conversations expire after 1 hour of inactivity.

## Owner Notifications

When `notify: all`:
```
🤝 A2A call received

From: Alice's Agent (alice.example.com)
Token: "Work collab" (expires 2026-02-18)

---
Alice's Agent: Does Ben have time this week?
You: Ben is available Thursday 2-4pm.
---

📊 5 of unlimited calls | Token expires in 6d
```

Owner can reply to inject into the conversation.

## OpenClaw Integration

### Gateway Route Registration

Add to gateway routes:
```javascript
const a2a = require('./skills/a2a/scripts/server');
app.use('/api/a2a', a2a);
```

### Agent Context

When handling an A2A call, inject context:
```json
{
  "a2a": {
    "active": true,
    "caller": "Alice's Agent",
    "permissions": "chat-only",
    "disclosure": "minimal"
  }
}
```

### New Tool: a2a_call

```typescript
a2a_call({
  endpoint: string,    // a2a:// URL
  message: string,     // Message to send
  conversation_id?: string  // For multi-turn
}): {
  success: boolean,
  response?: string,
  conversation_id?: string,
  error?: string
}
```

## Future Protocol Extensions (v1+)

- **Capability advertisement**: Agents declare what they can help with
- **Cryptographic identity**: Ed25519 signatures for caller verification
- **Streaming responses**: SSE for long-running operations
- **Webhooks**: Push notifications instead of polling
- **Payments**: Token-gated access with usage billing
