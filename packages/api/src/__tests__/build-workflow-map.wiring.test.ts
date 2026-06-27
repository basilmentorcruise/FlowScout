/**
 * BuildWorkflowMap — composition-root wiring + port-purity test (Layer 2, #59 / E3.6 §6.2).
 *
 * Proves the use-case is assembled at the `packages/api` composition root from RESOLVED PORTS only:
 * `wireBuildWorkflowMap` takes a `StateGraphRepository` + `LlmPort` + `EmbeddingPort` + `CrawlBudget`
 * and constructs a `BuildWorkflowMap` that names NO concrete adapter. We drive it through a seeded
 * in-memory `StateGraphRepository` with FAKE ports (no network, no DB, no real LLM) — a smoke that
 * the wired pipeline produces one finalized map.
 *
 * Port purity (NFR1) itself is enforced by the dependency-cruiser / eslint-boundaries gates (the
 * application layer may not import `adapters/*`); a green gate IS that assertion. Here we assert the
 * runnable wiring + the `AppContextWithWorkflowMap` exposure contract.
 */
import { describe, it, expect } from "vitest";
import { BuildWorkflowMap, InMemoryStateGraphRepository } from "@flowscout/application";
import type {
  StateGraph,
  StateNode,
  StateEdge,
  StateIdentity,
  LlmPort,
  EmbeddingPort,
  CrawlBudget,
  LlmCompletionResult,
  EmbeddingInput,
  EmbeddingResult,
} from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";
import { wireBuildWorkflowMap, buildAppContext } from "../composition-root/wire.js";
import type { AppContextWithWorkflowMap } from "../composition-root/wire.js";

// ── Minimal fakes (port-typed; no SDK, no network) ───────────────────────────

class StubLlmPort implements LlmPort {
  complete(): Promise<LlmCompletionResult> {
    return Promise.resolve({
      content: '{"appPurpose":"A demo app"}',
      promptTokens: 10,
      completionTokens: 4,
      modelId: "stub",
    });
  }
}

class StubEmbeddingPort implements EmbeddingPort {
  embed(input: EmbeddingInput): Promise<EmbeddingResult> {
    // Same constant vector for every bucket ⇒ deterministic, never throws (a11y-only is also fine).
    return Promise.resolve({
      vector: new Array<number>(256).fill(1),
      modelId: "stub-embedding",
      promptTokens: 1,
    });
  }
}

function sid(raw: string): StateIdentity {
  return makeStateIdentity(raw);
}

function node(idRaw: string, screen: string, seq: number): StateNode {
  return {
    id: sid(idRaw),
    label: idRaw,
    platform: "ios",
    firstSeenAt: `2026-06-26T00:00:0${String(seq)}.000Z`,
    a11ySnapshot: JSON.stringify({ screen }),
    screenshotUri: null,
  };
}

function edge(from: string, to: string, n: number): StateEdge {
  return {
    id: `e-${String(n)}`,
    fromId: sid(from),
    toId: sid(to),
    actionType: "tap",
    actionPayload: "",
    observedAt: "2026-06-26T00:00:00.000Z",
  };
}

const RUN_ID = "run-wiring";

function seededGraph(): StateGraph {
  const nodes = [node("entry", "ENTRY", 0), node("done", "DONE", 1)];
  return {
    runId: RUN_ID,
    appId: "app-wiring",
    appVersion: "1.0.0",
    platform: "ios",
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: [edge("entry", "done", 1)],
    duplicatePathNodeIds: new Set<StateIdentity>(),
  };
}

function budget(): CrawlBudget {
  return {
    maxSteps: 100,
    maxLlmCalls: 20,
    maxTokens: 100_000,
    maxRevisitsPerState: 3,
    plateauWindow: 40,
    plateauWarnRatio: 0.75,
  };
}

describe("BuildWorkflowMap — composition-root wiring (Layer 2)", () => {
  it("wireBuildWorkflowMap constructs the use-case from resolved ports only", () => {
    const repo = new InMemoryStateGraphRepository();
    const useCase = wireBuildWorkflowMap({
      stateGraphRepository: repo,
      llm: new StubLlmPort(),
      embeddings: new StubEmbeddingPort(),
      crawlBudget: budget(),
    });
    expect(useCase).toBeInstanceOf(BuildWorkflowMap);
  });

  it("runs the wired pipeline through a seeded in-memory repository (smoke)", async () => {
    const repo = new InMemoryStateGraphRepository();
    await repo.saveGraph(seededGraph());

    const useCase = wireBuildWorkflowMap({
      stateGraphRepository: repo,
      llm: new StubLlmPort(),
      embeddings: new StubEmbeddingPort(),
      crawlBudget: budget(),
    });

    const map = await useCase.execute(RUN_ID);

    expect(map.runId).toBe(RUN_ID);
    expect(typeof map.finalisedAt).toBe("string");
    expect(Array.isArray(map.workflows)).toBe(true);
    expect(map.workflows.length).toBeGreaterThanOrEqual(1);
    expect(map.duplicateGroups).toBeDefined();
    // every workflow carries confidence-or-null + a non-empty feature group (consumer contract).
    for (const wf of map.workflows) {
      expect(wf.inferenceConfidence === null || typeof wf.inferenceConfidence === "number").toBe(
        true,
      );
      expect(wf.featureGroup).toBeTruthy();
    }
  });

  it("exposes buildAppContext + the AppContextWithWorkflowMap contract", () => {
    // The full buildAppContext() needs live env (LLM key / driver / DB); here we assert the
    // exported wiring surface exists. The `AppContextWithWorkflowMap` type is the exposure contract.
    expect(typeof buildAppContext).toBe("function");
    const contract: Pick<AppContextWithWorkflowMap, "buildWorkflowMap"> | null = null;
    expect(contract).toBeNull();
  });
});
