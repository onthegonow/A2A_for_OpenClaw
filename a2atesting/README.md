# a2atesting

Per-app ephemeral Docker E2E harnesses for this server.

Current apps:
- `a2acalling/` - package-artifact install + split lanes (`smoke`, `nightly-real`)

Expansion pattern:
- Add one folder per app with the same interface:
  - `run-lane.sh <lane>`
  - `entrypoint.sh` (container runner)
  - `scenarios/<lane>.js`
  - `Dockerfile`
