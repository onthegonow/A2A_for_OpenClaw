# A2A Calling E2E Harness

This harness runs end-to-end tests in an ephemeral Docker container using a packed npm artifact.

Lanes:
- `smoke`: deterministic PR-safe black-box flow (two local A2A servers)
- `internet`: forced subagent hop + Cloudflare Quick Tunnel round-trip (A->B and B->C both traverse the internet)
- `public-port`: remote probe lane (GitHub runner calls your server on its real public URL/port; asserts trace logs and forced subagent marker)
- `nightly-real`: optional real-runtime canary lane (external integration)

## Run Locally

```bash
# from repo root
./a2atesting/a2acalling/run-lane.sh smoke

# internet round-trip (downloads cloudflared on first run)
./a2atesting/a2acalling/run-lane.sh internet

# public port probe (requires env vars)
A2A_PUBLIC_BASE_URL="http://your-public-host:3001" A2A_PUBLIC_ADMIN_TOKEN="..." ./a2atesting/a2acalling/run-lane.sh public-port

# nightly-real (requires env vars)
A2A_REAL_INVITE_URL="a2a://host/token" ./a2atesting/a2acalling/run-lane.sh nightly-real
```

## Required Env (nightly-real)

- `A2A_REAL_INVITE_URL` - invite URL for target real endpoint

Optional:
- `A2A_REAL_MESSAGE` - custom prompt message
- `A2A_REAL_TIMEOUT_MS` - client timeout override

## Required Env (public-port)

- `A2A_PUBLIC_BASE_URL` - public base URL of the server under test (example: `http://your-host:3001` or `https://a2a.example.com`)\n+- `A2A_PUBLIC_ADMIN_TOKEN` - admin token configured on that server (sent as `x-admin-token`)\n+\nOptional:\n+- `A2A_PUBLIC_EXPECT_MARKER` - marker string required in the invoke response (default: `SUBAGENT_OK`)\n+- `A2A_PUBLIC_REQUIRED` - set `1` to fail instead of skipping when vars are missing

## What Smoke Verifies

1. Fresh package artifact install (`npm pack` -> `npm install <tgz>`)
2. Two isolated server instances with separate config/log DBs
3. Call flow: invoke -> continue -> end
4. Traceability APIs: `/logs`, `/logs/trace/:traceId`, `/logs/stats`
5. DB persistence checks in `a2a-logs.db` and `a2a-conversations.db`
6. Failure-injection check for invalid token (`TOKEN_INVALID_OR_EXPIRED` + hint)

## What Internet Verifies

Everything in `smoke`, plus:

1. Cloudflare Quick Tunnel internet ingress/egress works
2. A->B calls traverse the internet (caller uses `https://*.trycloudflare.com/...`)
3. B->C subagent hop also traverses the internet (bridge calls C via quick tunnel)

## Notes

- This sandbox cannot create `/root/a2atesting` directly. If you want the folder at server root, copy this directory there:

```bash
cp -r /root/a2acalling/a2atesting /root/a2atesting
```
