---
name: recurring-risks-mobile-mcp
description: The mobile-mcp adapter is FlowScout's only trusted-to-shell-out boundary; the same class of risks recur in every ticket that touches it.
metadata:
  type: project
---

`packages/adapters/mobile-mcp` is the **only** package that imports the MCP SDK and the only place
that spawns child processes / shells out (`xcrun simctl` fallback) and touches the host filesystem.
Treat it as the system's primary trust boundary.

**Why:** ADR-0001 §2.6 isolates the top dependency risk (mobile-mcp + WebDriverAgent) behind this
adapter. Everything dangerous — OS command construction, the user-supplied `.app` path, untrusted
MCP/WDA payloads, screenshots that may capture real on-screen data — converges here.

**How to apply:** when reviewing any ticket touching this package, check for the recurring set:

- Command/arg injection (CWE-78/88): require `execFile`/`spawn` argv arrays, `shell:false`, never
  string-interpolated commands; allowlist-validate `udid`/`bundleId`/`snapshotName`.
- Path traversal (CWE-22) on the `.app` path: canonicalize + confine to an allowlisted base dir.
- Untrusted/oversized MCP+WDA payloads (CWE-20/400): size bounds + config timeouts, no OOM/hang.
- Secret/PII in logs (CWE-532): never log `typeText` text, screenshot bytes, full a11y, or full env.
- Supply chain (CWE-1104): exact-version pins for mobile-mcp + `@modelcontextprotocol/sdk`, SCA gate.
- Fail-closed reset + no orphaned sims/processes (CWE-404/672) — backstops the no-guardrails posture.

See [[scope-boundaries]] and [[mandated-scanning-policy]]. Full E1 model:
`docs/sdlc/security/e1-mobile-mcp-foundation-threat-model.md`.
