---
name: project-e1-breakdown
description: How E1 (Mobile MCP foundation) was sliced into tickets and the scope-decision rationale behind the cut lines
metadata:
  type: project
---

E1 (epic #1, Mobile MCP + simulator build/install foundation) was broken into 7 vertical slices: #12 E1.1 connection,
#13 E1.2 FakeMobileDriver + shared contract suite, #14 E1.3 simulator lifecycle, #15 E1.4 device driving + payload
normalization, #16 E1.5 snapshot/reset, #17 E1.6 health/readiness, #18 E1.7 composition-root wiring + macOS round-trip E2E.
PRD: docs/sdlc/prd/PRD-e1-mobile-mcp-foundation.md.

**Why:** The scaffold already shipped the domain ports (`MobileDriverPort` + `SimulatorLifecycle` in packages/domain)
and a stub `MobileMcpDriver` that rejects every call. So E1 is "make the stub real", not "design the port". The fake +
contract suite (#13) depend only on the existing ports, which is why it is dependency-free and runs concurrently with
the connection slice (#12). Slices were cut by capability group (lifecycle / driving / snapshot / readiness) so they map
to distinct method groups; #14/#15/#16 still share packages/adapters/mobile-mcp so they need file-partitioning or
sequencing by the coordinator.

**How to apply:** When refining or re-planning E1, treat ports as fixed (architect owns changes via ADR-0002). Several
material decisions were deferred to ADR-0002, NOT invented here: snapshot/reset mechanism (OQ1), mobile-mcp gesture/
snapshot tool coverage + fallback (OQ2), fixture .app source (OQ3), artifact storage (OQ4, owned by E7). Don't let
downstream tickets contradict those open questions. Server is mobile-next/mobile-mcp, pinned exact, isolated as the only
package importing the MCP SDK (ADR-0001 F1). See [[project-flowscout-sdlc-pipeline]].
