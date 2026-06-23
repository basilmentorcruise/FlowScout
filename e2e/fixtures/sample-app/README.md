# FlowScout sample-app fixture

**E1.8 (#29) — Minimal buildable sample iOS `.app` fixture for the Layer B round-trip.**

This directory contains the source for a tiny single-screen SwiftUI app used as the
**default fixture** when no owner-supplied `.app` is provided for the macOS real-simulator
E2E round-trip (`e2e/round-trip.e2e.ts`).

---

## T9 hygiene statement

- **Provenance:** all source in this directory (`Sources/`, `Info.plist`, `SampleApp.xcodeproj/`)
  is **authored in-repo for ticket #29** — no third-party app, no copied binary, no SDK sample.
- **No secrets, PII, or credentials** are present in this source. The app makes no network calls
  and contains no real account data.
- **No binary is committed.** The built `.app` bundle is produced at build time by `build-fixture.sh`
  and is **never tracked by git** (covered by both this directory's `.gitignore` and the root
  `.gitignore`). `gitleaks` scans the committed source on every PR; any secret finding fails the build.
- **Bundle identifier:** `com.flowscout.fixture.sampleapp` — a synthetic, non-production identifier
  with no real-organisation affiliation.

---

## What's in this directory

```
e2e/fixtures/sample-app/
  SampleApp.xcodeproj/    # Minimal Xcode project (one app target, iOS Simulator)
    project.pbxproj
  Sources/
    SampleApp.swift       # @main App entry (WindowGroup -> ContentView)
    ContentView.swift     # Single screen: Text label + tappable Button
  Info.plist              # CFBundleIdentifier = com.flowscout.fixture.sampleapp
  build-fixture.sh        # Build script (bash, set -euo pipefail)
  README.md               # This file
  .gitignore              # Local guard: DerivedData/, *.app excluded from git
```

---

## Build & use

From the repo root:

```bash
# Option A: capture exports for the current shell session
eval "$(bash e2e/fixtures/sample-app/build-fixture.sh)"

# Option B: via package.json script (same effect)
pnpm run e2e:build-fixture
eval "$(pnpm run e2e:build-fixture --silent 2>/dev/null | grep '^export ')"

# Then run the real round-trip
pnpm run e2e:round-trip
```

The script:
1. Checks for `xcrun` / `xcodebuild` — exits 0 with a clear skip message if absent (AC7).
2. Runs `xcodebuild` with `CODE_SIGNING_ALLOWED=NO` for the iOS Simulator destination.
3. Copies the built `.app` into `FLOWSCOUT_APP_BUNDLE_DIR` (T2 confinement, AC3).
4. Reads `CFBundleIdentifier` back from the copied bundle's `Info.plist` — never hand-typed (AC4).
5. Exports `FLOWSCOUT_FIXTURE_APP`, `FLOWSCOUT_FIXTURE_BUNDLE_ID`, `FLOWSCOUT_APP_BUNDLE_DIR`.

---

## Behavioural contract (AC2)

The single screen provides:

- `Text("FlowScout Fixture")` — ensures the a11y tree is non-empty (`a11yLength > 0`).
- `Button("Tap me")` with `.accessibilityIdentifier("fixture.primaryButton")` — the stable
  tappable target used by the round-trip. Tapping increments an on-screen counter so the effect
  is observable without additional instrumentation.

The `fixture.primaryButton` identifier is the deterministic element E2 by-element tapping will use
(extensibility point — no changes needed to this fixture for E2).

---

## CI behaviour

`.github/workflows/e2e-macos.yml` runs `build-fixture.sh` **only when `FLOWSCOUT_FIXTURE_APP`
is unset** (i.e., no owner-supplied fixture). The owner-supplied fixture path always takes
precedence (AC6). See the workflow for the full behaviour matrix.

---

## Dependencies

- macOS with **Xcode** installed (full Xcode, not just command-line tools — needed for SwiftUI SDK).
- No additional npm/pnpm/Python dependencies.
- Tested with **Xcode 26.5** (`xcodebuild -version`), deployment target iOS 17.0.
