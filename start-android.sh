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

DEFAULT_AVD_NAME="Pixel_6_API_35"
AVD_NAME="${1:-${ANDROID_AVD_NAME:-${DEFAULT_AVD_NAME}}}"
EMULATOR_BIN="${ANDROID_EMULATOR_BIN:-}"

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

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${SCRIPT_DIR}/src-tauri/target-android-dev}"

ANDROID_INCREMENTAL_DIR="${CARGO_TARGET_DIR}/aarch64-linux-android/debug/incremental"
if [ -d "${ANDROID_INCREMENTAL_DIR}" ]; then
  echo "Clearing stale Android Rust incremental cache..."
  rm -rf "${ANDROID_INCREMENTAL_DIR}"
fi

export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}"

echo "Starting Tauri Android dev..."
npm run tauri android dev
