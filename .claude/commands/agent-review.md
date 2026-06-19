---
description: Code-review gate on a PR (code-reviewer)
---

Invoke the `code-reviewer` agent via the Agent tool to run the code-review gate: correctness, code smells,
DRY/reuse, readability, and test quality. Returns APPROVE or CHANGES-REQUESTED (must-fix blocks).

PR/branch (if empty, infer from the current diff): $ARGUMENTS
