# Security Agent Memory — FlowScout

- [Recurring risks: mobile-mcp adapter](recurring-risks-mobile-mcp.md) — the adapter is the system's only shell-out/FS trust boundary; injection, traversal, secret-in-log, supply-chain risks recur here.
- [Recurring risks: LLM boundary](recurring-risks-llm-boundary.md) — the decision-LLM (E2) is the 2nd external boundary; prompt-injection, data-to-LLM, output-validation, key-leak, cost-DoS recur in adapters/llm + crawl engine.
- [Scope boundaries by epic](scope-boundaries.md) — vault/2FA is E6 not E1; safety posture is test accounts + disposable sim state, no PCI/payments domain.
- [Mandated scanning policy](mandated-scanning-policy.md) — gitleaks + SCA + SAST in CI and pre-commit; thresholds and tools.
- [Recurring risk: CI scan ordering](recurring-risks-ci-scan-ordering.md) — fail-fast CI; an early Format/Lint failure aborts the job before gitleaks/SAST/depcruise run → diff unscanned → BLOCKED.
- [Recurring risks: CI secret handling](recurring-risks-ci-secret-handling.md) — e2e-macos.yml owner-secret footguns: no secrets in if:, no splice into run:, GITHUB_ENV vs step env: precedence.
- [Redaction / 2FA / no-prod controls](recurring-risks-redaction-2fa-noprod.md) — E2's three safety controls: loop wiring, invariants, fail-open posture caveat on the no-prod/reset guard.
- [Recurring risks: E3 semantic egress](recurring-risks-e3-semantic-egress.md) — E3 reuses the LLM boundary for inference + may add an embedding provider; egress→prompts/embeddings/WorkflowMap, key isolation, cost fan-out, proportionate injection, XSS-is-E4-handoff.
- [Recurring risks: E7 persistence](recurring-risks-e7-persistence.md) — E7 is the first durable at-rest boundary (local SQLite); cleartext-at-rest, DB-in-repo/perms, SQLi via appId/runId/cursor, prototype-pollution decode, native-addon supply chain, E4 XSS handoff.
- [Recurring risks: E6 vault](recurring-risks-e6-vault.md) — first at-rest + inbound-secret boundary; nonce/key/AAD/no-plaintext-disk/typing-redaction/screenshot-window/#103-CSRF controls to re-verify at every E6 gate.
- [Recurring risks: E4 HTML report](recurring-risks-e4-html-report.md) — E4 ENFORCES the T7 XSS handoff; self-contained HTML from attacker-influenceable content opened at file://. XSS(HIGH)/screenshotUri scheme/path-traversal/anchor-injection/phone-home/render-dep; E5 sandbox handoff.
