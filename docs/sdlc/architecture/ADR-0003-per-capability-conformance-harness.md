# ADR-0003 — Per-Capability Conformance Harness & Canonical Unknown-UDID Contract (E1)

- **Status:** Accepted
- **Date:** 2026-06-21
- **Mode:** plan (cross-cutting fix for E1 Wave-1)
- **Scope:** `packages/adapters/mobile-mcp/src/testing/**` (the #13 shared harness) and the contract-test
  wiring of #14 (lifecycle), #15 (driving), #16 (snapshot). Composition-root and the engine are untouched.
- **Refines / amends:** ADR-0002 §2.3, §3, §5, §6. The facade + capability decomposition, the `simctl` seam,
  and the no-domain-port-change invariant all stand. This ADR changes ONLY (a) the _shape_ of the shared
  conformance suite and (b) the canonical unknown-UDID error per snapshot operation.
- **Driven by:** code-review gate FAILed #14/#15/#16. Root cause: `runDriverContractSuite({ createDriver })`
  demands a FULL `MobileDriverPort & SimulatorLifecycle` driver, but each Wave-1 ticket implements ONE
  capability subset. Developers could only run the suite against `FakeMobileDriver`, so AC8/AC7/AC6
  ("shared suite passes against the REAL adapter") were structurally impossible, and per-ticket workarounds
  began diverging.

---

## 1. Decision 1 — Per-capability section runners (the conformance pattern)

**Refactor the monolithic suite into three exported per-capability section runners plus a thin full-driver
aggregator.** A real capability instance (constructed with a mocked `Exec` / `McpConnection`) runs ONLY the
sections it owns — no `FullDriver` composite required. This is the single pattern all four tickets converge on.

### 1.1 New public API surface of `src/testing/` (the exact target for developers)

`driver-contract.ts` exports, in addition to the existing types:

```ts
// ---- Per-capability factories (each returns ONLY its capability's port subset) ----
export type LifecycleFactory = () => SimulatorLifecyclePartial; // boot/install/launch/shutdown/listDevices
export type DrivingFactory = () => MobileDriverDrivingPartial; // a11y/screenshot/tap/typeText/swipe
export type SnapshotFactory = () => SnapshotPartial; // takeSnapshot/resetToSnapshot

// ---- Per-capability error-class bundles (granular injection — see Decision 3) ----
export interface LifecycleErrorClasses {
  unknownDevice: ErrorConstructor;
  invalidInput: ErrorConstructor;
}
export interface DrivingErrorClasses {
  unknownDevice: ErrorConstructor;
  invalidInput: ErrorConstructor;
}
export interface SnapshotErrorClasses {
  unknownDevice: ErrorConstructor; // unknown udid on take/reset
  invalidInput: ErrorConstructor; // bad udid/name shape (T1)
  snapshotNotFound: ErrorConstructor; // known udid, unknown snapshot name (T8)
}

// ---- Per-capability section runners (the new entry points #14/#15/#16 call) ----
export function runLifecycleContract(opts: {
  createLifecycle: LifecycleFactory;
  fixtures: LifecycleFixtures; // validUdid, installablePath, validBundleId, unknownUdid, injection vectors
  errorClasses: LifecycleErrorClasses;
}): void;

export function runDrivingContract(opts: {
  createDriving: DrivingFactory;
  fixtures: DrivingFixtures; // validUdid, unknownUdid, injection vectors; pre-booted state is the
  // factory's responsibility (driving capability has no lifecycle)
  errorClasses: DrivingErrorClasses;
}): void;

export function runSnapshotContract(opts: {
  createSnapshot: SnapshotFactory;
  fixtures: SnapshotFixtures; // validUdid, knownSnapshotName(2), unknownUdid, injection vectors
  errorClasses: SnapshotErrorClasses;
}): void;

// ---- Full-driver aggregator (Fake only; thin wrapper that calls all three runners) ----
export function runDriverContractSuite(options: DriverContractSuiteOptions): void;
```

**`runDriverContractSuite` is retained but reimplemented as a thin aggregator** that destructures the
`FullDriver` from `createDriver` into the three partials and calls the three section runners with the
`ContractFixtures`-derived sub-fixtures. The Fake's existing call site
(`src/__tests__/fake-driver.contract.test.ts`) keeps working **unchanged** — `FAKE_CONTRACT_FIXTURES` and
`runDriverContractSuite` stay exported with the same signatures. This preserves OCP at the suite level and
proves the Fake still satisfies the union of all three capabilities.

### 1.2 Section assignment (which §-sections move into which runner)

The eleven `describe*` blocks already in `driver-contract.ts` partition cleanly by capability:

| Section runner         | Sections it owns (from the current suite)                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runLifecycleContract` | §1 lifecycle happy-path · §3 listDevices · §6 unknown-UDID (lifecycle methods only: boot/install/launch/shutdown) · §7 injection UDIDs (boot) · §8 injection bundleIds (launch) · §10 injection appPaths (install) |
| `runDrivingContract`   | §4 observation (a11y+screenshot) · §5 actions (tap/type/swipe) · §6 unknown-UDID (driving methods) · §7 injection UDIDs (a11y/screenshot/tap) · §11 stress/repeat payloads                                         |
| `runSnapshotContract`  | §2 snapshot/reset · §6 unknown-UDID (take/reset — see Decision 2) · §9 injection snapshot names                                                                                                                    |

The full §6 "unknown UDID" block is split so each runner asserts only the methods its capability actually
exposes. This is the key structural change that lets a partial adapter run real sections.

**Pre-condition handling for driving/snapshot:** §4/§5 currently call `bootSimulator/installApp/launchApp` in
`beforeEach` to reach a usable state. A real `DeviceDriver` (driving) does NOT implement those. Decision:
the section runners must NOT call cross-capability lifecycle methods. Instead:

- `runDrivingContract` assumes the `createDriving()` instance is driven against a `udid` the fake `McpConnection`
  already treats as observable — the fixture's `validUdid`. No lifecycle calls in the runner.
- `runSnapshotContract` likewise calls only `takeSnapshot`/`resetToSnapshot`; the snapshot adapter's fake `Exec`
  is what makes `validUdid` "exist". No `bootSimulator` in the runner.
  The Fake satisfies all of this because its `FullDriver` answers every method; the aggregator's sub-fixtures
  simply route the same `validUdid` through.

### 1.3 Why section runners, not a composite-driver helper

A `composeFullDriver({ lifecycle, driving, snapshot })` helper was considered (build a synthetic `FullDriver`
from a real partial + fakes for the rest, then run the whole suite). **Rejected:**

- It would force every Wave-1 ticket to construct and reason about the _other two_ capabilities' fakes just to
  test its own — coupling the tickets to each other's internals and re-introducing a shared composition point
  (exactly the divergence we are eliminating).
- The unknown-UDID and pre-condition `beforeEach` blocks would still execute cross-capability methods backed by
  fakes, so "the suite passed" would partly measure the fakes, not the real adapter. Section runners assert each
  real method directly with zero fake substitution inside the capability under test.
- Section runners are the natural ISP-aligned shape: the suite already partitions by capability; we are making
  that partition addressable.

The Fake still gets full-union coverage via the retained aggregator, so nothing is lost.

---

## 2. Decision 2 — Canonical unknown-UDID contract per snapshot operation

**Canonical contract: an operation invoked on a UDID the adapter does not recognise throws the
`unknownDevice` error class — for ALL of `takeSnapshot` and `resetToSnapshot`, device-existence is validated
BEFORE the snapshot registry is consulted.**

- `takeSnapshot(unknownUdid, name)` → `unknownDevice` (DeviceNotFoundError). **#16 already does this**
  (`requireDeviceExists` runs first). No change.
- `resetToSnapshot(unknownUdid, name)` → **must throw `unknownDevice`, NOT `snapshotNotFound`.**
  **#16 changes here.** Today `resetToSnapshot` checks the in-memory registry first; an unknown udid is never in
  the registry, so it throws `SnapshotNotFoundError` — wrong class per the canonical contract.

### 2.1 Which side changes, and exactly how

**The adapter changes; the suite's expectation stands.** Device-not-found is the more specific, more
actionable, security-correct failure (T1/T8 both want fail-closed with the _truest_ cause). Rationale:

- **Consistency across operations:** `takeSnapshot` already validates the device first. Having `resetToSnapshot`
  diverge (registry-first) is an internal inconsistency, not a deliberate contract. Aligning both on
  device-first is the smaller, more coherent change.
- **Diagnostic truth:** "device X does not exist" is the real cause; "snapshot Y not found for device X" is
  misleading when X itself is bogus. The registry key is `<udid>::<name>`, so an unknown udid _masquerades_ as a
  missing snapshot — a latent confusing-error bug independent of the suite.
- **Security posture is preserved:** the T8 fail-closed guarantee (known udid + unknown snapshot →
  `snapshotNotFound`, never a silent no-op) is unchanged. We only re-order so device validation precedes the
  registry lookup.

**Exact code change in `SnapshotManager.resetToSnapshot` (#16):** insert `await this.requireDeviceExists(udid)`
immediately after the T1 validation and **before** the registry lookup:

```ts
async resetToSnapshot(udid: string, snapshotName: string): Promise<void> {
  validateUdid(udid);
  validateSnapshotName(snapshotName);
  await this.requireDeviceExists(udid);          // NEW — device-first → DeviceNotFoundError on unknown udid
  const record = this.registry.get(this.registryKey(udid, snapshotName));
  if (!record) throw new SnapshotNotFoundError(snapshotName, udid);   // T8 — known udid, unknown name
  const strategy = this.selectStrategy(record.kind);
  await strategy.restore(record, this.exec, this.config.callTimeoutMs);
}
```

This makes #16's `SnapshotNotFoundError` reachable ONLY for the canonical T8 case (real device, name never
taken), and `DeviceNotFoundError` for unknown udid — matching the suite. `requireDeviceExists` already exists in
#16 and is fake-`Exec`-testable, so no new seam is introduced.

### 2.2 No domain-port change

The unknown-UDID resolution is entirely an adapter-internal ordering fix. `MobileDriverPort` /
`SimulatorLifecycle` are untouched. ADR-0002 §5 invariant (no port change in E1) holds. The arch-review gate
need not be re-consulted for a port change because there is none.

---

## 3. Decision 3 — `errorClasses` injection granularity: per-capability

**Switch from one global `ContractErrorClasses` to per-capability error bundles** (`LifecycleErrorClasses`,
`DrivingErrorClasses`, `SnapshotErrorClasses`, shown in §1.1). Each real adapter declares only the error classes
its own methods throw:

- Lifecycle declares `unknownDevice` (`DeviceNotFoundError`) + `invalidInput` (`LifecycleInputError`).
- Driving declares `unknownDevice` + `invalidInput` (its normalization/action input error).
- Snapshot declares `unknownDevice` (`DeviceNotFoundError`) + `invalidInput` (`InvalidSnapshotInputError`) +
  `snapshotNotFound` (`SnapshotNotFoundError`).

**Why per-capability (ISP):** a snapshot adapter has no business declaring a driving input-error class it never
throws; forcing the global bundle is exactly the kind of over-broad interface that produced the divergent
hand-written mirror assertions. `runDriverContractSuite` (Fake) keeps the combined `ContractErrorClasses` and
internally maps it down to the three sub-bundles, so `FAKE_CONTRACT_FIXTURES` is unchanged.

**One naming correction to surface to developers:** the suite asserts the `unknownDevice` _category_; #14 and
#16 both throw `DeviceNotFoundError` (from #12 `errors.ts`) for unknown udid — correct. The Fake throws
`UnknownDeviceError`. The contract is "same _category_, class name may differ" (already the documented design),
so injecting `DeviceNotFoundError` as `unknownDevice` for the real adapters is conformant. No new error type.

---

## 4. Decision 4 — Land order & ownership

**One focused harness PR lands first; then the three Wave-1 PRs rebase onto it and wire their real adapter
through the new section runners.**

1. **PR-H (harness enhancement, `src/testing/**`only — #13 area):** refactor`driver-contract.ts`into the
three section runners + thin aggregator; add per-capability fixture/error-class types and the split §6;
keep`runDriverContractSuite`, `ContractFixtures`, `FAKE_CONTRACT_FIXTURES`, and the Fake test working
unchanged. Update `src/testing/index.ts`to export the new runners and per-capability types. **No change to`FakeMobileDriver`, the facade, `capabilities.ts`, `errors.ts`, or any capability module.\*\* This is a single
   developer task; merges first.
2. **#14 rebases:** replace its hand-written mirror assertions with
   `runLifecycleContract({ createLifecycle: () => new SimulatorLifecycleManager(conn, cfg, fakeExec), fixtures, errorClasses })`.
   The fake `Exec` returns recorded `simctl` fixtures so `validUdid` "exists" and `unknownUdid` does not.
3. **#15 rebases:** `runDrivingContract({ createDriving: () => new DeviceDriver(fakeConnection, cfg), fixtures, errorClasses })`
   with a fake `McpConnection` returning canned MCP payloads for `validUdid`.
4. **#16 rebases:** apply the §2.1 `resetToSnapshot` device-first fix FIRST, then
   `runSnapshotContract({ createSnapshot: () => new SnapshotManager(conn, cfg, fakeExec), fixtures, errorClasses })`.
   The fake `Exec` answers `list devices --json` so `validUdid` exists and `unknownUdid` does not, and records
   `clone`/`erase` argv for the take→reset cases. **(The separate erase-then-discard-clone restore bug noted by
   the coordinator is a #16 developer fix, out of scope for this ADR; the device-first re-order is the only
   contract-driven change here.)**

**Unchanged invariants confirmed:** facade (`MobileMcpDriver.ts`), `capabilities.ts`, `defaultCapabilities`,
`errors.ts`, `connection/**`, and both domain ports are NOT edited by any of these steps. The per-capability
runners depend only on the domain port subsets + injected error classes (DIP preserved). No circular deps; the
`src/testing/**` package still imports domain ports only.

---

## 5. Consequences & risks

- **Positive:** each Wave-1 PR now proves conformance against its REAL adapter (AC8/AC7/AC6 satisfiable);
  divergent hand-written mirror assertions are deleted; the Fake retains full-union coverage; the unknown-udid
  contract is consistent across take/reset and diagnostically truthful.
- **R-A (fixture pre-conditions):** driving/snapshot section runners must not invoke cross-capability lifecycle
  methods; "existence" is provided by each adapter's fake `Exec`/`McpConnection`. PR-H must remove the
  `bootSimulator`-in-`beforeEach` coupling from the migrated §4/§5/§2 sections. Caught by code-review.
- **R-B (#16 ordering fix vs. restore bug):** the device-first re-order and the separate restore-logic bug are
  independent; both must land for #16 to pass QA, but only the re-order is contract-driven by this ADR.
- **No new domain-port surface; no facade/composition change** — arch-review re-scope is limited to `src/testing/**`
  plus #16's `resetToSnapshot` ordering.
