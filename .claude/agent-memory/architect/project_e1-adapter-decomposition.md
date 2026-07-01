---
name: e1-adapter-decomposition
description: E1 mobile-mcp adapter decomposition pattern (ADR-0002) — how concurrent tickets share one adapter package without file conflicts
metadata:
  type: project
---

ADR-0002 (`docs/sdlc/architecture/ADR-0002-mobile-mcp-adapter-decomposition.md`) decomposed
`packages/adapters/mobile-mcp` so E1 tickets #14/#15/#16/#17 develop in parallel with zero shared-file edits.

**Pattern (reusable for future per-epic ADRs facing "many tickets, one adapter package"):** keep the public
adapter class as a logic-less **facade** implementing all the domain ports (preserves the composition-root
contract — the api root binds one instance to multiple port slots). The facade delegates to **capability modules**,
each in its own `src/<capability>/**` subtree owned by exactly one ticket. The shared seam (here the MCP
connection / `simctl` exec helper) is injected, so capabilities depend on an abstraction, never on each other.

**Why:** The linchpin is the foundation ticket (#12) — it lands the connection + the **frozen facade** + **stub
capability index.ts/classes** so the facade compiles and every later ticket only replaces its own subtree, never
the facade or the wiring (`capabilities.ts`/`defaultCapabilities`). Without that, every capability ticket edits
the same driver class file → guaranteed conflicts and no parallelism.

**How to apply:** When an epic puts several feature tickets in one adapter/package, in the per-epic ADR (a) define
disjoint file ownership per ticket, (b) have the dependency-free foundation ticket ship the frozen facade + stubs,
(c) put any cross-capability helper (shell-out wrappers, exec) behind one injectable seam owned by the foundation
ticket — not by the first feature ticket — so feature tickets stay mutually independent. Tell the coordinator the
exact wave batching + per-ticket file ownership so it can verify zero overlap. See also [[e1-batching-waves]].
</content>
