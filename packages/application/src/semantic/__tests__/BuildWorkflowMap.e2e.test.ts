/**
 * BuildWorkflowMap — E3.6 capstone E2E (Layer 1, application) (#59).
 *
 * Drives the assembled use-case directly against the capstone fixture graph with FAKES only —
 * no real LLM, no embedding provider, no simulator. Proves the epic success metric (a semantic
 * hidden/duplicate path is surfaced) plus the budget / determinism / degraded-safe / redaction
 * invariants the gate consumes.
 */
import { describe, it, expect } from "vitest";
import type { Workflow, WorkflowMap } from "@flowscout/domain";
import { FakeLlmPort } from "../../test-support/FakeLlmPort.js";
import { FakeEmbeddingPort } from "../../test-support/FakeEmbeddingPort.js";
import {
  buildUseCase,
  buildCapstoneGraph,
  scriptedVectors,
  budget,
  id,
  RUN_ID,
  SYNTHETIC_OTP,
  DISTINCT_BUCKETS,
} from "./buildWorkflowMapFixture.js";

/** A canned LLM purpose response (the inferer parses {"appPurpose":...}); intent/naming fall back. */
const PURPOSE_RESPONSE = '{"appPurpose":"A demo app for browsing and checkout"}';

function terminalStateId(wf: Workflow): string {
  const last = wf.steps[wf.steps.length - 1];
  return last ? (last.stateId as string) : "";
}

/** Find the single workflow whose terminal step lands on the given raw state id. */
function workflowEndingAt(map: WorkflowMap, rawOutcome: string): Workflow {
  const match = map.workflows.find((w) => terminalStateId(w) === rawOutcome);
  if (!match) throw new Error(`no workflow ends at ${rawOutcome}`);
  return match;
}

describe("BuildWorkflowMap — capstone E2E (Layer 1)", () => {
  it("assembles one finalized WorkflowMap: extracted + grouped + purpose + hidden path", async () => {
    const llm = new FakeLlmPort([], { kind: "ok", content: PURPOSE_RESPONSE });
    const embeddings = new FakeEmbeddingPort({ scripted: scriptedVectors() });
    const { useCase } = buildUseCase({
      llm,
      embeddings,
      crawlBudget: budget({ maxLlmCalls: 50 }),
    });

    const map = await useCase.execute(RUN_ID);

    // ── one finalized map honouring the contract ──
    expect(map.runId).toBe(RUN_ID);
    expect(map.finalisedAt).toBe("2026-06-26T12:00:00.000Z");

    // ── extraction + grouping: 5 reachable outcomes, each with a non-empty feature group ──
    expect(map.workflows).toHaveLength(5);
    for (const wf of map.workflows) {
      expect(wf.featureGroup).toBeTruthy();
      expect(wf.featureGroup?.length).toBeGreaterThan(0);
      // confidence-or-null on every value (ConfidenceScore is a branded number).
      expect(wf.inferenceConfidence === null || typeof wf.inferenceConfidence === "number").toBe(
        true,
      );
    }
    // every reachable outcome appears as a workflow.
    const outcomes = new Set(map.workflows.map(terminalStateId));
    expect(outcomes).toEqual(new Set(["out-a", "out-b", "hub", "hub", "leaf"]));

    // ── app purpose inferred ──
    expect(map.appPurpose).toBeTruthy();
    expect((map.appPurpose ?? "").length).toBeGreaterThan(0);
    expect(map.appPurposeConfidence === null || typeof map.appPurposeConfidence === "number").toBe(
      true,
    );

    // ── semantic duplicate / hidden path (the success metric) ──
    expect(map.duplicateGroups).toBeDefined();
    expect((map.duplicateGroups ?? []).length).toBeGreaterThanOrEqual(1);
    const group = (map.duplicateGroups ?? [])[0];
    if (!group) throw new Error("expected a duplicate group");
    // the flagged group is the CROSS-identity case: it spans the two distinct raw outcomes.
    const wfA = workflowEndingAt(map, "out-a"); // short route (2 steps) ⇒ canonical
    const wfB = workflowEndingAt(map, "out-b"); // long route (3 steps) ⇒ hidden
    expect(new Set(group.workflowIds)).toEqual(new Set([wfA.id, wfB.id]));
    expect(group.canonicalWorkflowId).toBe(wfA.id);
    expect(group.hiddenWorkflowIds).toEqual([wfB.id]);
    expect(wfB.isHiddenPath).toBe(true);
    expect(wfA.isHiddenPath).toBe(false);

    // ── precision: the STRUCTURAL convergent `hub` is NOT a semantic duplicate group ──
    const groupOutcomes = (map.duplicateGroups ?? []).map((g) => g.outcomeIdentity as string);
    expect(groupOutcomes).not.toContain("hub");
    for (const wf of map.workflows.filter((w) => terminalStateId(w) === "hub")) {
      expect(wf.isHiddenPath).toBe(false);
    }
  });

  it("bounds the SHARED budget: one embedding per distinct bucket, combined calls ≤ maxLlmCalls", async () => {
    const llm = new FakeLlmPort([], { kind: "ok", content: PURPOSE_RESPONSE });
    const embeddings = new FakeEmbeddingPort({ scripted: scriptedVectors() });
    const maxLlmCalls = 50;
    const { useCase, meter } = buildUseCase({
      llm,
      embeddings,
      crawlBudget: budget({ maxLlmCalls }),
    });

    await useCase.execute(RUN_ID);

    // one embedding per distinct bucket (cache-first — no re-embed).
    expect(embeddings.callCount).toBe(DISTINCT_BUCKETS);
    expect(new Set(embeddings.cacheKeys).size).toBe(DISTINCT_BUCKETS);
    // combined LLM + embedding spend is bounded by ONE shared ceiling.
    expect(llm.callCount + embeddings.callCount).toBeLessThanOrEqual(maxLlmCalls);
    expect(meter.callsUsed).toBe(llm.callCount + embeddings.callCount);
  });

  it("the shared ceiling STARVES later passes (proves one global counter, not per-pass)", async () => {
    // refineOnlyWeak:false ⇒ intent attempts tier-2 for every screen; a tiny cap of 2 is consumed
    // by intent FIRST, so the embedding pass (which shares the meter) gets ZERO calls. A per-pass
    // design would have let embedding spend 2 more — combined would exceed the cap.
    const llm = new FakeLlmPort([], { kind: "ok", content: "{}" });
    const embeddings = new FakeEmbeddingPort({ scripted: scriptedVectors() });
    const maxLlmCalls = 2;
    const { useCase } = buildUseCase({
      llm,
      embeddings,
      crawlBudget: budget({ maxLlmCalls }),
      intentConfig: { refinementEnabled: true, refineOnlyWeak: false },
    });

    const map = await useCase.execute(RUN_ID);

    expect(llm.callCount).toBe(maxLlmCalls); // intent saturates the shared cap
    expect(embeddings.callCount).toBe(0); // …leaving nothing for embeddings (sharing proven)
    expect(llm.callCount + embeddings.callCount).toBeLessThanOrEqual(maxLlmCalls);
    // still finalizes exactly one well-formed map.
    expect(map.runId).toBe(RUN_ID);
    expect(map.workflows).toHaveLength(5);
  });

  it("is degraded-safe: a FakeLlm that always throws still yields exactly one well-formed map", async () => {
    const llm = new FakeLlmPort([], { kind: "throws" });
    const embeddings = new FakeEmbeddingPort({ scripted: scriptedVectors() });
    const { useCase } = buildUseCase({
      llm,
      embeddings,
      crawlBudget: budget({ maxLlmCalls: 50 }),
    });

    const map = await useCase.execute(RUN_ID);

    // one map, never torn; rule-based labels + null confidences; embedding merge still works.
    expect(map.workflows).toHaveLength(5);
    for (const wf of map.workflows) {
      expect(wf.inferenceConfidence).toBeNull();
      expect(wf.featureGroup).toBeTruthy();
    }
    expect(map.appPurposeConfidence).toBeNull();
    expect((map.duplicateGroups ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("is deterministic: two independent runs produce a deep-equal map", async () => {
    const run = async (): Promise<WorkflowMap> => {
      const { useCase } = buildUseCase({
        llm: new FakeLlmPort([], { kind: "ok", content: PURPOSE_RESPONSE }),
        embeddings: new FakeEmbeddingPort({ scripted: scriptedVectors() }),
        crawlBudget: budget({ maxLlmCalls: 50 }),
      });
      return useCase.execute(RUN_ID);
    };
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toEqual(b);
  });

  it("redacts the synthetic OTP from every map field AND every LLM/embedding input", async () => {
    const llm = new FakeLlmPort([], { kind: "ok", content: PURPOSE_RESPONSE });
    const embeddings = new FakeEmbeddingPort({ scripted: scriptedVectors() });
    const { useCase } = buildUseCase({
      llm,
      embeddings,
      crawlBudget: budget({ maxLlmCalls: 50 }),
      // refine everything so the secret would reach the LLM/embedding if redaction failed.
      intentConfig: { refinementEnabled: true, refineOnlyWeak: false },
      groupingConfig: { refinementEnabled: true, refineOnlyWeak: false, inferPurposeWithLlm: true },
    });

    const map = await useCase.execute(RUN_ID);

    // the secret is in the source graph (sanity — so the test would catch a regression).
    const graph = buildCapstoneGraph();
    const leaf = graph.nodes.get(id("leaf"));
    expect(leaf?.a11ySnapshot).toContain(SYNTHETIC_OTP);

    // …but appears in NO output field.
    const serialisedMap = JSON.stringify(map);
    expect(serialisedMap).not.toContain(SYNTHETIC_OTP);

    // …and was NEVER sent to the LLM or the embedding port.
    expect(llm.allPromptText).not.toContain(SYNTHETIC_OTP);
    const embeddingInputs = embeddings.calls.map((c) => c.skeletonText).join("\n");
    expect(embeddingInputs).not.toContain(SYNTHETIC_OTP);
  });

  it("stamps finalisedAt from the default wall-clock when none is injected", async () => {
    const { useCase } = buildUseCase({
      llm: new FakeLlmPort([], { kind: "ok", content: PURPOSE_RESPONSE }),
      embeddings: new FakeEmbeddingPort({ scripted: scriptedVectors() }),
      crawlBudget: budget({ maxLlmCalls: 50 }),
      useRealClock: true,
    });
    const before = Date.now();
    const map = await useCase.execute(RUN_ID);
    const stamped = Date.parse(map.finalisedAt);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("returns a valid empty map for a missing graph (NFR6 edge case)", async () => {
    const { useCase } = buildUseCase({
      llm: new FakeLlmPort([], { kind: "ok", content: PURPOSE_RESPONSE }),
      embeddings: new FakeEmbeddingPort({ scripted: scriptedVectors() }),
      crawlBudget: budget(),
    });
    const map = await useCase.execute("no-such-run");
    expect(map.workflows).toHaveLength(0);
    expect(map.duplicateGroups).toEqual([]);
    expect(map.appPurpose).toBeUndefined();
    expect(map.runId).toBe("no-such-run");
  });
});
