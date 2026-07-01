---
name: e1-conformance-harness
description: E1 shared driver contract suite must be per-capability section runners (ADR-0003), not one full-driver suite — lesson from Wave-1 gate failure
metadata:
  type: project
---

A shared conformance/contract suite that requires a FULL composite implementation (here
`runDriverContractSuite({ createDriver: () => MobileDriverPort & SimulatorLifecycle })` in
`packages/adapters/mobile-mcp/src/testing/driver-contract.ts`) is **untestable by partial-capability adapters**.
In E1 each Wave-1 ticket (#14 lifecycle / #15 driving / #16 snapshot) implements ONE port subset, so they could
only run the suite against the Fake — proving nothing about the real adapter, and their per-ticket workarounds
diverged.

**Why:** This is the dual of the [[e1-adapter-decomposition]] facade pattern. If you decompose the
_implementation_ by capability, you MUST decompose the _conformance harness_ by the same capability boundaries,
or the tests can't follow the code. ADR-0003 fixes it: export per-capability section runners
(`runLifecycleContract` / `runDrivingContract` / `runSnapshotContract`) with per-capability fixture + errorClass
bundles (ISP), and keep the full-driver `runDriverContractSuite` as a thin aggregator the Fake still uses.

**How to apply:** When a future ADR decomposes an adapter into capability modules each owned by a different
ticket, design the shared contract suite from the start as per-capability section runners injected with a
per-capability factory + errorClasses — never a single composite-driver entry point as the only API. Also: keep
"unknown-target" error contracts CONSISTENT across operations (E1 bug: `takeSnapshot` validated device-first →
DeviceNotFoundError, but `resetToSnapshot` checked the registry first → SnapshotNotFoundError on unknown udid;
fix was device-first ordering in both, the adapter changed, not the suite).
