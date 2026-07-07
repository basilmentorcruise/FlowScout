# Architect Memory Index

- [E1 adapter decomposition](project_e1-adapter-decomposition.md) — facade+capability pattern letting concurrent tickets share one adapter package (ADR-0002)
- [E1 conformance harness](project_e1-conformance-harness.md) — decompose the contract suite by capability when you decompose the adapter (ADR-0003)
- [E2 crawl-engine decomposition](project_e2-crawl-engine-decomposition.md) — frozen StartCrawlRun shell + injected collaborators; StateIdentity/LLM/budget defaults (ADR-0004)
- [E2.6 decision-policy chain](project_e2-decision-policy-chain.md) — #36 chain landed; candidateActions via additive ctx ext; chain-head + candidate pop deferred to #37 (gate it there)
- [E1 frozen-facade evolution](project_e1-frozen-facade-evolution.md) — #12 freeze is a Wave-1 guard; sanctioned additive edits (e.g. #28 dispose) PASS; teardown stays off domain ports
- [E1 sample-app fixture](project_e1-sample-app-fixture.md) — #29 builds tiny SwiftUI .app from source for Layer B; owner FLOWSCOUT_FIXTURE_APP still wins; skip path unchanged
- [E3 workflow extraction](project_e3-workflow-extraction.md) — #54 pure extractor StateGraph→Workflow[]; no domain edit; isHiddenPath=false/conf=null; caps as config; disjoint from #55 intent
- [E3 intent inference](project_e3-intent-inference.md) — #55 additive overlay model (intent.ts) + new IntentCachePort; reuse E2 LlmPort/budget/redactor; label-only (ADR-0005)
- [E3 node-identity sameness](project_e3-node-identity-sameness.md) — ADR-0005: gated cascade, cosine 0.94 merge-only, a11y-text embedding in adapters/llm, post-hoc; unblocks #57/#58
- [E3 naming/grouping](project_e3-naming-grouping.md) — ADR-0007/#56: budgeted-LLM naming+group+app-purpose; additive fields on workflow.ts; LLM labels-only never invents/drops
- [E3.4 refinement seam](project_e3-57-refinement-seam.md) — #57 PASS (blocks+seam); post-hoc embedding ORCHESTRATOR deferred to #58 producer + #59 root-wiring; 2 should-fixes to #58
- [E3.5 duplicate detection](project_e3-58-duplicate-detection.md) — #58: RefineIdentities orchestrator + cross-identity SemanticDuplicateDetector; precision-first; additive EmbeddingCachePort/DuplicatePathGroup/projectA11ySkeleton
- [E3.6 capstone](project_e3-59-capstone.md) — #59 BuildWorkflowMap assembly; canonical-map POST-HOC (no collaborators edit); shared RunBudgetMeter; duplicateGroups additive; orphan debt deferred
- [E7 run persistence](project_e7-run-persistence.md) — ADR-0008 SQLite; #83+#84 PASS; coherence-window accepted-risk → #85 must treat run row as authoritative status; #85 owes 2 more #83-routed items
- [E4 HTML report](project_e4-html-report.md) — ADR-0009: SafeHtml T7 boundary; relative artifactUri; #87 PASS (first-seen order supersession recorded); #88/#89 forward conditions
- [E5 dashboard](project_e5-dashboard.md) — ADR-0010: Fastify pinned; persisted-map OQ1; same-origin sandbox="" OQ2; no-cancel OQ5; verbatim SSE (E6 seam); 4 reg-line seams
