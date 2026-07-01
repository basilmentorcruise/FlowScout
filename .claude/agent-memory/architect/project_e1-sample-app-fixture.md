---
name: e1-sample-app-fixture
description: E1.8 (#29) — buildable sample iOS .app fixture for Layer B round-trip; build-from-source, owner fixture still wins
metadata:
  type: project
---

#29 closes OQ3 from [[e1-frozen-facade-evolution]] / E1.7 plan §6 item 4: a tiny SwiftUI app
**built from source via `xcodebuild`** (no committed `.app` binary — T9) so the gated macOS Layer B
round-trip can run without an owner-supplied build. Plan: `docs/sdlc/architecture/E1.8-sample-app-fixture-plan.md`.

Key decisions (so future tickets don't re-litigate):

- Lives in `e2e/fixtures/sample-app/` as a minimal `.xcodeproj` (SPM can't build `.app` bundles).
  Bundle id `com.flowscout.fixture.sampleapp`; one screen, one button with a11y id `fixture.primaryButton`.
- The built `.app` is **copied into `FLOWSCOUT_APP_BUNDLE_DIR`** to pass the lifecycle T2 confinement
  check (`installApp` → `canonicalizeAppPath(.., baseDir)`); build output is gitignored.
- **Owner-supplied `FLOWSCOUT_FIXTURE_APP` still wins**: build step only runs when it's unset. The
  existing skip-when-unset path in `e2e/round-trip.e2e.ts` is relied upon **unchanged** (kept out of the
  touch set). Script + round-trip both exit 0 (skip, never red) when Xcode is absent.

**Why:** Layer B was always skipping in CI — no default fixture existed. **How to apply:** when E2 needs
by-element tapping, the deterministic `fixture.primaryButton` id is already there; reviewing/extending the
fixture is a test-fixture concern (no coverage gate, not product code) — don't over-engineer it.
Touches are disjoint from #44 (`packages/adapters/llm/`); no frozen mobile-mcp / wire.ts edits.
