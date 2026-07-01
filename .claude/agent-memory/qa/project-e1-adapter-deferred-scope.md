---
name: project-e1-adapter-deferred-scope
description: E1 mobile-mcp adapter scope split — what is unit-testable now vs. deferred to #18 macOS E2E
metadata:
  type: project
---

Per the E1 epic architecture (ADR-0002), the `@flowscout/adapter-mobile-mcp` package is split across tickets:

- **#12 (done):** McpConnection transport bootstrap, frozen facade, stub capabilities, simctl seam.
- **#14/#15/#16/#17 (Wave-1):** Replace stub `index.ts` files in lifecycle/driving/snapshot/health subtrees. They never touch `capabilities.ts` or `MobileMcpDriver.ts`.
- **#18 (macOS E2E):** Real round-trip with live MCP server — covers `createDefaultExec`, `createDefaultTransport`, actual stdio spawn, real simulator operations.

**Coverage gate deferral pattern:**

- `src/lifecycle/`, `src/driving/`, `src/snapshot/`, `src/health/` stub modules are excluded from the #12 coverage gate. Wave-1 tickets own their own coverage.
- `createDefaultExec` / `createDefaultTransport` (real `child_process`/`StdioClientTransport` paths) excluded from unit gate; covered by #18.
- Barrel `index.ts` files excluded (no logic).

**Why:** Real iOS simulator behavior cannot be exercised in a Mac-free unit environment. The DI seam (injectable `Exec`, injectable `TransportFactory`) is what the unit gate covers — not the real callsite.

**How to apply:** When gating Wave-1 tickets (#14–#17), require coverage on the real implementation files, not the stubs. When gating #18, require a live macOS environment and real MCP server.

**#15 (driving) confirmed patterns (PR #21, ef3844a):**

- `runDrivingContract` called at bottom of `driving.test.ts` with `makeDrivingContractConnection()` returning canned payloads for `validUdid` / throwing `McpToolError` for `unknownUdid`. Covers §4 observation, §5 actions, §6(driving), §7(driving), §11 stress — no lifecycle boot/launch calls inside the contract runner (ADR-0003 §1.2 R-A).
- MCP tool name constants (`TOOL_DUMP_UI` etc.) are module-level consts in `DeviceDriver.ts` only; `RawDumpUiResult`/`RawScreenshotResult` interfaces are in `normalization.ts` only — zero MCP vocab in domain/application/web/api confirmed by grep.
- The `throw err` re-throw arms in swipe (tool-present and fallback) are the only uncovered lines (209-210, 221-222). Acceptable: pattern tested in other methods, no distinct business logic.
- T5 proof pattern: `vi.spyOn(console, 'log/warn/error')` + `loggedStrings.some(s => s.includes(secretText))` assertion.
