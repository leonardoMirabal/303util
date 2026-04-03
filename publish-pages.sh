#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR}"
DIST_DIR="${APP_DIR}/dist"

if [ ! -d "${APP_DIR}/.git" ]; then
  echo "Error: ${APP_DIR} is not a git repository."
  exit 1
fi

echo "Building web app..."
cd "${APP_DIR}"
npm run build

echo "Syncing dist -> publish files in repo root..."
cp "${DIST_DIR}/index.html" "${APP_DIR}/index.html"
if [ -f "${DIST_DIR}/tauri.svg" ]; then cp "${DIST_DIR}/tauri.svg" "${APP_DIR}/tauri.svg"; fi
if [ -f "${DIST_DIR}/vite.svg" ]; then cp "${DIST_DIR}/vite.svg" "${APP_DIR}/vite.svg"; fi
rm -rf "${APP_DIR}/assets"
mkdir -p "${APP_DIR}/assets"
cp -R "${DIST_DIR}/assets/." "${APP_DIR}/assets/"

echo "Done. Next:"
echo "  cd ${APP_DIR}"
echo "  git add -A && git commit -m \"Publish built site\" && git push"
