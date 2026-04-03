#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR}"
ROOT_DIR="$(cd "${APP_DIR}/.." && pwd)"
PAGES_DIR="${ROOT_DIR}/303util"
DIST_DIR="${APP_DIR}/dist"

if [ ! -d "${PAGES_DIR}/.git" ]; then
  echo "Error: ${PAGES_DIR} is not a git repository."
  exit 1
fi

echo "Building web app..."
cd "${APP_DIR}"
npm run build

echo "Syncing dist -> 303util root..."
mkdir -p "${PAGES_DIR}"
find "${PAGES_DIR}" -mindepth 1 -maxdepth 1 ! -name ".git" -exec rm -rf {} +
cp -R "${DIST_DIR}/." "${PAGES_DIR}/"

echo "Done. Next:"
echo "  cd ${PAGES_DIR}"
echo "  git add -A && git commit -m \"Publish built site\" && git push"
