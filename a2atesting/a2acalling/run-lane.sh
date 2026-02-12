#!/usr/bin/env bash
set -euo pipefail

LANE="${1:-smoke}"
case "$LANE" in
  smoke|internet|nightly-real) ;;
  *)
    echo "Usage: $0 <smoke|internet|nightly-real>"
    exit 1
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_DIR="$ROOT_DIR/a2atesting/a2acalling"
IMAGE_TAG="a2atesting/a2acalling-e2e:local"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required"
  exit 1
fi

echo "[a2atesting] Building image: $IMAGE_TAG"
docker build \
  -f "$HARNESS_DIR/Dockerfile" \
  -t "$IMAGE_TAG" \
  "$ROOT_DIR"

echo "[a2atesting] Running lane: $LANE"
docker run --rm \
  -e A2A_E2E_LANE="$LANE" \
  -e A2A_REAL_INVITE_URL="${A2A_REAL_INVITE_URL:-}" \
  -e A2A_REAL_MESSAGE="${A2A_REAL_MESSAGE:-}" \
  -e A2A_REAL_TIMEOUT_MS="${A2A_REAL_TIMEOUT_MS:-}" \
  -e A2A_REAL_REQUIRED="${A2A_REAL_REQUIRED:-}" \
  -v "$ROOT_DIR:/workspace/a2acalling:rw" \
  "$IMAGE_TAG"
