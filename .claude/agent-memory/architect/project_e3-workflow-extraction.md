---
name: e3-workflow-extraction
description: E3.1 #54 — pure rule-based WorkflowExtractor over StateGraph; no domain edit; isHiddenPath=false/confidence=null; caps as config
metadata:
  type: project
---

E3.1 (#54) plan: `docs/sdlc/architecture/E3.1-workflow-extraction-plan.md`. Pure deterministic extractor in
**`packages/application/src/semantic/extraction/**`** (new `semantic/`sibling to`crawl/`) turning a finalized
`StateGraph`→`Workflow[]`. **No port dependency** — takes the `StateGraph`*value*, not`StateGraphRepository`(that read +`WorkflowMap`assembly is #59's`BuildWorkflowMap` use-case). Patterns: Strategy
(`EntryPolicy`/`OutcomePolicy`), Builder (steps), pure-fn/DI.

**The real model is sufficient — NO domain edit for #54.** Populates existing
`packages/domain/src/models/workflow.ts` (`Workflow`/`WorkflowStep`/`WorkflowMap` already scaffolded). Rules the
arch-review gate must enforce: `isHiddenPath=false` always (#58 owns it), `inferenceConfidence=null` always (#56
owns it), `Workflow.id` content-derived (not UUID — determinism), `name`/`description` are provisional rule-strings
#56 overwrites and **must NOT be overloaded** to carry app-purpose/feature-group (that's **OQ3** — additive
optional field vs wrapper, an architect+E4 decision, deferred). If a dev adds a domain field, it's a scope-creep
signal → flag. Only sanctioned new type is `ExtractionConfig` (caps value object) living in `application`, NOT
`domain/models`.

**Traversal:** adjacency index w/ stable edge sort; entries = in-degree-0 sources ∪ min-`firstSeenAt` launch node;
outcomes = sinks ∪ `graph.duplicatePathNodeIds`. Bounded DFS with **per-path `visitedOnPath`** (not global) so
back-edges close a path instead of recursing → cycles bounded. Two config caps (no magic numbers):
`maxPathLength=40`, `maxWorkflows=500` (`defaultExtractionConfig`). Returns
`ExtractionResult { workflows, orphanStateIds }` — unvisited nodes surfaced (AC5), not dropped.

**Touches (disjoint from #55):** `semantic/extraction/**` + additive `application/src/index.ts` barrel lines only.
**#55 (E3.2 intent)** owns `semantic/intent/**` + may add an `Intent` domain model — different subtree + different
domain file; only shared file is the barrel (serialize/rebase). Extraction & intent share NO source file.
ADR-0005 (E3 sameness spike #53) is a SIBLING not a dep — #54 is deterministic, consumes no
sameness/embedding/LLM. See [[e2-crawl-engine-decomposition]] for the StateGraph/duplicatePathNodeIds origin and
the per-ticket-`__tests__`/no-`vitest.config`-edit decomposition discipline this reuses.
