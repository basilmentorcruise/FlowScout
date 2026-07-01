---
name: e1-delivery
description: E1 (Mobile MCP + simulator foundation) fully delivered & merged; tickets, decisions, follow-ups, next work.
metadata:
  type: project
---

# E1 — Mobile MCP + simulator foundation: DELIVERED

All E1 tickets merged to `main` (as of 2026-06-22). Epic #1 complete.

## Tickets shipped (all gates passed: code-review → arch → security → qa → release)

- #12 fs-12 — MCP connection/transport bootstrap + **frozen logic-less `MobileMcpDriver` facade** + stub capability modules + shared `simctl.ts` Exec seam. The linchpin: `defaultCapabilities()` builds ONE shared `McpConnection` and injects `(connection, config, exec)` into each capability stub via typed constructors, so Wave-1 tickets replace only their own `src/<capability>/index.ts` (re-exported as `*Stub`) without touching the frozen facade/`capabilities.ts`.
- #13 fs-13 — `FakeMobileDriver` + reusable contract suite (`src/testing/**`).
- PR-H (#24) — refactored contract suite into **per-capability section runners** `runLifecycleContract`/`runDrivingContract`/`runSnapshotContract` + thin aggregator (ADR-0003). Enabled real partial-capability adapters to be conformance-tested.
- #14 fs-14 — lifecycle (`src/lifecycle/**`): list/boot/install/launch/shutdown via `xcrun simctl` (no mobile-mcp device tools exist).
- #15 fs-15 — driving (`src/driving/**`): a11y/screenshot/tap(elem+coord)/typeText/swipe; `normalization.ts` is the sole anti-corruption MCP→domain seam.
- #16 fs-16 — snapshot/reset (`src/snapshot/**`): **in-place erase+reinstall** (shutdown→erase→install, same udid); clone-changes-udid was unimplementable for in-place restore. Fail-closed reset; appBundlePath confinement.
- #17 fs-17 — health/readiness (`src/health/**`): adapter-local `DetailedReadinessResult` (NOT a domain port); WDA probed per-poll via `callTool` (NOT cached `listTools`).
- #18 fs-18 — composition root (`packages/api`) + round-trip E2E (`e2e/`) + macOS CI. Env `loadMobileMcpConfig()`; clean-install prod snapshot mode; base dir from `FLOWSCOUT_APP_BUNDLE_DIR`. Layer A (always-on FakeMobileDriver round-trip) + Layer B (gated macOS real-sim, skip-if-no-fixture). SCA+SAST wired into `ci.yml`; macOS E2E in `e2e-macos.yml` (workflow_dispatch+label, off per-PR path).

## Key architecture decisions

- **ADR-0001** stack/reference arch (pre-existing). **ADR-0002** adapter decomposition (frozen facade + per-capability subtrees + injected seams). **ADR-0003** per-capability conformance section runners. **E1.7-composition-e2e-plan.md** capstone plan.
- Snapshot OQ1: erase+reinstall in-place (clone superseded). Unknown-udid contract: `DeviceNotFoundError` for both take & reset (device-first, before registry).

## Open follow-up tickets (filed, NOT yet done) — E1 hardening

- #26 kill simctl child on timeout (touches frozen `src/simctl.ts`).
- #27 size-gate screenshot base64 before decode (touches `src/driving/normalization.ts`).
- #28 expose `MobileMcpDriver.dispose()` for transport teardown (frozen facade+barrel).
- #29 minimal buildable sample iOS `.app` fixture (OQ3) — unblocks the REAL macOS success-metric round-trip (currently skips without a fixture).
- ADR-0002 OQ1 doc amendment (record erase+reinstall) — low priority.
- Note: production `appBundleDir` is loaded at root but not threaded through the lifecycle seam (lifecycle reads `FLOWSCOUT_APP_BUNDLE_DIR` env itself); thread it when wiring real installs.

## Deploy

Deferred — no production target configured per ADR-0001/CLAUDE.md.

## Next eligible work (tier/priority order)

MVP epics remain only as `type:epic` (no ticket breakdown yet): E2 crawl engine (next core, depends on E1 ✓), E3, E4 (HTML report, RICE 32 but depends on E2/E3 output), E5 dashboard, E6 vault, E7 persistence. **E2 is the dependency-unblocked core — break it down next** (dispatch `product`), then threat-model (`security`) + plan (`architect`) before implementation, same pattern as E1.
