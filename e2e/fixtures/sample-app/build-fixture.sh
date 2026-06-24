#!/usr/bin/env bash
# build-fixture.sh — Build the FlowScout sample-app fixture for the iOS Simulator.
#
# E1.8 (#29): Minimal buildable sample iOS .app fixture for the Layer B round-trip.
# plan: docs/sdlc/architecture/E1.8-sample-app-fixture-plan.md §4
#
# Usage:
#   bash e2e/fixtures/sample-app/build-fixture.sh
#   eval "$(bash e2e/fixtures/sample-app/build-fixture.sh)"  # to capture exports locally
#   pnpm run e2e:build-fixture                                 # via package.json script
#
# Inputs (env, all optional with sane defaults):
#   FLOWSCOUT_APP_BUNDLE_DIR   — confinement base where .app is copied.
#                                Default: "${TMPDIR:-/tmp}/flowscout-apps"
#   FIXTURE_SCHEME             — xcodebuild scheme. Default: SampleApp
#   FIXTURE_SIM_DESTINATION    — xcodebuild destination. Default: generic/platform=iOS Simulator
#
# Outputs (printed to stdout as export statements; also written to GITHUB_OUTPUT / GITHUB_ENV in CI):
#   FLOWSCOUT_FIXTURE_APP         — absolute path to the copied .app bundle
#   FLOWSCOUT_FIXTURE_BUNDLE_ID   — CFBundleIdentifier read from the built bundle (never hand-typed)
#
# AC7: exits 0 with a clear message if Xcode / xcrun is unavailable (non-macOS / no-Xcode env).
# T9 hygiene: logs only paths + bundle id; never logs env objects or secrets.
# T2 confinement: the .app is copied INTO FLOWSCOUT_APP_BUNDLE_DIR so installApp passes confinement.
#
# Security: no magic constants; all paths are named variables; set -euo pipefail.

set -euo pipefail

# ---------------------------------------------------------------------------
# Named constants — no magic constants anywhere below
# ---------------------------------------------------------------------------
readonly FIXTURE_SCHEME="${FIXTURE_SCHEME:-SampleApp}"
readonly FIXTURE_SIM_DESTINATION="${FIXTURE_SIM_DESTINATION:-generic/platform=iOS Simulator}"
readonly FIXTURE_APP_NAME="SampleApp.app"
readonly FIXTURE_PRODUCT_DIR="Debug-iphonesimulator"

# ---------------------------------------------------------------------------
# Resolve PROJECT_DIR from the script's own location (works from any CWD)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="${SCRIPT_DIR}"

# ---------------------------------------------------------------------------
# AC7: Pre-flight — graceful exit 0 when Xcode is unavailable
# ---------------------------------------------------------------------------
if ! command -v xcrun >/dev/null 2>&1; then
  echo "[FlowScout fixture] SKIP: xcrun not found (not macOS or Xcode not installed)."
  echo "[FlowScout fixture] The Layer B round-trip will use its own skip path."
  exit 0
fi

if ! xcrun xcodebuild -version >/dev/null 2>&1; then
  echo "[FlowScout fixture] SKIP: xcodebuild not available (Xcode command-line tools not installed)."
  echo "[FlowScout fixture] The Layer B round-trip will use its own skip path."
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve confinement base dir — T2, plan §2.1
# ---------------------------------------------------------------------------
readonly APP_BUNDLE_DIR="${FLOWSCOUT_APP_BUNDLE_DIR:-${TMPDIR:-/tmp}/flowscout-apps}"

echo "[FlowScout fixture] Building ${FIXTURE_SCHEME} for ${FIXTURE_SIM_DESTINATION}"
echo "[FlowScout fixture] Project dir: ${PROJECT_DIR}"
echo "[FlowScout fixture] App bundle dir (T2 confinement base): ${APP_BUNDLE_DIR}"

# ---------------------------------------------------------------------------
# Step 1: xcodebuild — CODE_SIGNING_ALLOWED=NO for simulator builds
# ---------------------------------------------------------------------------
readonly DERIVED_DATA_PATH="${PROJECT_DIR}/DerivedData"

xcrun xcodebuild build \
  -project "${PROJECT_DIR}/SampleApp.xcodeproj" \
  -scheme "${FIXTURE_SCHEME}" \
  -destination "${FIXTURE_SIM_DESTINATION}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  CODE_SIGNING_ALLOWED=NO \
  2>&1 | grep -E "^(Build|error:|warning:|note:|CompileSwift|Linking|Touch|ValidateProduct|\*\* BUILD)" || true

echo "[FlowScout fixture] Build complete."

# ---------------------------------------------------------------------------
# Step 2: Locate the built bundle — assert it exists
# ---------------------------------------------------------------------------
readonly BUILT_APP="${DERIVED_DATA_PATH}/Build/Products/${FIXTURE_PRODUCT_DIR}/${FIXTURE_APP_NAME}"

if [ ! -d "${BUILT_APP}" ]; then
  echo "[FlowScout fixture] ERROR: Built .app not found at: ${BUILT_APP}" >&2
  echo "[FlowScout fixture] xcodebuild may have failed. Re-run without output filter to diagnose." >&2
  exit 1
fi

echo "[FlowScout fixture] Built bundle: ${BUILT_APP}"

# ---------------------------------------------------------------------------
# Step 3: Copy into FLOWSCOUT_APP_BUNDLE_DIR — T2 confinement (plan §3)
# ---------------------------------------------------------------------------
mkdir -p "${APP_BUNDLE_DIR}"
FIXTURE_APP="${APP_BUNDLE_DIR}/${FIXTURE_APP_NAME}"

# Remove stale copy if present (idempotent re-runs)
if [ -d "${FIXTURE_APP}" ]; then
  rm -rf "${FIXTURE_APP}"
fi

cp -R "${BUILT_APP}" "${APP_BUNDLE_DIR}/"

if [ ! -d "${FIXTURE_APP}" ]; then
  echo "[FlowScout fixture] ERROR: Copy failed — ${FIXTURE_APP} does not exist." >&2
  exit 1
fi

echo "[FlowScout fixture] Copied to confinement dir: ${FIXTURE_APP}"

# ---------------------------------------------------------------------------
# Step 4: Read bundle id from the copied bundle — AC4 (never hand-typed)
# ---------------------------------------------------------------------------
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${FIXTURE_APP}/Info.plist")"

if [ -z "${BUNDLE_ID}" ]; then
  echo "[FlowScout fixture] ERROR: Could not read CFBundleIdentifier from ${FIXTURE_APP}/Info.plist" >&2
  exit 1
fi

echo "[FlowScout fixture] Bundle ID (read from bundle): ${BUNDLE_ID}"

# ---------------------------------------------------------------------------
# Step 5: Emit exports (plan §4 contract)
#   - In CI: write to GITHUB_OUTPUT and GITHUB_ENV
#   - Always: print export statements to stdout for local eval
# ---------------------------------------------------------------------------

# CI: write to GITHUB_OUTPUT and GITHUB_ENV (set when running in GitHub Actions)
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "FLOWSCOUT_FIXTURE_APP=${FIXTURE_APP}" >> "${GITHUB_OUTPUT}"
  echo "FLOWSCOUT_FIXTURE_BUNDLE_ID=${BUNDLE_ID}" >> "${GITHUB_OUTPUT}"
  echo "FLOWSCOUT_APP_BUNDLE_DIR=${APP_BUNDLE_DIR}" >> "${GITHUB_OUTPUT}"
fi

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "FLOWSCOUT_FIXTURE_APP=${FIXTURE_APP}" >> "${GITHUB_ENV}"
  echo "FLOWSCOUT_FIXTURE_BUNDLE_ID=${BUNDLE_ID}" >> "${GITHUB_ENV}"
  echo "FLOWSCOUT_APP_BUNDLE_DIR=${APP_BUNDLE_DIR}" >> "${GITHUB_ENV}"
fi

# Always: print export statements so local devs can eval "$(...)"
echo "export FLOWSCOUT_FIXTURE_APP=${FIXTURE_APP}"
echo "export FLOWSCOUT_FIXTURE_BUNDLE_ID=${BUNDLE_ID}"
echo "export FLOWSCOUT_APP_BUNDLE_DIR=${APP_BUNDLE_DIR}"

echo "[FlowScout fixture] Done. To use locally:"
echo "  eval \"\$(bash e2e/fixtures/sample-app/build-fixture.sh)\""
echo "  pnpm run e2e:round-trip"
