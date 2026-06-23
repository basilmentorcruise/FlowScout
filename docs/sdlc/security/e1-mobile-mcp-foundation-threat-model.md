# Threat Model — E1: Mobile MCP + simulator build/install foundation

- **Mode:** threat-model (design-time, per epic)
- **Epic:** #1 — Mobile MCP foundation (adapter). Tickets #12–#18.
- **Author agent:** security. **Date:** 2026-06-20.
- **Aligns with:** ADR-0001 (stack & reference architecture), PRD-e1-mobile-mcp-foundation.
- **Standards applied:** OWASP Top 10 (2021), OWASP ASVS v4 (L1/L2 controls named inline), CWE.
- **Scope boundary:** E1 is the Mobile MCP driver/adapter only — connect to `mobile-next/mobile-mcp`
  (stdio transport), boot/install/launch a user-supplied `.app` on an iOS simulator, drive it
  (tap/type/swipe/snapshot/screenshot), snapshot/reset simulator state, health checks, and
  composition-root wiring. **The encrypted credential vault and 2FA flow are E6 (`adapters/vault`),
  NOT in scope here** — this model only marks the trust boundary E1 must respect so E6 can build on
  it safely (no plaintext-secret sinks introduced in E1: logs, screenshots, snapshots, `simctl`
  argv). Per CLAUDE.md the safety posture is dedicated test accounts + disposable/snapshotted sim
  state, never production endpoints/data — there is **no PCI/payments domain** here.

---

## Assets

| #   | Asset                                                                     | Why it matters                                                                                                                                          |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | The host developer/CI machine (macOS runner)                              | The adapter shells out to `simctl`/spawns the MCP server. Command/arg injection here is host RCE.                                                       |
| A2  | The user-supplied `.app` bundle + its path                                | Untrusted input from the FlowScout operator; controls `installApp(udid, appBundlePath)` and reaches the filesystem / `simctl`.                          |
| A3  | The mobile-mcp server process + WebDriverAgent                            | Long-lived child process driving the simulator; its transport, lifecycle, and version are E1's responsibility.                                          |
| A4  | Screenshots + accessibility snapshots (`ScreenshotBytes`, `A11ySnapshot`) | May capture whatever is on screen during a real-data run — including any logged-in test-account data, tokens shown in UI, or text typed via `typeText`. |
| A5  | Simulator snapshots / reset state                                         | The safety net for destructive real-data runs (F6). If reset silently no-ops, a "clean" run starts dirty.                                               |
| A6  | `.env` / process environment + connection config                          | Holds (in adjacent epics) `FLOWSCOUT_VAULT_KEY`, `DATABASE_URL`, LLM keys. E1 must not leak the env into logs or child-process argv/output.             |
| A7  | The mobile-mcp + MCP SDK + WDA dependency chain                           | ADR-0001 F1 names this the top dependency risk; a compromised/vulnerable version executes on A1.                                                        |
| A8  | Text passed to `typeText(udid, text)`                                     | In later epics this carries vault credentials into the app; E1 establishes whether that text can be logged/leaked.                                      |

## Trust boundaries

```
 [Operator / E2 engine]                         TB1
        │  appBundlePath, udid, bundleId, text, tap targets, snapshot names
        ▼
 ┌─────────────────────────────────────────────┐
 │  adapters/mobile-mcp  (the ONLY trusted-to-  │   TB2 ── child process spawn / stdio
 │  shell-out boundary in the system)           │──────────► mobile-mcp server + WDA
 │  - input validation lives HERE               │
 │  - simctl / process argv constructed HERE    │   TB3 ── filesystem
 └─────────────────────────────────────────────┘──────────► .app path, snapshot store, screenshots
        │                                            TB4 ── npm registry / pinned deps
        ▼
   domain types out (A11ySnapshot, ScreenshotBytes) — MCP vocab must NOT cross back inward
```

- **TB1 — caller → adapter:** every value (`appBundlePath`, `udid`, `bundleId`, `typeText` text,
  `snapshotName`, tap coordinates/element ids) is **untrusted input** even though the immediate
  caller is FlowScout's own engine: it ultimately derives from an operator and, later, from
  LLM-chosen actions. Validate at this boundary; never trust "internal" callers (ASVS V5).
- **TB2 — adapter → mobile-mcp server / WDA:** a spawned local child process over stdio. Trust =
  exact-version-pinned binary launched by a config-injected command. No network listener should be
  exposed; if WDA binds a port, it must be loopback-only.
- **TB3 — adapter → filesystem / `simctl`:** the `.app` path and snapshot operations touch the host
  FS and `xcrun simctl`. This is the **command/path-injection blast zone**.
- **TB4 — supply chain:** npm install of mobile-mcp + `@modelcontextprotocol/sdk` + transitive WDA.

---

## Threats (STRIDE) and mitigations

Each threat lists **STRIDE class · OWASP/CWE · the mitigation a developer implements · the ticket(s)
that own it · how the security gate verifies it.**

### T1 — Command / argument injection via `simctl`/shell-out (CRITICAL)

- **STRIDE:** Elevation of Privilege / Tampering. **OWASP A03:2021 Injection · CWE-78 (OS Command Injection), CWE-88 (Argument Injection).**
- **Threat:** OQ2/ADR-0002 may resolve a missing mobile-mcp tool by shelling out to `xcrun simctl`.
  `appBundlePath`, `udid`, `bundleId`, and `snapshotName` flow into that command. A value like
  `"; rm -rf ~"`, `$(...)`, or a leading-dash value (`--foo`) injected as a flag executes attacker
  intent on the host (A1).
- **Mitigation (testable):**
  1. **Never** build shell command strings. Use `execFile`/`spawn` with an **argv array** and
     `shell:false` — no `exec`, no string interpolation, no `sh -c`. (ASVS V5.3.4)
  2. Validate each value against a strict allowlist before it reaches argv: `udid` must match the
     UUID format; `bundleId` must match reverse-DNS `^[A-Za-z0-9._-]+$`; `snapshotName` must match
     `^[A-Za-z0-9._-]{1,64}$`. Reject (typed error), do not sanitize-and-continue.
  3. Guard argument-injection: reject any value beginning with `-` for positional args, or pass `--`
     before user-controlled positionals where the tool supports it.
- **Owns:** #14 (install/launch/shutdown argv), #16 (snapshot/reset argv), #12 (server-spawn argv).
  ADR-0002 must record whether a `simctl` fallback exists; if yes, #14/#16 implement this.
- **Gate check:** grep adapter for `exec(`/`` `sh -c` ``/template-string command construction → must
  be zero; confirm `execFile`/`spawn` argv form; confirm input-validation unit tests for malicious
  `udid`/`bundleId`/`snapshotName`/path values in the contract suite.

### T2 — Path traversal / arbitrary-file access via the user-supplied `.app` path (HIGH)

- **STRIDE:** Tampering / Information Disclosure. **OWASP A01:2021 Broken Access Control · CWE-22 (Path Traversal), CWE-73 (External Control of File Name or Path).**
- **Threat:** `installApp(udid, appBundlePath)` takes an operator-supplied path. Values like
  `../../etc/...`, a symlink, or an absolute path outside the intended build dir let a caller point
  the install/inspection logic at arbitrary host files, or smuggle a path that later flows into T1.
- **Mitigation (testable):**
  1. Resolve the path to its real canonical form (`fs.realpath`) and require it to stay within an
     **allowlisted base directory** supplied via injected config (e.g. `FLOWSCOUT_APP_BUNDLE_DIR`);
     reject anything resolving outside it (CWE-22 canonicalization).
  2. Verify the resolved target exists, is a directory ending in `.app`, and is readable, before any
     install attempt — produce the PRD's "missing/unreadable/non-simulator `.app`" typed error.
  3. Reject symlinks that escape the base dir after canonicalization.
- **Owns:** #14 (installApp validation). Config var added in #12 / documented in `.env.example`.
- **Gate check:** unit tests proving traversal/symlink/outside-base paths are rejected with the
  documented typed error; confirm canonicalization happens before any FS/`simctl` use.

### T3 — Untrusted/oversized MCP & WDA payloads parsed into domain types (MEDIUM)

- **STRIDE:** Denial of Service / Tampering. **OWASP A03 Injection / A05 Misconfig · CWE-20 (Improper Input Validation), CWE-400 (Uncontrolled Resource Consumption).**
- **Threat:** The adapter normalizes mobile-mcp accessibility-tree / screenshot payloads into
  `A11ySnapshot`/`ScreenshotBytes`. A malformed, oversized, or deeply-nested payload (a buggy or
  hostile server/app, or a giant a11y tree) can OOM/hang the host, or inject unexpected shapes that
  break callers. PRD edge cases already flag "empty/oversized" snapshots.
- **Mitigation (testable):**
  1. Bound payload sizes from injected config (max a11y-tree bytes/depth, max screenshot bytes);
     exceeding the bound is a typed, handled error — not a swallow, not an OOM.
  2. Validate/parse at the anti-corruption boundary (schema-check the MCP response shape) before
     constructing domain types; never pass raw MCP shapes inward (NFR1).
  3. Every driving/lifecycle call is bounded by a configured timeout (NFR3) so a hung server/WDA
     surfaces as a timeout error, not an indefinite hang.
- **Owns:** #15 (normalization + size bounds), #12 (call timeouts), #17 (readiness vs hang).
- **Gate check:** tests for oversized/empty/malformed payloads → handled typed errors; confirm
  timeouts are config-driven (no magic numbers) and exist on every server call.

### T4 — Sensitive on-screen data captured in screenshots / a11y snapshots (MEDIUM)

- **STRIDE:** Information Disclosure. **OWASP A02:2021 Cryptographic/Data Exposure · A09 Logging Failures · CWE-200 (Exposure of Sensitive Information), CWE-532 (Insertion of Sensitive Info into Log).**
- **Threat:** Real-data runs use dedicated test accounts, but screenshots and a11y trees can still
  capture test-account PII, session tokens rendered in UI, or text typed via `typeText`. E1 returns
  these as bytes/strings; if E1 writes them to disk in a world-readable location, logs their content,
  or names files predictably, that data leaks beyond its intended use.
- **Mitigation (testable):**
  1. E1 returns artifacts as bytes/URIs per the port and does **not** log their content. Log only
     metadata (size, dimensions, udid), never the snapshot/screenshot body or full a11y text.
  2. Any artifact E1 does write for the round-trip (#18) goes under a gitignored, non-world-readable
     working dir; never into the repo, never committed. (`.gitignore` already blocks `*.log`,
     `dist/`, `coverage/` — confirm artifacts land in an ignored path, e.g. a temp/run dir.)
  3. Treat snapshot/screenshot as sensitive: no inclusion in error messages or telemetry bodies.
- **Owns:** #15 (return-don't-log discipline), #18 (round-trip artifact storage location).
  Deeper redaction (credentials in a11y/screenshots) is a cross-cutting concern E6 extends.
- **Gate check:** grep for logging of snapshot/screenshot bodies → none; confirm round-trip artifacts
  are written to an ignored/temp path; gitleaks + a scan for committed `.png`/snapshot fixtures.

### T5 — Secrets / full env leaked via logs, errors, or child-process argv (HIGH)

- **STRIDE:** Information Disclosure. **OWASP A09:2021 Security Logging Failures · A05 Misconfig · CWE-532, CWE-209 (Information Exposure Through Error Message).**
- **Threat:** The composition root (#18) will load env (`FLOWSCOUT_VAULT_KEY`, `DATABASE_URL`, LLM
  keys) to construct the adapter config. Verbose connection logging, dumping `process.env` for
  debugging, passing secrets on the child-process command line (visible in `ps`), or echoing the
  full config in a connection error all leak secrets (A6). `typeText` text (A8) becomes a credential
  carrier in E6 — if E1 logs `typeText` args now, that pattern leaks creds later.
- **Mitigation (testable):**
  1. Never log resolved secrets, full env, or the full connection config. Log only non-secret,
     allowlisted fields (server command name, timeout values, udid). Redact by default.
  2. Do not pass secrets via child-process argv; pass via the spawned process's `env` only what it
     needs, never the whole parent env (avoid `env: process.env` blanket-pass).
  3. `typeText(udid, text)`: never log `text`. Establish this now even though no creds flow in E1, so
     the E6 vault inherits a no-log sink. (ASVS V7.1.1 — no sensitive data in logs.)
  4. Connection/lifecycle errors name the _cause_ (per PRD) without echoing secret config values.
- **Owns:** #12 (connection logging/errors, child `env` scoping), #18 (env loading at root),
  #15 (`typeText` no-log).
- **Gate check:** grep for `process.env` logging / `console.log(config`/ logging of `text` in
  `typeText` → none; confirm spawned process `env` is scoped, not blanket-passed; gitleaks clean.

### T6 — Untrusted / vulnerable mobile-mcp + WDA + MCP SDK supply chain (HIGH)

- **STRIDE:** Tampering / Elevation of Privilege. **OWASP A06:2021 Vulnerable & Outdated Components · A08 Software/Data Integrity · CWE-1104 (Unmaintained 3rd-Party Components), CWE-1357.**
- **Threat:** mobile-mcp, `@modelcontextprotocol/sdk`, and transitive WebDriverAgent run on the host
  (A1, A7) with FS + simulator + (for WDA) local-network reach. A vulnerable or typosquatted/
  compromised version executes in that context. ADR-0001 F1 names this the top dependency risk.
- **Mitigation (testable):**
  1. **Pin to exact versions** (no `^`/`~`) for mobile-mcp + MCP SDK in `packages/adapters/mobile-mcp`
     (NFR2). Lockfile committed; install with `--frozen-lockfile` in CI.
  2. Run **SCA (dependency vulnerability scan)** in CI and pre-commit (see policy below); a Critical/
     High advisory against these deps fails the build.
  3. Verify the package identity (correct scope/name `mobile-next/mobile-mcp`) to avoid typosquats;
     record the pinned version in ADR-0002.
- **Owns:** #12 (adds + pins the deps), repo CI/hooks policy (this epic mandates wiring SCA).
- **Gate check:** confirm exact pins in `package.json` (no range specifiers) and a committed lockfile;
  confirm SCA runs in CI + pre-commit; review SCA report for these deps at the security gate.

### T7 — Spoofed / untrusted MCP transport endpoint (MEDIUM)

- **STRIDE:** Spoofing / Tampering. **OWASP A05 Misconfig / A08 Integrity · CWE-300 (Channel Accessible by Non-Endpoint), CWE-306 (Missing Authentication).**
- **Threat:** The adapter "launches or connects to" the server (#12). A connect-to-an-existing-
  endpoint mode over a network socket, or a WDA HTTP port bound to `0.0.0.0`, lets another process/
  host impersonate the server or drive the simulator. The intended, safe transport is a locally
  **spawned** stdio child.
- **Mitigation (testable):**
  1. Default to spawning the server as a local child over **stdio** (per ADR-0001 §2.6) — the trusted
     path. The server command/path comes from injected config, not a remote URL.
  2. If any TCP/HTTP transport is used (WDA), bind to **loopback only** (`127.0.0.1`), never
     `0.0.0.0`; do not expose it on a routable interface.
  3. Do not auto-attach to a pre-existing endpoint the adapter did not spawn without an explicit,
     documented, config-gated opt-in.
- **Owns:** #12 (transport/spawn), #17 (readiness must verify the spawned server, not any responder).
- **Gate check:** confirm stdio spawn is the default; grep for `0.0.0.0`/listen on routable iface in
  adapter → none; confirm server command is config-injected, not a hardcoded/remote default.

### T8 — Orphaned simulator / server processes; reset that silently no-ops (MEDIUM)

- **STRIDE:** Denial of Service / Tampering of the safety control. **OWASP A04:2021 Insecure Design / A05 Misconfig · CWE-404 (Improper Resource Shutdown), CWE-672 (Operation on Resource After Expiration/Release).**
- **Threat:** Two linked risks. (a) Repeated runs leak booted sims / orphaned MCP processes (A1, A3)
  — resource exhaustion and a dirty host. (b) `resetToSnapshot` silently no-ops on a missing snapshot
  — the F6 safety net (A5) fails open, so a destructive real-data run proceeds from un-reset state.
- **Mitigation (testable):**
  1. `dispose()`/teardown reliably terminates the spawned server and shuts down booted sims, even on
     error paths (try/finally); the #18 round-trip asserts no orphaned sims/processes across ≥3 runs.
  2. `resetToSnapshot` to a non-existent name throws the documented typed error — it must **fail
     closed**, never silently no-op (already a PRD acceptance criterion; this model marks it a
     security-relevant control because it backstops the no-guardrails posture).
- **Owns:** #16 (reset fail-closed), #12 (server teardown), #14 (sim shutdown), #18 (no-orphan E2E).
- **Gate check:** confirm reset-missing-name test asserts a thrown error (not no-op); confirm
  teardown in finally; confirm the round-trip's no-orphan assertion exists.

### T9 — Fake driver / fixture `.app` carrying real data or secrets into the repo (LOW)

- **STRIDE:** Information Disclosure. **OWASP A05 Misconfig · CWE-540 (Information in Source Code), CWE-200.**
- **Threat:** `FakeMobileDriver` returns "canned" a11y + screenshot bytes (#13); the round-trip uses
  a fixture `.app` (#18, OQ3). Canned fixtures or a committed `.app`/screenshot could embed real PII,
  real account identifiers, or a real token used while building the fixture.
- **Mitigation (testable):**
  1. Fixtures and canned payloads contain only synthetic, obviously-fake data (no real identifiers,
     no real tokens, no personal absolute paths). (ASVS V14 / CLAUDE.md "never commit real
     identifiers".)
  2. The fixture `.app` source is documented (OQ3) and contains no embedded secrets; prefer
     referencing it rather than committing a binary with unknown contents.
- **Owns:** #13 (synthetic canned payloads), #18 (fixture `.app` hygiene).
- **Gate check:** gitleaks + manual review of canned fixtures for real-looking identifiers; confirm
  no real `.app`/screenshot with PII committed.

---

## Mandated automation policy for this epic (security owns; architect/developer wire)

Per the standing policy, **secret scanning + dependency SCA + SAST run in BOTH CI and pre-commit
hooks**. ADR-0001 §6 already mandates **gitleaks** in CI + local hooks; this epic adds/confirms:

| Control            | Tool (TS/Node stack)                                                                                                      | Threshold (fail condition)                                            | Where                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------- |
| Secret scanning    | gitleaks (already mandated §6)                                                                                            | any finding → fail                                                    | CI + pre-commit            |
| Dependency SCA     | `pnpm audit` (or osv-scanner / Snyk) — **required by T6**                                                                 | any **High/Critical** advisory → fail; Moderate → tracked follow-up   | CI + pre-commit (affected) |
| SAST               | typescript-eslint (strict) + `eslint-plugin-security` (detects `child_process` string-exec, non-literal fs paths, `eval`) | any High rule (e.g. `detect-child-process` on a non-argv call) → fail | CI + pre-commit            |
| Lockfile integrity | `pnpm install --frozen-lockfile`; exact pins for mobile-mcp/SDK                                                           | drift or range specifier on T6 deps → fail                            | CI                         |

The architect/developer implement these for the chosen stack; the security gate verifies they run and
are green on every E1 ticket. `eslint-plugin-security` is the concrete SAST lever for T1/T2 (it flags
`child_process` and non-literal-fs-path usage exactly where injection/traversal live).

---

## Per-ticket MUST-implement security requirements (#12–#18)

**#12 — MCP server connection & transport bootstrap**

- Spawn the server as a **local stdio child** by default; server command/path from injected config,
  not a remote URL or hardcoded path (T7). Construct spawn argv as an **array, `shell:false`** (T1).
- Scope the child process `env` — pass only what the server needs, never blanket `process.env` (T5).
- Do **not** log secrets, full env, or full config; connection errors name the cause without echoing
  secret values (T5). Every server call bounded by a **config-injected timeout** — no magic numbers (T3).
- **Pin mobile-mcp + `@modelcontextprotocol/sdk` to EXACT versions**; commit lockfile; verify package
  identity (no typosquat) (T6). Reliable teardown terminating the server (no orphan) (T8).

**#13 — FakeMobileDriver + shared contract-test suite**

- Canned a11y/screenshot payloads are **synthetic only** — no real identifiers, tokens, or PII (T9).
- Contract suite includes the **security/error cases as conformance assertions**: malformed/oversized
  payloads (T3), unknown udid, reset-to-missing-snapshot fails-closed (T8), and (for the real adapter)
  injection-shaped `udid`/`bundleId`/`snapshotName`/path values rejected (T1/T2).

**#14 — Simulator lifecycle (boot/select/install/launch/shutdown)**

- Validate `udid` (UUID), `bundleId` (reverse-DNS allowlist) before use; reject leading-`-` values (T1).
- If `simctl` fallback is used: **`execFile`/`spawn` argv only, no shell string** (T1).
- `installApp`: canonicalize `appBundlePath` (`realpath`), require it within an **allowlisted base dir**
  from config, require `.app` dir + readable, reject traversal/escaping symlinks — typed error (T2).
- All ops bounded by config timeout (T3). `shutdownSimulator` leaves no orphaned sim across runs (T8).

**#15 — Device driving + payload normalization**

- Bound a11y-tree/screenshot sizes from config; malformed/empty/oversized → typed handled error,
  never OOM/swallow (T3). Schema-validate MCP payloads before building domain types; no MCP shape
  leaks inward (T3/NFR1).
- **Never log `typeText` text**, screenshot bytes, or full a11y content — metadata only (T4/T5).
- Validate tap coordinate/element targets; off-screen/stale → typed action error (T1/T3).

**#16 — Snapshot / reset disposable simulator state**

- Validate `snapshotName` against `^[A-Za-z0-9._-]{1,64}$`; argv-array if shelling out (T1).
- `resetToSnapshot` on a missing name **fails closed** with a typed error — never a silent no-op
  (T8; this is the F6 safety backstop). Bounded by config timeout (T3).

**#17 — Health / readiness checks**

- Readiness verifies the **adapter-spawned** server/WDA, not any arbitrary responder (T7).
- Bounded polling/timeout from config; distinguish **retryable not-ready** vs **terminal failure** so
  driving calls never hang indefinitely (T3). Error/result messages name the cause without leaking
  secret config (T5).

**#18 — Composition-root wiring + scripted round-trip E2E**

- Load env at the root; pass only scoped, non-secret config into the adapter; never log full env/
  config (T5). If WDA exposes a port, ensure **loopback-only** binding (T7).
- Round-trip artifacts (screenshots/snapshots) written to a **gitignored, non-world-readable** working
  dir — never committed (T4). Fixture `.app` documented and free of embedded secrets/PII (T9).
- Round-trip asserts **no orphaned simulators/MCP processes** across ≥3 consecutive runs (T8).
- macOS real-sim E2E kept off the per-PR fast path (per ADR-0001 §7) — separately gated.

**Boundary note (all tickets):** E1 introduces **no plaintext-secret sinks** (logs, screenshots,
snapshots, child-process argv). The credential vault, credential redaction in `typeText`, and the 2FA
pause-and-ask flow are **E6 (`adapters/vault`)** and are out of scope here — E1's job is to leave clean
sinks so E6 can carry secrets through `typeText` without them leaking.
