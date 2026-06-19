---
description: Threat model (per epic) or security gate (per ticket) (security)
---

Invoke the `security` agent via the Agent tool. For an epic → produce the threat model + per-ticket security
requirements. For a PR/branch → run the security gate (OWASP, secrets/PII, SCA; block High+Critical, track Medium).

Epic/PR (if empty, infer from the current diff): $ARGUMENTS
