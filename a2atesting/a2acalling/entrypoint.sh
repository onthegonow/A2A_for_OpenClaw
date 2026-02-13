#!/usr/bin/env bash
set -euo pipefail

LANE="${A2A_E2E_LANE:-smoke}"
REPO_DIR="/workspace/a2acalling"
WORK_DIR="/tmp/a2a-e2e-work"
NPM_CACHE_DIR="/tmp/a2a-e2e-npm-cache"

if [[ ! -f "$REPO_DIR/package.json" ]]; then
  echo "[a2atesting] expected package.json at $REPO_DIR"
  exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
mkdir -p "$NPM_CACHE_DIR"
export NPM_CONFIG_CACHE="$NPM_CACHE_DIR"

cd "$REPO_DIR"
PACKAGE_TGZ="$(npm pack --silent)"
PACKAGE_TGZ="${PACKAGE_TGZ##*$'\n'}"
PACKAGE_PATH="$REPO_DIR/$PACKAGE_TGZ"

cleanup() {
  rm -f "$PACKAGE_PATH"
}
trap cleanup EXIT

cd "$WORK_DIR"
npm init -y >/dev/null 2>&1
npm install --silent "$PACKAGE_PATH"

cp /opt/a2atesting/scenarios/*.js "$WORK_DIR/"

case "$LANE" in
  smoke)
    node "$WORK_DIR/smoke-lane.js" "$REPO_DIR"
    ;;
  public-port)
    node "$WORK_DIR/public-port-lane.js" "$REPO_DIR"
    ;;
  nightly-real)
    node "$WORK_DIR/nightly-real-lane.js" "$REPO_DIR"
    ;;
  *)
    echo "[a2atesting] unknown lane: $LANE"
    exit 1
    ;;
esac
