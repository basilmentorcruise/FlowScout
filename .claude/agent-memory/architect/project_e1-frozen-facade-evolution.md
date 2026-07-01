---
name: e1-frozen-facade-evolution
description: How to adjudicate edits to the "OWNED AND FROZEN BY #12" facade/capabilities after Wave-1 merged
metadata:
  type: project
---

The `// OWNED AND FROZEN BY #12` headers on `packages/adapters/mobile-mcp/src/MobileMcpDriver.ts`
and `src/connection/capabilities.ts` (ADR-0002 §2.3, see [[e1-adapter-decomposition]]) are a
**Wave-1 concurrency guard**, not permanent immutability.

**Why:** the freeze existed so #14/#15/#16/#17 could develop concurrently without colliding on the
shared facade/`capabilities.ts`. That wave is merged (E1 shipped). The purpose-of-freeze no longer
binds once parallelism is over.

**How to apply (arch-review gate on this package):**

- A minimal _additive_ edit (new interface method + factory field + delegating facade method) by a
  coordinator-sanctioned owner is **additive evolution, not drift** → lean PASS.
- Sanction = the ticket body explicitly claims the facade/barrel lane (e.g. #28: "Edits the frozen
  facade + barrel, so out of #18's lane"). Verify that scoping exists before waving it through.
- Always emit a non-blocking follow-up: the freeze headers should be updated to record the new
  sanctioned owner so they stop misstating ownership.
- Teardown/lifecycle (`dispose()`) belongs on the **concrete adapter facade, NOT a domain port** —
  MCP transport teardown is infrastructure; promoting it to `MobileDriverPort` leaks infra lifecycle
  into the domain and breaks the hexagonal boundary. If port-level teardown is ever needed, that's a
  `Disposable` port via new ADR, not widening a domain port.

**Known pre-existing noise:** `src/__tests__/simctl.test.ts` has 5 failing fake-timer/AbortSignal
tests that reproduce identically on origin/main. Do NOT attribute these to a PR that doesn't touch
that file; flag as separate tech-debt.
