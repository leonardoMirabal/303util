#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${SCRIPT_DIR}/artifacts}"
WEB_ARTIFACT_DIR="${ARTIFACTS_DIR}/web"
APK_ARTIFACT_DIR="${ARTIFACTS_DIR}/apk"

if [ -z "${VITE_GOOGLE_CLIENT_ID:-}" ]; then
  echo "Error: VITE_GOOGLE_CLIENT_ID is required."
  exit 1
fi

mkdir -p "${ARTIFACTS_DIR}"
rm -rf "${WEB_ARTIFACT_DIR}" "${APK_ARTIFACT_DIR}"
mkdir -p "${WEB_ARTIFACT_DIR}" "${APK_ARTIFACT_DIR}"

echo "Building GitHub Pages bundle..."
bash "${SCRIPT_DIR}/prepare-dev-index.sh"
GH_PAGES=true npm run build
cp -R "${SCRIPT_DIR}/dist/." "${WEB_ARTIFACT_DIR}/"
(
  cd "${ARTIFACTS_DIR}"
  rm -f web-bundle.zip
  zip -qry web-bundle.zip web
)

echo "Building Android APK..."
if [ ! -d "${SCRIPT_DIR}/src-tauri/gen/android" ]; then
  echo "Initializing Android project..."
  npx tauri android init --ci --skip-targets-install
fi

npx tauri android build --apk --ci

mapfile -t apk_files < <(find "${SCRIPT_DIR}/src-tauri/gen/android/app/build/outputs/apk" -type f -name "*.apk" | sort)

if [ "${#apk_files[@]}" -eq 0 ]; then
  echo "Error: No APK files were generated."
  exit 1
fi

cp "${apk_files[@]}" "${APK_ARTIFACT_DIR}/"

echo "Artifacts ready in ${ARTIFACTS_DIR}"
