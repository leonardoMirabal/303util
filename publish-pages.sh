#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR}"
ROOT_DIR="$(cd "${APP_DIR}/.." && pwd)"
PAGES_DIR="${ROOT_DIR}/303util"
DIST_DIR="${APP_DIR}/dist"
REPO_NAME="303util"

if [ ! -d "${PAGES_DIR}/.git" ]; then
  echo "Error: ${PAGES_DIR} is not a git repository."
  exit 1
fi

echo "Building web app..."
cd "${APP_DIR}"
GH_PAGES=true npm run build

echo "Syncing dist -> 303util root (safe mode)..."
mkdir -p "${PAGES_DIR}"

if [ ! -d "${DIST_DIR}" ]; then
  echo "Error: ${DIST_DIR} does not exist."
  exit 1
fi

cp -f "${DIST_DIR}/index.html" "${PAGES_DIR}/index.html"

if [ -f "${DIST_DIR}/vite.svg" ]; then
  cp -f "${DIST_DIR}/vite.svg" "${PAGES_DIR}/vite.svg"
fi

if [ -f "${DIST_DIR}/tauri.svg" ]; then
  cp -f "${DIST_DIR}/tauri.svg" "${PAGES_DIR}/tauri.svg"
fi

if [ -d "${PAGES_DIR}/assets" ]; then
  rm -rf "${PAGES_DIR}/assets"
fi
cp -R "${DIST_DIR}/assets" "${PAGES_DIR}/assets"

echo "Staging publish files..."
git add -A index.html assets vite.svg tauri.svg

echo "Done. Next:"
echo "  cd ${PAGES_DIR}"
echo "  git commit -m \"Publish built site\" && git push"
echo
echo "Repo ready for push. Current status:"
git --no-pager status --short
