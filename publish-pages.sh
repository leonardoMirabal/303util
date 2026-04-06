#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR}"
ROOT_DIR="$(cd "${APP_DIR}/.." && pwd)"
PAGES_DIR="${ROOT_DIR}/303util"
DIST_DIR="${APP_DIR}/dist"

write_source_index() {
  cat > "${APP_DIR}/index.html" <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <link rel="apple-touch-icon" href="/app-thumbnail.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#2b3037" />
    <meta property="og:image" content="/app-thumbnail.png" />
    <meta name="twitter:image" content="/app-thumbnail.png" />
    <title>303 util</title>
  </head>

  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF
}

if [ ! -d "${PAGES_DIR}/.git" ]; then
  echo "Error: ${PAGES_DIR} is not a git repository."
  exit 1
fi

echo "Building web app..."
cd "${APP_DIR}"
write_source_index
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

if [ -f "${DIST_DIR}/app-thumbnail.png" ]; then
  cp -f "${DIST_DIR}/app-thumbnail.png" "${PAGES_DIR}/app-thumbnail.png"
fi

if [ -f "${DIST_DIR}/tauri.svg" ]; then
  cp -f "${DIST_DIR}/tauri.svg" "${PAGES_DIR}/tauri.svg"
fi

if [ -d "${PAGES_DIR}/assets" ]; then
  rm -rf "${PAGES_DIR}/assets"
fi
cp -R "${DIST_DIR}/assets" "${PAGES_DIR}/assets"

echo "Staging publish files..."
git add -A index.html assets vite.svg app-thumbnail.png tauri.svg

echo "Done. Next:"
echo "  cd ${PAGES_DIR}"
echo "  git commit -m \"Publish built site\" && git push"
echo
echo "Repo ready for push. Current status:"
git --no-pager status --short
