#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

DEFAULT_SDK_CANDIDATES=(
  "${ANDROID_HOME:-}"
  "${ANDROID_SDK_ROOT:-}"
  "$HOME/Library/Android/sdk"
  "/opt/homebrew/share/android-commandlinetools"
)

ANDROID_SDK_DIR=""
for candidate in "${DEFAULT_SDK_CANDIDATES[@]}"; do
  if [ -n "${candidate}" ] && [ -d "${candidate}" ]; then
    ANDROID_SDK_DIR="${candidate}"
    break
  fi
done

if [ -z "${ANDROID_SDK_DIR}" ]; then
  echo "Error: could not find an Android SDK directory."
  exit 1
fi

export ANDROID_HOME="${ANDROID_SDK_DIR}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_DIR}"
export PATH="${ANDROID_SDK_DIR}/platform-tools:${ANDROID_SDK_DIR}/emulator:${ANDROID_SDK_DIR}/cmdline-tools/latest/bin:${PATH}"

APP_IDENTIFIER="$(node -e 'const fs=require("fs"); const config=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(config.identifier || "");' "${SCRIPT_DIR}/src-tauri/tauri.conf.json")"
if [ -z "${APP_IDENTIFIER}" ]; then
  echo "Error: could not resolve app identifier from src-tauri/tauri.conf.json."
  exit 1
fi

EXPECTED_ANDROID_PACKAGE_DIR="${SCRIPT_DIR}/src-tauri/gen/android/app/src/main/java/$(printf '%s' "${APP_IDENTIFIER}" | tr '.' '/')"
ICON_SOURCE_FILE="${SCRIPT_DIR}/public/icon_knob_rounded_square.svg"
if [ ! -f "${ICON_SOURCE_FILE}" ]; then
  ICON_SOURCE_FILE="${SCRIPT_DIR}/public/icon_knob.svg"
fi

DEFAULT_AVD_NAME="Pixel_6_API_35"
AVD_NAME="${1:-${ANDROID_AVD_NAME:-${DEFAULT_AVD_NAME}}}"
EMULATOR_BIN="${ANDROID_EMULATOR_BIN:-}"

detect_android_target() {
  local abi_list="$1"
  if [[ "${abi_list}" == *"arm64-v8a"* ]]; then
    echo "aarch64 arm64"
    return 0
  fi
  if [[ "${abi_list}" == *"armeabi-v7a"* ]]; then
    echo "armv7 arm"
    return 0
  fi
  if [[ "${abi_list}" == *"x86_64"* ]]; then
    echo "x86_64 x86_64"
    return 0
  fi
  if [[ "${abi_list}" == *"x86"* ]]; then
    echo "i686 x86"
    return 0
  fi
  return 1
}

if [ -z "${EMULATOR_BIN}" ]; then
  for candidate in \
    "${ANDROID_SDK_DIR}/emulator/emulator" \
    "/opt/homebrew/share/android-commandlinetools/emulator/emulator" \
    "$HOME/Library/Android/sdk/emulator/emulator"
  do
    if [ -x "${candidate}" ]; then
      EMULATOR_BIN="${candidate}"
      break
    fi
  done
fi

if [ ! -x "${EMULATOR_BIN}" ]; then
  echo "Error: Android emulator binary not found at:"
  echo "  ${EMULATOR_BIN}"
  echo
  echo "Install it with:"
  echo '  sdkmanager "platform-tools" "emulator" "platforms;android-35" "system-images;android-35;google_apis;x86_64"'
  exit 1
fi

if ! command -v adb >/dev/null 2>&1; then
  for candidate in \
    "${ANDROID_SDK_DIR}/platform-tools/adb" \
    "/opt/homebrew/share/android-commandlinetools/platform-tools/adb" \
    "$HOME/Library/Android/sdk/platform-tools/adb"
  do
    if [ -x "${candidate}" ]; then
      export PATH="$(dirname "${candidate}"):${PATH}"
      break
    fi
  done
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "Error: adb not found even after exporting Android SDK paths."
  echo "Checked under: ${ANDROID_SDK_DIR}"
  exit 1
fi

refresh_android_project() {
  echo "Refreshing native Tauri icons from ${ICON_SOURCE_FILE}..."
  npx tauri icon "${ICON_SOURCE_FILE}" -o "${SCRIPT_DIR}/src-tauri/icons"

  echo "Recreating Android project..."
  rm -rf "${SCRIPT_DIR}/src-tauri/gen/android"
  npx tauri android init --ci --skip-targets-install

  if [ -d "${SCRIPT_DIR}/src-tauri/icons/android" ]; then
    echo "Syncing Android launcher resources into generated project..."
    cp -R "${SCRIPT_DIR}/src-tauri/icons/android/." "${SCRIPT_DIR}/src-tauri/gen/android/app/src/main/res/"
  fi

  if [ -d "${SCRIPT_DIR}/src-tauri/android-overrides/app/src/main" ]; then
    echo "Syncing persistent Android overrides into generated project..."
    cp -R "${SCRIPT_DIR}/src-tauri/android-overrides/app/src/main/." "${SCRIPT_DIR}/src-tauri/gen/android/app/src/main/"
  fi
}

if [ ! -d "${EXPECTED_ANDROID_PACKAGE_DIR}" ]; then
  echo "Android project package path is stale or missing:"
  echo "  expected ${EXPECTED_ANDROID_PACKAGE_DIR}"
fi
refresh_android_project

GRADLE_APP_FILE="${SCRIPT_DIR}/src-tauri/gen/android/app/build.gradle.kts"
if [ -f "${GRADLE_APP_FILE}" ]; then
  perl -0pi -e 's/setProperty\("archivesBaseName",\s*"[^"]+"\)/setProperty("archivesBaseName", "app")/g' "${GRADLE_APP_FILE}"
fi

if ! avdmanager list avd | grep -Fq "Name: ${AVD_NAME}"; then
  echo "Error: Android Virtual Device '${AVD_NAME}' was not found."
  echo "Available AVDs:"
  avdmanager list avd || true
  exit 1
fi

if ! adb devices | awk 'NR > 1 && $2 == "device" { found = 1 } END { exit found ? 0 : 1 }'; then
  echo "Starting emulator '${AVD_NAME}'..."
  "${EMULATOR_BIN}" -avd "${AVD_NAME}" >/tmp/303util-android-emulator.log 2>&1 &

  echo "Waiting for emulator to appear in adb..."
  adb wait-for-device

  boot_complete=""
  for _ in $(seq 1 120); do
    boot_complete="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [ "${boot_complete}" = "1" ]; then
      break
    fi
    sleep 2
  done

  if [ "${boot_complete}" != "1" ]; then
    echo "Error: emulator boot did not complete in time."
    echo "Emulator log: /tmp/303util-android-emulator.log"
    exit 1
  fi
fi

echo "Connected devices:"
adb devices

DEVICE_SERIAL="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
if [ -z "${DEVICE_SERIAL}" ]; then
  echo "Error: no Android device detected."
  exit 1
fi

DEVICE_ABI_LIST="$(adb -s "${DEVICE_SERIAL}" shell getprop ro.product.cpu.abilist 2>/dev/null | tr -d '\r')"
if [ -z "${DEVICE_ABI_LIST}" ]; then
  DEVICE_ABI_LIST="$(adb -s "${DEVICE_SERIAL}" shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')"
fi

TARGET_INFO="$(detect_android_target "${DEVICE_ABI_LIST:-}")" || {
  echo "Error: unsupported Android ABI list '${DEVICE_ABI_LIST}'."
  exit 1
}

read -r TAURI_ANDROID_TARGET APK_OUTPUT_DIR <<<"${TARGET_INFO}"

echo "Using Android device ${DEVICE_SERIAL} (${DEVICE_ABI_LIST})..."

for package_name in "${APP_IDENTIFIER}" "com.app.app"; do
  if adb -s "${DEVICE_SERIAL}" shell pm list packages "${package_name}" | grep -Fq "package:${package_name}"; then
    echo "Uninstalling existing app ${package_name} from ${DEVICE_SERIAL}..."
    adb -s "${DEVICE_SERIAL}" uninstall "${package_name}"
  fi
done

DEFAULT_ANDROID_CARGO_TARGET_DIR="${HOME}/Library/Caches/303util/cargo-target-android-dev"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${DEFAULT_ANDROID_CARGO_TARGET_DIR}}"
if [ -d "${CARGO_TARGET_DIR}" ]; then
  echo "Clearing Android cargo target dir..."
  rm -rf "${CARGO_TARGET_DIR}"
fi
mkdir -p "${CARGO_TARGET_DIR}"

ANDROID_INCREMENTAL_DIR="${CARGO_TARGET_DIR}/aarch64-linux-android/debug/incremental"
if [ -d "${ANDROID_INCREMENTAL_DIR}" ]; then
  echo "Clearing stale Android Rust incremental cache..."
  rm -rf "${ANDROID_INCREMENTAL_DIR}"
fi

export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}"
export VITE_APP_VERSION="${VITE_APP_VERSION:-0.0.0-dev}"
export VITE_GOOGLE_CLIENT_ID="${VITE_GOOGLE_CLIENT_ID:-android-debug-client-id}"
export VITE_GOOGLE_DESKTOP_CLIENT_ID="${VITE_GOOGLE_DESKTOP_CLIENT_ID:-desktop-debug-client-id}"

echo "Building Android debug APK for ${TAURI_ANDROID_TARGET}..."
npm run tauri -- android build --debug --apk --target "${TAURI_ANDROID_TARGET}" --ci

APK_PATH="$(find "${SCRIPT_DIR}/src-tauri/gen/android/app/build/outputs/apk" -type f -path "*/debug/*.apk" | sort | tail -n 1 || true)"

if [ -z "${APK_PATH}" ] || [ ! -f "${APK_PATH}" ]; then
  echo "Error: could not find a generated debug APK under:"
  echo "  ${SCRIPT_DIR}/src-tauri/gen/android/app/build/outputs/apk"
  exit 1
fi

echo "Using APK ${APK_PATH}..."
echo "Installing APK on ${DEVICE_SERIAL}..."
adb -s "${DEVICE_SERIAL}" install -r "${APK_PATH}"

if ! adb -s "${DEVICE_SERIAL}" shell pm list packages "${APP_IDENTIFIER}" | grep -Fq "package:${APP_IDENTIFIER}"; then
  echo "Error: APK install reported success but package ${APP_IDENTIFIER} is still missing on ${DEVICE_SERIAL}."
  exit 1
fi

echo "Launching app..."
adb -s "${DEVICE_SERIAL}" shell am start -n "${APP_IDENTIFIER}/.MainActivity"
