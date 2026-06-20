# PRD — E1: Mobile MCP + simulator build/install foundation (adapter)

- **Epic:** #1 (`type:epic`, `mvp`) — RICE 48.0, hard dependency for E2–E7.
- **Owner agent:** product. **Aligns with:** ADR-0001 (stack & reference architecture). E1's per-epic
  refinement is ADR-0002 (architect), which details the mobile-mcp adapter + snapshot/reset _within_ ADR-0001.
- **Status:** ready for breakdown. No product code authored here.

## Problem & users

**Users:** FlowScout's own downstream capabilities (E2 crawl engine, E3 mapping, E5 dashboard) and, indirectly,
the internal developers/testers who run FlowScout. Today nothing in FlowScout can touch a real app: there is a
typed `MobileDriverPort` + `SimulatorLifecycle` in `packages/domain` and a **stub** `MobileMcpDriver` in
`packages/adapters/mobile-mcp` that rejects every call with "not yet implemented".

**Problem:** Until an agent can reliably boot an iOS simulator, install a user-supplied simulator `.app`, launch
it, observe it (accessibility tree + screenshot), act on it (tap / type / swipe), and reset it to a clean
snapshot, no MVP success metric is reachable. Mobile MCP is also the project's top dependency risk (ADR-0001 F1)
and must stay isolated behind the existing port so it can be swapped without rippling into the engine.

## Goals / non-goals

**Goals**

- Make `MobileMcpDriver` a real, conformant implementation of `MobileDriverPort` + `SimulatorLifecycle` over the
  selected server **`mobile-next/mobile-mcp`** (ADR-0001 §2.6), pinned by exact version, isolated as the **only**
  package importing the MCP SDK / mobile-mcp.
- Deliver the full driver capability surface: list/boot/select simulator, install `.app`, launch app,
  accessibility-tree snapshot, screenshot, tap (element + coordinate), type text, swipe/gesture.
- Deliver disposable/snapshotted simulator state: take snapshot + reset-to-snapshot so a destructive real-data
  run can be reverted (ADR-0001 F6 — the agreed safety mitigation; no in-flow guardrails).
- Deliver health/readiness checks (MCP server reachable, WebDriverAgent up, app launched) so callers fail fast
  with actionable errors instead of hanging.
- Provide a **`FakeMobileDriver`** and a **shared adapter contract-test suite** so the engine can be tested with
  no simulator and any future driver (alternate MCP server / Android) is provably conformant (ADR-0001 §7).
- Demonstrate the success metric end-to-end: from a clean state, boot a sim, install + launch a fixture `.app`,
  perform a scripted tap → snapshot round-trip, and reset to a clean snapshot, reliably across repeated runs.

**Non-goals (this epic)**

- The crawl loop, state-identity, decision policy, budgets (E2/E3). E1 only exposes the driver they consume.
- Persistence of screenshots/snapshots beyond what the round-trip needs (E7 owns the store; E1 returns bytes /
  URIs per the existing port).
- Android (post-MVP; the port + contract suite keep it additive).
- Building our own Mobile MCP server (explicitly out of scope, vision).
- LLM/vision interpretation of screenshots — E1 returns raw bytes only.
- Dashboard surfacing of the driver (E5).

## Requirements

### Functional

- **FR1 — Server lifecycle & connection.** The adapter launches/connects to `mobile-next/mobile-mcp` (stdio MCP
  transport per ADR-0001 §2.6), pinned by exact version, with connection config (server path/command, timeouts)
  injected at construction — no hardcoded paths, no magic numbers (ADR-0001 §6). Connection is the only thing
  the rest of the adapter depends on.
- **FR2 — Simulator lifecycle.** `listDevices`, `bootSimulator(udid)`, `installApp(udid, appBundlePath)`,
  `launchApp(udid, bundleId)`, `shutdownSimulator(udid)` are implemented against the server's tools and return /
  throw per the port contract.
- **FR3 — Device driving + normalization (anti-corruption).** `snapshotAccessibilityTree`, `screenshot`, `tap`
  (element **and** coordinate targets), `typeText`, `swipe` are implemented. MCP's payload vocabulary is
  normalized into the domain types (`A11ySnapshot`, `ScreenshotBytes`, etc.) at the adapter boundary — MCP terms
  never leak inward (ADR-0001 §2.6 anti-corruption layer).
- **FR4 — Snapshot / reset.** `takeSnapshot(udid, name)` and `resetToSnapshot(udid, name)` produce and restore a
  recoverable clean simulator state so a destructive run is revertible (ADR-0001 F6).
- **FR5 — Health / readiness.** A readiness capability reports whether the MCP server is reachable, WebDriverAgent
  is up, and (when applicable) the target app is launched — surfaced as a typed result, with clear distinction
  between "not ready yet" (retryable) and "failed".
- **FR6 — Fake + contract conformance.** A `FakeMobileDriver` implements the same ports deterministically with no
  simulator. A shared contract-test suite runs against **both** the fake and the real adapter, asserting every
  port method's contract (including error behaviour), so conformance is verifiable, not aspirational.
- **FR7 — Composition-root wiring + round-trip.** `MobileMcpDriver` is selected as the concrete driver at the
  `packages/api` composition root (one-line swap point, ADR-0001 §2.3). A scripted round-trip exercise
  (boot → install → launch → tap → snapshot → reset) proves the success metric against a small fixture `.app` on
  a macOS runner.

### Non-functional

- **NFR1 — Dependency isolation (F1).** `@modelcontextprotocol/sdk` + `mobile-mcp` are imported **only** inside
  `packages/adapters/mobile-mcp`. The `domain`/`application` layers never reference them. (Enforced by
  eslint-plugin-boundaries + dependency-cruiser, ADR-0001 §6 — tickets must keep these green.)
- **NFR2 — Exact version pin.** The mobile-mcp server + MCP SDK are pinned to exact versions (dependency-risk
  containment, F1).
- **NFR3 — No magic numbers / no hardcoded paths.** Timeouts, retry counts, poll intervals, server command are
  configuration (ADR-0001 §6 `no-magic-numbers`).
- **NFR4 — Coverage.** Adapter logic is covered via the contract suite + a realistic harness; any pure mapping/
  normalization logic that lands in `domain`/`application` meets the 80% line+branch gate (ADR-0001 §6).
- **NFR5 — Reliability.** The round-trip (FR7) must succeed across repeated runs from a clean state (success
  metric wording: "reliably across repeated runs") — not a one-shot happy path.
- **NFR6 — Quality gates green.** Every ticket leaves lint, typecheck, boundaries, cycles, duplication, coverage,
  and gitleaks passing (the coordinator's auto-merge requires the green check).
- **NFR7 — macOS-only real path.** The real-simulator round-trip runs on a macOS runner, kept off the per-PR fast
  path and gated separately (ADR-0001 §7 E2E plane 2). The fake-driver path runs everywhere.

## UX notes

No end-user UI in E1 (the dashboard is E5). The only "interface" is the developer-facing port contract + error
messages. Error states must be actionable (name the failing capability + whether it is retryable), since these
errors will later surface to operators via E5.

## Success metrics

- **Primary (epic success metric):** from a clean state, FlowScout boots a sim, installs + launches a given
  `.app`, performs a scripted tap/snapshot round-trip, and resets to a clean snapshot — reliably across repeated
  runs (FR7 / NFR5).
- **Conformance:** the shared contract suite passes against both `FakeMobileDriver` and `MobileMcpDriver`.
- **Isolation:** boundaries + dependency-cruiser confirm zero MCP-SDK imports outside `adapters/mobile-mcp`.
- **Engine-readiness:** the crawl engine (E2) can be unit-tested against `FakeMobileDriver` with no simulator.

## Edge cases & error states

- No simulator available / requested UDID not found → typed, actionable error (not a hang).
- `.app` bundle path missing, unreadable, or not a simulator build → clear install-failure error.
- App fails to launch / wrong bundle id → launch-failure error distinct from install failure.
- MCP server not installed, wrong version, or fails to start → connection error naming the cause; version
  mismatch is distinguishable.
- WebDriverAgent not yet up when a driving call arrives → readiness check reports retryable "not ready".
- Snapshot name does not exist on reset → clear error; reset must not silently no-op.
- Element id stale / coordinate off-screen on tap → typed action error.
- Accessibility snapshot empty/oversized, or screenshot capture fails → handled, not swallowed.
- Operation timeout (boot/install/launch/driving) → bounded by configured timeout, surfaced as timeout error.
- Repeated runs must not leak booted simulators or orphaned server processes (cleanup on shutdown).

## Open questions

- **OQ1 — Snapshot mechanism.** ADR-0001 mandates snapshot/reset as an E1 capability but does not fix the
  mechanism (e.g. simulator clone, `simctl` device snapshot/erase, content-and-settings reset). The existing port
  exposes `takeSnapshot`/`resetToSnapshot` by name only. **Decision deferred to architect / ADR-0002.** Tickets
  specify the observable contract, not the mechanism.
- **OQ2 — mobile-mcp tool coverage for gestures/snapshot-reset.** ADR-0001 R2 flags that the chosen server may not
  expose every gesture or a native snapshot primitive; if a port method has no direct MCP tool, the adapter is the
  blast radius. Architect to confirm coverage against the pilot fixture in ADR-0002; if a gap exists, note the
  fallback (e.g. `simctl` shell-out from inside the adapter) there.
- **OQ3 — Fixture `.app` for the round-trip.** FR7 needs a small known simulator `.app`. Source/identity of this
  fixture (a minimal built app vs. a public sample) is an owner/architect input. Tickets reference it as
  "fixture `.app`" and keep the build/source out of scope.
- **OQ4 — Object/file storage for screenshots & snapshots.** ADR-0001 R4 uses local FS for dev. E1 returns bytes/
  names per the port; where artifacts persist is E7. No conflicting decision made here.

## Ticket breakdown (links to issues)

Vertical slices, each independently shippable and test-first in one developer pass. Connection (E1.1) and the
fake/contract harness (E1.2) are dependency-free and start immediately and concurrently. The architect refines
`Touches:` and the file decomposition (single driver class vs. split modules) in ADR-0002 — tickets name the
capability + observable contract, not the internal structure.

| Issue | Ticket | Title                                                 | Effort | Depends-on         |
| ----- | ------ | ----------------------------------------------------- | ------ | ------------------ |
| #12   | E1.1   | MCP server connection & transport bootstrap           | ~1.5d  | none               |
| #13   | E1.2   | FakeMobileDriver + shared adapter contract-test suite | ~1.5d  | none               |
| #14   | E1.3   | Simulator lifecycle (boot/select/install/launch/down) | ~2d    | #12                |
| #15   | E1.4   | Device driving + payload normalization                | ~2d    | #12, #13           |
| #16   | E1.5   | Snapshot / reset disposable simulator state           | ~1.5d  | #14                |
| #17   | E1.6   | Health / readiness checks                             | ~1d    | #12                |
| #18   | E1.7   | Composition-root wiring + scripted round-trip E2E     | ~2d    | #14, #15, #16, #17 |

**Dependency-free, start immediately & concurrently:** #12 (E1.1) and #13 (E1.2). #13 touches only the fake +
contract-suite test module and #12 touches the connection/client module + deps, so they do not overlap.
**Concurrency after #12 lands:** #14, #17 (both depend only on #12); #15 unblocks once #12 + #13 land.
**Note:** #14, #15, #16 all live in `packages/adapters/mobile-mcp` — the coordinator should sequence or
file-partition them (lifecycle vs. driving vs. snapshot are distinct method groups / files); the architect fixes
the exact file decomposition in ADR-0002.
</content>
