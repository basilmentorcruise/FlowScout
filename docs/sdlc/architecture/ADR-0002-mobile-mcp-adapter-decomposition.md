# ADR-0002 — Mobile MCP Adapter: Module Decomposition, Snapshot/Reset & Tool-Coverage Fallback (E1)

- **Status:** Accepted
- **Date:** 2026-06-20
- **Mode:** plan (per-epic refinement of ADR-0001 for Epic E1)
- **Scope:** Epic E1 (#1) — `packages/adapters/mobile-mcp`, its composition-root wiring (`packages/api`), and the
  E1 CI job. Tickets #12–#18.
- **Refines, does not supersede:** ADR-0001 (stack & reference architecture). All ADR-0001 invariants hold:
  the adapter is the **only** package importing `@modelcontextprotocol/sdk` / `mobile-mcp` (NFR1), MCP vocabulary
  never leaks inward (anti-corruption, ADR-0001 §2.6), domain ports stay pure, the adapter depends inward only.
- **Decides:** (1) file/module decomposition that lets #14/#15/#16 develop concurrently with **zero shared-file
  edits**; (2) OQ1 — the snapshot/reset mechanism; (3) OQ2 — the rule + fallback when a `MobileDriverPort` method
  has no direct mobile-mcp tool.
- **Out of scope (assumptions, not designed here):** OQ3 fixture `.app` source (owner/architect input;
  referenced as "fixture `.app`"); OQ4 artifact storage (E7 — E1 returns bytes/names per the existing port).

---

## 1. Context

`packages/domain` already defines two pure ports — `MobileDriverPort` (driving: `listDevices`,
`snapshotAccessibilityTree`, `screenshot`, `tap`, `typeText`, `swipe`) and `SimulatorLifecycle` (lifecycle +
snapshot/reset: `bootSimulator`, `installApp`, `launchApp`, `takeSnapshot`, `resetToSnapshot`,
`shutdownSimulator`). `packages/adapters/mobile-mcp` currently ships a single `MobileMcpDriver` **stub** class
implementing both ports by rejecting every call.

The PRD splits the implementation across seven tickets. Three of them — #14 (lifecycle), #15 (driving), #16
(snapshot/reset) — all "live in `packages/adapters/mobile-mcp`" and, as written, all want to fill in methods of
the **same `MobileMcpDriver` class file**. If left that way they cannot be developed concurrently (every PR edits
the same file → guaranteed merge conflicts, and the contract test wiring collides). The coordinator needs a
decomposition that makes their file ownership disjoint so they can be batched in parallel.

The decomposition must also preserve the ADR-0001 invariants and the existing public surface: `packages/api`
imports `{ MobileMcpDriver }` from `@flowscout/adapter-mobile-mcp` and uses a **single instance for both ports**
(`simulatorLifecycle: mobileDriver`). That public contract must not change.

---

## 2. Decision — file/module decomposition (primary output)

### 2.1 Pattern: thin composed facade over capability modules (Facade + Delegation + DI)

`MobileMcpDriver` stays the single public class implementing **both** ports (preserving the composition-root
contract), but it becomes a **thin facade that owns no behaviour**. Each port method delegates to a
**capability module** injected at construction. The capability modules are the unit of concurrent work — each
ticket owns its own file(s) and never edits another ticket's file.

The single shared seam every capability needs is the **MCP connection/tool-invoker** from #12 (`McpConnection`).
It is injected into each capability, so capabilities depend on an **abstraction**, not on each other (DI +
Dependency Inversion). This is the same Open/Closed move ADR-0001 makes at the system level, applied inside the
adapter.

```
                       ┌───────────────────────────────────────────┐
   composition root →  │  MobileMcpDriver  (facade, implements      │
   new MobileMcpDriver │  MobileDriverPort + SimulatorLifecycle)    │
   (config)            │  owns NO behaviour — pure delegation       │
                       └───────┬───────────┬───────────┬───────────┘
                               │ delegates │           │
                ┌──────────────▼──┐  ┌─────▼────────┐  ┌▼──────────────┐
   #14 owns →   │ SimulatorLife-  │  │ DeviceDriver │  │ SnapshotManager│  ← #16 owns
                │ cycleManager    │  │ (#15 owns)   │  │                │
                └────────┬────────┘  └──────┬───────┘  └───────┬───────┘
                         │ uses             │ uses             │ uses
                         └──────────┬───────┴──────────────────┘
                                    ▼
                        ┌───────────────────────┐
            #12 owns →  │ McpConnection         │  (stdio client, tool invoker,
                        │ + config + errors     │   connect/dispose lifecycle)
                        └───────────────────────┘
            #17 owns →  HealthReadiness  (uses McpConnection; separate file)
            #13 owns →  FakeMobileDriver + contract suite  (test-only; uses ports only)
```

**Why a facade, not 3 separate driver classes:** the composition root and `AppPorts` bind to a single object that
is **both** ports (`mobileDriver` and `simulatorLifecycle` are the same instance today). A facade preserves that
exactly while making the internals concurrently editable. It avoids a god-object (the facade has no logic) and
avoids an anemic split (each capability owns real behaviour + its own normalization).

### 2.2 Exact file ownership (the batching contract)

Every file below is created/owned by exactly one ticket. **No file is edited by two tickets.** Paths are under
`packages/adapters/mobile-mcp/`.

| Ticket  | Owns (creates) — exclusive                                                                                                                                                                                                                                          | May read (import only, never edit)                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **#12** | `src/connection/McpConnection.ts`, `src/connection/connection-config.ts`, `src/connection/errors.ts`, `src/connection/index.ts`; **edits `package.json`** (add pinned `@modelcontextprotocol/sdk` + `mobile-next/mobile-mcp`); edits `.env.example` if config added | —                                                                                                             |
| **#13** | `src/testing/FakeMobileDriver.ts`, `src/testing/driver-contract.ts` (the parameterised suite), `src/testing/index.ts`; `src/__tests__/fake-driver.contract.test.ts`                                                                                                 | `@flowscout/domain` ports only                                                                                |
| **#14** | `src/lifecycle/SimulatorLifecycleManager.ts`, `src/lifecycle/simctl.ts` (shared simctl exec helper — see §4), `src/lifecycle/index.ts`; `src/__tests__/lifecycle.contract.test.ts`                                                                                  | `src/connection/*` (#12), `src/testing/driver-contract.ts` (#13)                                              |
| **#15** | `src/driving/DeviceDriver.ts`, `src/driving/normalization.ts` (anti-corruption mappers), `src/driving/index.ts`; `src/__tests__/driving.contract.test.ts`                                                                                                           | `src/connection/*` (#12), `src/testing/driver-contract.ts` (#13)                                              |
| **#16** | `src/snapshot/SnapshotManager.ts`, `src/snapshot/index.ts`; `src/__tests__/snapshot.contract.test.ts`                                                                                                                                                               | `src/connection/*` (#12), `src/lifecycle/simctl.ts` (#14 — see §4/§7), `src/testing/driver-contract.ts` (#13) |
| **#17** | `src/health/HealthReadiness.ts`, `src/health/readiness-result.ts`, `src/health/index.ts`; `src/__tests__/health.test.ts`                                                                                                                                            | `src/connection/*` (#12)                                                                                      |
| **#18** | `packages/api/src/composition-root/wire.ts` (**edit** — replace stub wiring), `e2e/round-trip.e2e.ts`, `.github/workflows/*` (new macOS E2E job)                                                                                                                    | the whole adapter public surface                                                                              |

**The one shared mutable file — `src/MobileMcpDriver.ts` (the facade) and `src/index.ts` (barrel).** These are
the only files multiple capability tickets would otherwise touch. **Decision: #12 owns and fully writes them
once** as part of the connection slice, wiring the facade to delegate to all four capabilities **constructed from
the connection**, with each capability behind a default factory. #14/#15/#16/#17 then implement their capability
module **without editing the facade** — the facade already calls `this.lifecycle.bootSimulator(...)` etc. See
§2.3 for how #12 writes the facade before the capabilities exist.

### 2.3 How #12 writes the facade before the capabilities exist (the seam)

#12 defines a **capability interface per group** (small, internal to the adapter — not domain ports) and a
**default no-op-throwing implementation** for each, so the facade compiles and the existing stub-tests stay green
until each capability ticket lands:

```ts
// src/connection/capabilities.ts  (OWNED BY #12 — the contract between facade and capabilities)
export interface LifecycleCapability {
  // #14 implements
  listDevices(): Promise<readonly DeviceInfo[]>;
  bootSimulator(udid: string): Promise<void>;
  installApp(udid: string, appBundlePath: string): Promise<void>;
  launchApp(udid: string, bundleId: string): Promise<void>;
  shutdownSimulator(udid: string): Promise<void>;
}
export interface DrivingCapability {
  /* a11y/screenshot/tap/type/swipe */
} // #15 implements
export interface SnapshotCapability {
  // #16 implements
  takeSnapshot(udid: string, name: string): Promise<void>;
  resetToSnapshot(udid: string, name: string): Promise<void>;
}
```

The facade constructor takes a `MobileMcpDriverConfig` plus an **optional capability bundle** (DI with defaults):

```ts
// src/MobileMcpDriver.ts  (OWNED + frozen by #12 after this)
export class MobileMcpDriver implements MobileDriverPort, SimulatorLifecycle {
  constructor(config: MobileMcpDriverConfig, deps = defaultCapabilities(config)) { ... }
  bootSimulator(udid: string) { return this.deps.lifecycle.bootSimulator(udid); }
  tap(udid, target)           { return this.deps.driving.tap(udid, target); }
  takeSnapshot(udid, name)    { return this.deps.snapshot.takeSnapshot(udid, name); }
  // ...all 12 methods delegate; facade has zero logic
}
```

`defaultCapabilities(config)` (also #12-owned, in `src/connection/capabilities.ts`) constructs the **real**
capability classes from the connection. When #14/#15/#16/#17 land they only **fill in their own module**; the
wiring already points at them. Because each capability ticket imports the connection and exports its class, and
`defaultCapabilities` already references those exports, the only thing that changes in `capabilities.ts` after #12
is... nothing — it imports each capability's `index.ts`, and each capability ticket creates that file fresh.

> **Refinement to keep `defaultCapabilities` from becoming a shared edit point:** #12 writes `defaultCapabilities`
> to import from `../lifecycle/index.js`, `../driving/index.js`, `../snapshot/index.js`, `../health/index.js`.
> Those `index.ts` files **do not exist yet** when #12 lands, so #12 ships **stub `index.ts` + stub class** for
> each (throwing `notImplemented`, exactly like today's stub). Each capability ticket then **owns and replaces its
> own `index.ts` + class file** — never touching `capabilities.ts` or the facade. This makes `defaultCapabilities`
> written once and frozen, and the per-ticket edits fully disjoint. The current single-file stub test is replaced
> by #12 with the facade delegation test; capability tickets add their own contract test files.

This is the crux of the parallelism guarantee: **#12 lands the connection + the frozen facade + four stub
capability modules. After that, #14/#15/#16/#17 each own a disjoint subtree (`src/<capability>/**` + one test
file) and edit nothing shared.\*\*

### 2.4 Shared types & seams

- **`McpConnection`** (#12): the single shared seam. Exposes a typed `callTool(name, args)` + `listTools()` +
  `connect()`/`dispose()`. Capabilities receive it by injection; they never construct it.
- **`connection-config.ts`** (#12): `MobileMcpDriverConfig` value object — server command/path, connect timeout,
  call timeout, poll interval. All timeouts/paths are config (no magic numbers, ADR-0001 §6). `defaultCapabilities`
  threads the relevant slice to each capability.
- **`errors.ts`** (#12): the adapter's typed error taxonomy base (`McpConnectionError`, `McpToolError`,
  `McpTimeoutError`, and a `DeviceNotFoundError`). Capabilities **import and throw** these; they do not redefine
  error types (DRY). New capability-specific errors (e.g. `InstallFailedError`, `LaunchFailedError`,
  `SnapshotNotFoundError`) are declared **in the owning capability's file** extending the #12 base — no shared-file
  edit. _Coordinator note: this is the one ordering subtlety — see §6 dependency edits._
- **`src/lifecycle/simctl.ts`** (#14): the shared `simctl` shell-exec helper (see §4). #16 imports it read-only.

### 2.5 Resulting smell/SOLID posture

- **SRP:** facade = composition only; each capability = one cohesive concern; connection = transport only.
- **DIP:** capabilities depend on `McpConnection` (abstraction) and on domain ports — never on each other.
- **OCP:** an alternate driver (different MCP server / Android) is a new package selected at the root, unchanged;
  inside the adapter, a capability can be swapped via the `deps` bundle without touching the facade.
- **No god object** (facade is logicless), **no anemic split** (capabilities own normalization + errors),
  **no circular deps** (capabilities → connection, never the reverse; dependency-cruiser enforces).

---

## 3. OQ1 — Snapshot / reset mechanism (#16)

**Decision: use `simctl` clone-free state capture via `xcrun simctl` "erase + re-seed from a saved data
container", with the primary mechanism being a _device clone_ taken once and restored by _re-clone_, and a
fast-path `erase` for the common "reset to freshly-installed" case.** Concretely, the `SnapshotManager` implements
two named strategies behind one interface, chosen by what the snapshot recorded:

1. **Primary — `simctl clone` snapshot (full fidelity).** `takeSnapshot(udid, name)` runs
   `xcrun simctl clone <udid> "<name>"`, producing a full duplicate device that captures installed apps + data +
   settings. `resetToSnapshot(udid, name)` shuts the working device, deletes it, and **re-clones from the saved
   clone** (`simctl clone <name-clone> <working>`), or repoints the working udid — restoring an exact byte-state.
   This is the most faithful "disposable simulator state" and directly satisfies F6 ("a destructive run can be
   reverted").
2. **Fallback fast-path — `erase` + reinstall (when the snapshot was marked `clean-install`).** For the very
   common "clean app freshly installed, no data yet" snapshot, `resetToSnapshot` runs
   `xcrun simctl erase <udid>` then replays the recorded install/launch — cheaper than a full re-clone.

**Why this over the alternatives:**

- **`simctl clone` chosen** because it is the only `simctl` primitive that captures **full device state**
  (apps + data containers + settings) and restores it deterministically across **repeated runs** (NFR5 / the
  success metric's "reliably across repeated runs"). It needs no jailbreak/private API and is stable across Xcode
  versions.
- **Content-and-settings reset (`erase`) alone — rejected as the primary** because it wipes to factory state and
  **loses the installed app + any seeded login state**, so a logged-in real-data run could not be restored to its
  post-login clean baseline without a full re-login (which may hit 2FA). It is kept only as the explicit
  `clean-install` fast-path.
- **APFS/file-system snapshot of the data container — rejected:** brittle, undocumented internal layout, breaks
  across Xcode/Simulator updates; exactly the kind of coupling the anti-corruption boundary exists to avoid.
- **mobile-mcp native snapshot — rejected: it has no such primitive** (confirmed in OQ2 §4); snapshot/reset is a
  **`simctl` concern, not an MCP-tool concern**, so it belongs in the adapter's `simctl` lane, not behind a tool
  call.

**Interface (against the existing `SimulatorLifecycle` port — no port change):**

The port already declares `takeSnapshot(udid, name)` / `resetToSnapshot(udid, name)` returning `Promise<void>`.
The mechanism is **entirely internal** to `SnapshotManager`:

- `SnapshotManager` holds a small in-adapter **snapshot registry** (name → `{ kind: 'clone' | 'clean-install',
cloneUdid?, install?: {appPath, bundleId} }`) so `resetToSnapshot` knows which strategy to apply and can throw
  `SnapshotNotFoundError` (extends #12's base error) when a name is unknown — satisfying the "must error, not
  silently no-op" AC. The registry is in-memory for E1 (lifetime = process); persisting it is **E7 (OQ4) — out of
  scope**, noted as an assumption.
- Strategy selection is a **Strategy pattern** inside `SnapshotManager` (`CloneSnapshotStrategy`,
  `EraseReinstallStrategy`) so a future mechanism is added by extension, not modification (OCP).
- All `simctl` calls go through the shared `src/lifecycle/simctl.ts` helper (§4) — bounded by configured timeout,
  typed errors, no magic numbers.

---

## 4. OQ2 — Gesture / snapshot MCP-tool coverage rule + fallback (#15, #16)

**The rule (anti-corruption + adapter-is-the-blast-radius, ADR-0001 R2):**

> A `MobileDriverPort` / `SimulatorLifecycle` method maps to a **direct mobile-mcp tool when one exists**. When no
> direct tool exists, the adapter **falls back to a `simctl` (or, where required, a WebDriverAgent) shell-out
> performed entirely inside the adapter**. The choice is invisible to the engine: the method still satisfies the
> same port contract and returns the same domain type. The fallback is **isolated in a dedicated, separately
> testable seam** so the blast radius of any tool gap is one file.

**Coverage assessment for `mobile-next/mobile-mcp` (drives iOS Simulators via WebDriverAgent):**

| Port method                                                | Mechanism                                                                                         | Owner                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------- |
| `snapshotAccessibilityTree`                                | **Direct MCP tool** (accessibility snapshot) → normalize                                          | #15 `DeviceDriver`              |
| `screenshot`                                               | **Direct MCP tool** (screenshot) → `ScreenshotBytes`                                              | #15 `DeviceDriver`              |
| `tap` (element + coordinate)                               | **Direct MCP tool** (element tap / coordinate tap)                                                | #15 `DeviceDriver`              |
| `typeText`                                                 | **Direct MCP tool** (type/send-keys)                                                              | #15 `DeviceDriver`              |
| `swipe`                                                    | **Direct MCP tool if exposed; else WDA/`simctl` fallback** (gesture is ADR-0001 R2's flagged gap) | #15 `DeviceDriver`              |
| `listDevices` / `boot` / `install` / `launch` / `shutdown` | **`simctl` shell-out** (device lifecycle is a host concern, not an in-app MCP tool)               | #14 `SimulatorLifecycleManager` |
| `takeSnapshot` / `resetToSnapshot`                         | **`simctl` shell-out** (no MCP primitive — see §3)                                                | #16 `SnapshotManager`           |

**Isolation & testing of the fallback:**

- The **single `simctl` seam** is `src/lifecycle/simctl.ts` (#14): one small typed wrapper around
  `execFile('xcrun', ['simctl', ...])` with timeout + typed error mapping + (critically) an **injectable executor
  function** (`type Exec = (cmd, args, opts) => Promise<{stdout, stderr}>`). This is the DI point that makes the
  shell-out **unit-testable without a Mac**: tests inject a fake `Exec` and assert the exact argv + the parsing of
  `simctl list -j` JSON / error handling. #14 owns it; #16 imports it read-only for its clone/erase calls.
- The **gesture fallback** (`swipe`) lives in #15's `DeviceDriver` behind a small private strategy: try the MCP
  gesture tool; if `listTools()` does not advertise it, fall to a WDA/`simctl` gesture. The decision is computed
  from `connection.listTools()` (capability detection at connect time), **cached**, and unit-tested by feeding a
  fake tool list — again no simulator needed.
- **Confirmation against the pilot fixture is a #18 (macOS E2E) responsibility**, not a per-PR gate: #18's
  round-trip exercises the real tool set on a macOS runner and is where an actual gesture gap (if any) surfaces.
  Because the fallback is pre-built and isolated, discovering a gap there is a localized fix, not a redesign.

**Why `simctl` over WDA for lifecycle/snapshot:** lifecycle (boot/install/launch/erase/clone) is a host-level
device operation `simctl` owns natively and reliably; WDA is the in-app automation channel and is the right
fallback only for **in-app gestures** the MCP server doesn't expose. Keeping lifecycle on `simctl` and gestures on
MCP/WDA matches each concern to its proper tool and keeps the seams cohesive.

---

## 5. Per-ticket architecture plan (#12–#18)

Each entry: approach · SOLID/DI seam · what to abstract · contract-test (#13) application · test strategy/coverage.

### #12 — MCP connection & transport bootstrap (foundation; unblocks all)

- **Approach:** Build `McpConnection` (stdio `@modelcontextprotocol/sdk` client) with `connect`/`dispose`/`callTool`/
  `listTools`; `MobileMcpDriverConfig` value object; `errors.ts` base taxonomy; the **frozen facade** + the four
  **stub capability modules** + `defaultCapabilities` (§2.3); pin both deps to exact versions in `package.json`.
- **SOLID/DI:** connection is the injected abstraction every capability binds to (DIP). Facade = pure delegation
  (SRP). Config injected at construction (no magic numbers/paths, ADR-0001 §6).
- **Abstract:** `callTool`/`listTools` (so capabilities never see the SDK), config, error base.
- **Contract tests:** none of the port behaviour yet; #12 **replaces** the old stub test with a **facade
  delegation test** (assert each facade method calls the right capability) using injected fake capabilities.
- **Test strategy:** unit-test connect/timeout/dispose with a fake child-process/transport (inject the spawner);
  assert typed connection error on bad command, timeout within bound, no orphaned process on dispose. Adapter has
  no global % gate but these are the contract-critical paths — cover them. **Boundaries/cruiser must stay green.**

### #13 — FakeMobileDriver + shared contract suite (foundation; unblocks #14/#15/#16 testing)

- **Approach:** `FakeMobileDriver` implements **both ports** with an in-memory boot/install/launch state machine,
  canned a11y/screenshot, recorded actions, in-memory snapshot map, and all documented error cases. `driver-contract.ts`
  is a **parameterised suite** `(makeDriver: () => MobileDriverPort & SimulatorLifecycle) => void`.
- **SOLID/DI:** the suite depends only on the **domain ports** (DIP) — it is the single source of conformance,
  reused by #14/#15/#16 against the real adapter (OCP: new drivers verified by reuse, not new tests).
- **Abstract:** the driver factory; the suite knows nothing concrete.
- **Contract tests:** **this ticket authors them** and runs them against the fake.
- **Test strategy:** the suite IS the test; assert state transitions, recorded actions, `resetToSnapshot` on
  unknown name throws, unknown-UDID throws. This is reusable test infrastructure, exported from `src/testing/`.

### #14 — Simulator lifecycle (depends #12)

- **Approach:** `SimulatorLifecycleManager implements LifecycleCapability` via the shared `simctl.ts` helper
  (list/boot/install/launch/shutdown); parse `simctl list -j`; map to `DeviceInfo`; typed errors
  (`DeviceNotFoundError`, `InstallFailedError`, `LaunchFailedError` distinct from each other). Replace #12's stub
  `src/lifecycle/index.ts` + class with the real one.
- **SOLID/DI:** `simctl.ts` takes an **injectable `Exec`** (DIP) → unit-testable without a Mac. Errors extend
  #12's base (DRY). One concern per method (SRP).
- **Abstract:** the `Exec` executor; the `simctl` argv construction.
- **Contract tests:** run #13's suite against the **real adapter restricted to lifecycle methods** (a
  `lifecycle.contract.test.ts` that drives a `MobileMcpDriver` whose other capabilities are #13's fake/stub).
- **Test strategy:** inject a fake `Exec` returning recorded `simctl` fixtures; cover happy + every documented
  error/edge (unknown udid, bad `.app`, wrong bundle id, timeout). Real-`simctl` execution is exercised only in
  #18's macOS E2E (off fast path).

### #15 — Device driving + normalization (depends #12, #13)

- **Approach:** `DeviceDriver implements DrivingCapability`: map a11y/screenshot/tap/type/swipe to MCP tools via
  `connection.callTool`; `normalization.ts` holds the **anti-corruption mappers** (MCP payload → `A11ySnapshot`,
  `ScreenshotBytes`); swipe uses the gesture-fallback strategy (§4). Replace #12's stub `src/driving/index.ts` +
  class.
- **SOLID/DI:** normalization isolated as pure functions (SRP, trivially testable, where any domain-bound mapping
  logic that must hit the 80% gate lives). Driver depends on `McpConnection` only (DIP). Gesture fallback behind a
  strategy (OCP).
- **Abstract:** the normalization functions; the gesture strategy (tool vs. WDA/simctl).
- **Contract tests:** run #13's suite against the **real adapter restricted to driving methods**; assert
  **no MCP shape leaks** (returned values are domain types only).
- **Test strategy:** inject a fake `McpConnection` returning canned MCP payloads; assert normalization output,
  element + coordinate tap, off-screen coordinate → typed action error, swipe tool-present and tool-absent
  (fallback) branches. Pure mappers cover the branch gate.

### #16 — Snapshot / reset (depends #14)

- **Approach:** `SnapshotManager implements SnapshotCapability` using the §3 Strategy (`CloneSnapshotStrategy`
  primary, `EraseReinstallStrategy` fast-path) over the shared `simctl.ts`; in-memory snapshot registry;
  `SnapshotNotFoundError` (extends #12 base) on unknown name. Replace #12's stub `src/snapshot/index.ts` + class.
- **SOLID/DI:** reuses `simctl.ts`'s injectable `Exec` (no Mac needed for unit tests); strategies behind one
  interface (OCP); registry encapsulated (SRP).
- **Abstract:** the snapshot strategy interface; the registry.
- **Contract tests:** run #13's suite **snapshot/reset cases** against the real adapter; assert reset-to-unknown
  throws, take→mutate→reset restores (modeled via the injected `Exec` recording clone/restore argv), repeated
  cycles consistent.
- **Test strategy:** fake `Exec`; assert exact `simctl clone`/`erase` argv per strategy, registry behaviour,
  error on unknown name. Real restore fidelity is proven in #18's macOS E2E.
- **Depends-on #14 reason:** it imports `src/lifecycle/simctl.ts`. **See §6 — this can be softened.**

### #17 — Health / readiness (depends #12)

- **Approach:** `HealthReadiness` returns a typed `ReadinessResult` discriminated union — `mcpReachable`,
  `wdaUp`, `appLaunched?` — distinguishing **retryable not-ready** from **terminal failed**; bounded polling from
  config. Propose the result type as an **adapter-local type** (not a port change) per the ticket's own guidance;
  if the engine later needs it, promote to the port in a follow-up ADR.
- **SOLID/DI:** depends on `McpConnection` only; polling bound + interval injected (no magic numbers).
- **Abstract:** the `ReadinessResult` union; the poll clock (inject a timer/`now` for deterministic timeout tests).
- **Contract tests:** **not** part of the shared port suite (readiness is an adapter-local capability, not a
  domain port method) — has its own `health.test.ts`.
- **Test strategy:** inject a fake connection + clock; assert retryable-vs-terminal mapping, app-launched signal,
  timeout resolves within bound (no hang).

### #18 — Composition-root wiring + macOS round-trip E2E (depends #14, #15, #16, #17)

- **Approach:** edit `packages/api/src/composition-root/wire.ts` to construct `new MobileMcpDriver(config)` from
  injected config (the existing `simulatorLifecycle: mobileDriver` line stays — facade is both ports);
  `e2e/round-trip.e2e.ts` scripts boot→readiness→install→launch→snapshot→tap→screenshot/a11y→reset×≥3 against the
  fixture `.app`; new **separately-gated macOS CI job** (off the per-PR fast path, ADR-0001 §7 plane 2).
- **SOLID/DI:** wiring stays logic-free (presentation/composition only); config from env (extend `.env.example`).
- **Abstract:** nothing new — consumes the full adapter surface via its public barrel.
- **Contract tests:** none new; this is the real-simulator E2E plane.
- **Test strategy:** the round-trip is the test; assert ≥3 consecutive clean runs, no orphaned sims/processes
  (cleanup on dispose), single-line driver swap at the root. **Fixture `.app` = OQ3 (assumption, referenced not
  built).** Boundaries/cruiser confirm `api`→adapter only via the root.

---

## 6. Coordinator actions — `Touches:` / `Depends-on:` edits

The file decomposition makes the original "all three touch `MobileMcpDriver.ts`" hazard disappear. Recommended
issue edits so the batching is unambiguous:

1. **Refine `Touches:` on #12** to: "owns `src/connection/**`, the facade `src/MobileMcpDriver.ts`, `src/index.ts`,
   **stub `src/{lifecycle,driving,snapshot,health}/index.ts`**, and `package.json` deps." (#12 lays the frozen
   facade + capability stubs — this is the linchpin of the parallelism.)
2. **Refine `Touches:` on #14/#15/#16/#17** to their disjoint subtrees per §2.2 (`src/lifecycle/**`, `src/driving/**`,
   `src/snapshot/**`, `src/health/**` + each ticket's own `__tests__` file). Explicitly: **none of them edits the
   facade or `capabilities.ts`.**
3. **#16 `Depends-on`:** currently `#14`. The _only_ real coupling is `#16` importing `src/lifecycle/simctl.ts`.
   **Recommendation: move the shared `simctl.ts` helper into #12's connection slice** (rename lane to
   `src/sim/simctl.ts`, owned by #12). Then **#16 depends only on #12, not #14**, and #14/#15/#16 are fully
   parallel after #12. If the coordinator prefers to keep `simctl.ts` in #14, leave `#16 Depends-on: #14` as-is —
   but state the preference is to relocate it for maximal parallelism. **(Architect recommendation: relocate to
   #12.)**
4. **#13 `Touches:`** note it exports the contract suite from `src/testing/` so #14/#15/#16 import it; confirm
   "may add a small shared test export" → it does (`src/testing/index.ts`).
5. No domain port changes in any ticket (#17's readiness type stays adapter-local). If that changes, it requires a
   new ADR — flag to the arch-review gate.

---

## 7. Consequences & risks

- **Positive:** #14/#15/#16/#17 develop in parallel with **zero shared-file edits** once #12 lands; the facade
  preserves the exact composition-root contract; the `simctl` seam is a single injectable, Mac-free-testable file;
  snapshot mechanism is decided and isolated; the gesture gap (R2) is pre-mitigated and localized.
- **R-A (sequencing):** #12 is a hard prerequisite for the parallel wave — it must land first and ship the frozen
  facade + stub capabilities, or the parallelism guarantee doesn't hold. Mitigation: #12 + #13 are already the
  dependency-free first pair; keep #12 small and merge it before fanning out.
- **R-B (simctl/Xcode drift, from §3/§4):** `simctl clone`/`erase` argv and `simctl list -j` shape can shift
  across Xcode. Mitigation: all `simctl` access behind one wrapper with an injected `Exec`; real behaviour pinned
  by #18's macOS E2E; a drift fix is one file.
- **R-C (snapshot registry is in-memory for E1):** restores only within a process lifetime. Accepted for E1;
  persistence is **E7 (OQ4)** — out of scope, noted as assumption.
- **Inherited open risks unchanged:** OQ3 fixture `.app` (owner input, #18), ADR-0001 R2 gesture confirmation
  (resolved in approach, validated in #18).

---

## 8. Batching recommendation (for the coordinator)

- **Wave 0 (now, dependency-free, concurrent):** **#12** and **#13**. Disjoint files (`src/connection/**` + facade
  - stubs + `package.json` vs. `src/testing/**`).
- **Wave 1 (after #12 merges; fully concurrent, zero file overlap):** **#14** (`src/lifecycle/**`), **#15**
  (`src/driving/**`), **#16** (`src/snapshot/**`), **#17** (`src/health/**`). Each also adds exactly one
  `src/__tests__/*.contract.test.ts` (distinct files). #15 additionally wants #13 merged for the contract suite
  (already in Wave 0). **Prerequisite for #16 being in this wave:** adopt §6 item 3 (relocate `simctl.ts` to #12);
  otherwise #16 waits on #14.
- **Wave 2 (after #14/#15/#16/#17):** **#18** (composition root + macOS E2E).
  </content>
  </invoke>
