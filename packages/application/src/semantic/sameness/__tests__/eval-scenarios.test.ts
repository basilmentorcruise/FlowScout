/**
 * Eval scenarios — Semantic duplicate / hidden-path detection (E3.5 / #58).
 *
 * Documented in `docs/sdlc/evals/duplicate-paths/README.md`. These run the FULL pipeline end-to-end
 * — the post-hoc embedding-pass `RefineIdentities` (with a scripted `FakeEmbeddingPort`) THEN the
 * pure `SemanticDuplicateDetector` — with NO real LLM and NO simulator. They define the correctness
 * invariants of the differentiator and bite in CI when the algorithm or thresholds change.
 *
 *   EVAL-1: a genuine cross-identity hidden path IS flagged (AC1).
 *   EVAL-2: a similar-but-distinct outcome pair is NOT flagged (AC2 — the precision floor).
 *   EVAL-3: a transitive A–C–B merge with conflicting outcome labels is suppressed; a clean one is
 *           flagged and the hidden route marked (AC3).
 */
import { describe, it, expect } from "vitest";
import { SamenessRefiner, defaultSamenessConfig } from "@flowscout/domain";
import type { StateGraph } from "@flowscout/domain";
import { RefineIdentities } from "../RefineIdentities.js";
import { SemanticDuplicateDetector } from "../SemanticDuplicateDetector.js";
import { EmbeddingBudgetGuard } from "../EmbeddingBudgetGuard.js";
import { InMemoryEmbeddingCache } from "../InMemoryEmbeddingCache.js";
import { defaultRefineIdentitiesConfig } from "../RefineIdentitiesConfig.js";
import { defaultDuplicateDetectorConfig } from "../DuplicateDetectorConfig.js";
import { CredentialRedactor } from "../../../crawl/redaction/CredentialRedactor.js";
import { FakeEmbeddingPort } from "../../../test-support/FakeEmbeddingPort.js";
import {
  node,
  graph,
  budget,
  screenProjector,
  constVec,
  axisVec,
  bridgeVec,
  id,
  workflow,
  screen,
  intentModel,
} from "./fixtures.js";

function runRefine(
  g: StateGraph,
  fake: FakeEmbeddingPort,
): ReturnType<RefineIdentities["execute"]> {
  const orchestrator = new RefineIdentities(
    fake,
    new InMemoryEmbeddingCache(),
    new CredentialRedactor(),
    new EmbeddingBudgetGuard(budget()),
    new SamenessRefiner(defaultSamenessConfig()),
    screenProjector,
    defaultRefineIdentitiesConfig(),
  );
  return orchestrator.execute(g);
}

const ENTRY = id("entry");
const MID = id("mid");

describe("EVAL-1 — genuine cross-identity hidden path IS flagged (AC1)", () => {
  it("merges two distinct outcome buckets and flags the longer route hidden", async () => {
    // out-x and out-y are distinct a11y buckets; scripted to cosine 1.0 ⇒ the refiner merges them.
    const g = graph([
      node("entry", "ENTRY"),
      node("mid", "MID"),
      node("out-x", "X"),
      node("out-y", "Y"),
    ]);
    const fake = new FakeEmbeddingPort({
      scripted: new Map<string, readonly number[]>([
        ["ENTRY", axisVec(10)],
        ["MID", axisVec(11)],
        ["X", constVec()],
        ["Y", constVec()],
      ]),
    });

    const refined = await runRefine(g, fake);
    // The two outcomes collapsed into one canonical class.
    expect(refined.canonicalMap.get(id("out-x"))).toBe(refined.canonicalMap.get(id("out-y")));

    const wfShort = workflow("wf-short", [ENTRY, id("out-x")]); // 2 steps
    const wfLong = workflow("wf-long", [ENTRY, MID, id("out-y")]); // 3 steps
    const result = new SemanticDuplicateDetector(defaultDuplicateDetectorConfig()).detect(
      [wfShort, wfLong],
      refined.canonicalMap,
    );

    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.duplicateGroups[0]?.canonicalWorkflowId).toBe("wf-short");
    expect(result.duplicateGroups[0]?.hiddenWorkflowIds).toEqual(["wf-long"]);
    const byId = new Map(result.workflows.map((w) => [w.id, w]));
    expect(byId.get("wf-long")?.isHiddenPath).toBe(true);
  });
});

describe("EVAL-2 — similar-but-distinct outcome pair is NOT flagged (AC2)", () => {
  it("keeps below-threshold outcomes distinct ⇒ no group, no hidden flag", async () => {
    const g = graph([
      node("entry", "ENTRY"),
      node("out-confirmed", "OK"),
      node("out-cancelled", "NO"),
    ]);
    const fake = new FakeEmbeddingPort({
      scripted: new Map<string, readonly number[]>([
        ["ENTRY", axisVec(10)],
        ["OK", axisVec(0)], // orthogonal ⇒ cosine 0 ⇒ never merge
        ["NO", axisVec(1)],
      ]),
    });

    const refined = await runRefine(g, fake);
    // Distinct canonical ids (no merge).
    expect(refined.canonicalMap.get(id("out-confirmed"))).not.toBe(
      refined.canonicalMap.get(id("out-cancelled")),
    );

    const wfA = workflow("wf-a", [ENTRY, id("out-confirmed")]);
    const wfB = workflow("wf-b", [ENTRY, id("out-cancelled")]);
    const result = new SemanticDuplicateDetector(defaultDuplicateDetectorConfig()).detect(
      [wfA, wfB],
      refined.canonicalMap,
    );

    expect(result.duplicateGroups).toHaveLength(0);
    expect(result.workflows.every((w) => !w.isHiddenPath)).toBe(true);
  });
});

describe("EVAL-3 — transitive merge: conflicting labels suppressed, clean merge flagged (AC3)", () => {
  // out-a and out-b clear 0.94 only THROUGH the bridge bucket out-c (A–C, C–B clear; A–B does not).
  function transitiveGraph(): StateGraph {
    return graph([
      node("entry", "ENTRY"),
      node("mid", "MID"),
      node("out-a", "A"),
      node("out-c", "C"),
      node("out-b", "B"),
    ]);
  }
  function transitiveFake(): FakeEmbeddingPort {
    return new FakeEmbeddingPort({
      scripted: new Map<string, readonly number[]>([
        ["ENTRY", axisVec(10)],
        ["MID", axisVec(11)],
        ["A", bridgeVec(1)],
        ["C", bridgeVec(0)], // the base/bridge
        ["B", bridgeVec(2)],
      ]),
    });
  }
  const wfA = workflow("wf-a", [ENTRY, id("out-a")]); // 2 steps
  const wfB = workflow("wf-b", [ENTRY, MID, id("out-b")]); // 3 steps

  it("co-classes A and B transitively via C (the bypass exists)", async () => {
    const refined = await runRefine(transitiveGraph(), transitiveFake());
    expect(refined.canonicalMap.get(id("out-a"))).toBe(refined.canonicalMap.get(id("out-b")));
  });

  it("SUPPRESSES the false duplicate when outcome labels confidently conflict", async () => {
    const refined = await runRefine(transitiveGraph(), transitiveFake());
    const intent = intentModel([
      screen(id("out-a"), "Order confirmed", "llm"),
      screen(id("out-b"), "Order cancelled", "llm"),
    ]);

    const result = new SemanticDuplicateDetector(defaultDuplicateDetectorConfig()).detect(
      [wfA, wfB],
      refined.canonicalMap,
      intent,
    );

    expect(result.duplicateGroups).toHaveLength(0);
    expect(result.workflows.every((w) => !w.isHiddenPath)).toBe(true);
  });

  it("FLAGS the clean transitive merge and marks the hidden route", async () => {
    const refined = await runRefine(transitiveGraph(), transitiveFake());
    const intent = intentModel([
      screen(id("out-a"), "Order confirmed", "llm"),
      screen(id("out-b"), "Order confirmed", "llm"),
    ]);

    const result = new SemanticDuplicateDetector(defaultDuplicateDetectorConfig()).detect(
      [wfA, wfB],
      refined.canonicalMap,
      intent,
    );

    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.duplicateGroups[0]?.canonicalWorkflowId).toBe("wf-a");
    expect(result.duplicateGroups[0]?.hiddenWorkflowIds).toEqual(["wf-b"]);
  });
});
