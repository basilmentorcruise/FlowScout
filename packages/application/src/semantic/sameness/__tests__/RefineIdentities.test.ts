/**
 * RefineIdentities (the post-hoc embedding-pass orchestrator) — unit suite (#58).
 *
 * Covers the inherited HIGH controls: one-embedding-per-bucket (AC4), cache reuse (AC5), budget
 * bound (AC6), redaction-before-egress (AC7), degradation (AC9), determinism (AC10), and the
 * confident-label veto wiring. Deterministic: `FakeEmbeddingPort` only — no network, no SDK.
 */
import { describe, it, expect } from "vitest";
import { SamenessRefiner, defaultSamenessConfig, projectA11ySkeleton } from "@flowscout/domain";
import type { CrawlBudget, StateGraph, IntentModel } from "@flowscout/domain";
import { RefineIdentities } from "../RefineIdentities.js";
import type { SkeletonProjector } from "../RefineIdentities.js";
import { EmbeddingBudgetGuard } from "../EmbeddingBudgetGuard.js";
import { InMemoryEmbeddingCache } from "../InMemoryEmbeddingCache.js";
import { defaultRefineIdentitiesConfig } from "../RefineIdentitiesConfig.js";
import type { RefineIdentitiesConfig } from "../RefineIdentitiesConfig.js";
import { CredentialRedactor } from "../../../crawl/redaction/CredentialRedactor.js";
import { FakeEmbeddingPort } from "../../../test-support/FakeEmbeddingPort.js";
import {
  node,
  graph,
  budget,
  screenProjector,
  constVec,
  axisVec,
  id,
  screen,
  intentModel,
} from "./fixtures.js";

interface MakeOpts {
  readonly fake: FakeEmbeddingPort;
  readonly cache?: InMemoryEmbeddingCache;
  readonly budget?: CrawlBudget;
  readonly projector?: SkeletonProjector;
  readonly config?: RefineIdentitiesConfig;
}

function makeOrchestrator(opts: MakeOpts): {
  orchestrator: RefineIdentities;
  cache: InMemoryEmbeddingCache;
} {
  const cache = opts.cache ?? new InMemoryEmbeddingCache();
  const guard = new EmbeddingBudgetGuard(opts.budget ?? budget());
  const refiner = new SamenessRefiner(defaultSamenessConfig());
  const redactor = new CredentialRedactor();
  const orchestrator = new RefineIdentities(
    opts.fake,
    cache,
    redactor,
    guard,
    refiner,
    opts.projector ?? screenProjector,
    opts.config ?? defaultRefineIdentitiesConfig(),
  );
  return { orchestrator, cache };
}

/** Three distinct, non-merging buckets (orthogonal scripted vectors). */
function threeDistinctGraph(): StateGraph {
  return graph([node("n-a", "A"), node("n-b", "B"), node("n-c", "C")]);
}
function orthogonalScript(): FakeEmbeddingPort {
  return new FakeEmbeddingPort({
    scripted: new Map<string, readonly number[]>([
      ["A", axisVec(0)],
      ["B", axisVec(1)],
      ["C", axisVec(2)],
    ]),
  });
}

describe("RefineIdentities — one embedding per bucket (AC4)", () => {
  it("embeds exactly once per distinct bucket, keyed by the bucket identity", async () => {
    const fake = orthogonalScript();
    const { orchestrator } = makeOrchestrator({ fake });

    const result = await orchestrator.execute(threeDistinctGraph());

    expect(fake.callCount).toBe(3);
    expect(result.embeddingCallCount).toBe(3);
    // Cache keys are the N distinct identities — no duplicate embed call.
    const keys = fake.cacheKeys.map((k) => k as string).sort();
    expect(keys).toEqual(["n-a", "n-b", "n-c"]);
    expect(new Set(keys).size).toBe(3);
    // Orthogonal vectors ⇒ three singleton classes (no merge).
    expect(result.classes.size).toBe(3);
  });
});

describe("RefineIdentities — cache reuse (AC5)", () => {
  it("does not re-embed a bucket whose vector is already cached", async () => {
    const cache = new InMemoryEmbeddingCache();
    await cache.set(id("n-a"), axisVec(0)); // pre-populate bucket A
    const fake = orthogonalScript();
    const { orchestrator } = makeOrchestrator({ fake, cache });

    await orchestrator.execute(graph([node("n-a", "A"), node("n-b", "B")]));

    // Only the un-cached bucket B is embedded.
    expect(fake.callCount).toBe(1);
    expect(fake.cacheKeys.map((k) => k as string)).toEqual(["n-b"]);
  });
});

describe("RefineIdentities — budget bound (AC6)", () => {
  it("stops embedding once the budget is exhausted; still produces one valid result", async () => {
    const fake = new FakeEmbeddingPort({
      scripted: new Map<string, readonly number[]>([
        ["A", axisVec(0)],
        ["B", axisVec(1)],
        ["C", axisVec(2)],
        ["D", axisVec(3)],
      ]),
    });
    const { orchestrator } = makeOrchestrator({ fake, budget: budget({ maxLlmCalls: 2 }) });

    const g = graph([node("n-a", "A"), node("n-b", "B"), node("n-c", "C"), node("n-d", "D")]);
    const result = await orchestrator.execute(g);

    expect(result.embeddingCallCount).toBe(2);
    expect(fake.callCount).toBeLessThanOrEqual(2);
    // Exactly one result still produced; every bucket is present (a11y-only for the rest).
    expect(result.canonicalMap.size).toBe(4);
    expect(result.classes.size).toBe(4); // no merges (distinct vectors + a11y-only remainder)
  });

  it("counts a degraded embedding against the budget (every attempt counts)", async () => {
    const fake = new FakeEmbeddingPort({
      scripted: new Map<string, readonly number[]>([["B", axisVec(1)]]),
      degradeFor: new Set(["A"]), // A returns an empty vector but still consumes a call
    });
    const { orchestrator } = makeOrchestrator({ fake, budget: budget({ maxLlmCalls: 1 }) });

    const g = graph([node("n-a", "A"), node("n-b", "B")]);
    const result = await orchestrator.execute(g);

    // A consumed the only call (and degraded); B is a11y-only.
    expect(result.embeddingCallCount).toBe(1);
    expect(fake.cacheKeys.map((k) => k as string)).toEqual(["n-a"]);
    expect(result.classes.size).toBe(2);
  });
});

describe("RefineIdentities — redaction before egress (AC7, T1/T7)", () => {
  it("redacts the snapshot BEFORE the skeleton projector / embedding sees it", async () => {
    const SECRET_SNAPSHOT = JSON.stringify({
      role: "application",
      children: [
        { role: "secureTextField", label: "Password", value: "hunter2-SECRET" },
        { role: "staticText", label: "Your code is 482913" },
      ],
    });
    const projectorInputs: string[] = [];
    const spyProjector: SkeletonProjector = (redacted) => {
      projectorInputs.push(redacted);
      return "SECRET-SCREEN"; // controlled skeleton token (carries no secret)
    };
    const fake = new FakeEmbeddingPort({
      scripted: new Map<string, readonly number[]>([["SECRET-SCREEN", axisVec(0)]]),
    });
    const { orchestrator } = makeOrchestrator({ fake, projector: spyProjector });

    await orchestrator.execute(graph([node("n-secret", "ignored", SECRET_SNAPSHOT)]));

    // The projector (and therefore the embedding) only ever saw REDACTED text.
    expect(projectorInputs).toHaveLength(1);
    const seen = projectorInputs[0] as string;
    expect(seen).toContain("[REDACTED]");
    expect(seen).not.toContain("hunter2-SECRET");
    expect(seen).not.toContain("482913");
    // The skeletonText that egressed to the port carries no secret either.
    expect(fake.calls[0]?.skeletonText).toBe("SECRET-SCREEN");
  });

  it("the real projection of a redacted snapshot contains no seeded secret", async () => {
    const SECRET_SNAPSHOT = JSON.stringify({
      role: "application",
      children: [
        { role: "secureTextField", label: "Password", value: "hunter2-SECRET" },
        { role: "textField", label: "Code", value: "482913" },
      ],
    });
    const fake = new FakeEmbeddingPort();
    const { orchestrator } = makeOrchestrator({ fake, projector: projectA11ySkeleton });

    await orchestrator.execute(graph([node("n-secret", "ignored", SECRET_SNAPSHOT)]));

    const skeletonText = fake.calls[0]?.skeletonText ?? "";
    expect(skeletonText).not.toContain("hunter2-SECRET");
    expect(skeletonText).not.toContain("482913");
  });
});

describe("RefineIdentities — degradation (AC9, NFR6)", () => {
  it("returns a valid empty result for an empty graph", async () => {
    const fake = new FakeEmbeddingPort();
    const { orchestrator } = makeOrchestrator({ fake });

    const result = await orchestrator.execute(graph([]));

    expect(result.canonicalMap.size).toBe(0);
    expect(result.classes.size).toBe(0);
    expect(result.embeddingCallCount).toBe(0);
  });

  it("skips embedding when the projected skeleton is empty (degraded snapshot)", async () => {
    const fake = new FakeEmbeddingPort();
    const { orchestrator } = makeOrchestrator({ fake, projector: projectA11ySkeleton });

    // Empty snapshot ⇒ projectA11ySkeleton returns "" ⇒ no embed, a11y-only.
    const result = await orchestrator.execute(graph([node("n-x", "ignored", "")]));

    expect(fake.callCount).toBe(0);
    expect(result.classes.size).toBe(1);
  });

  it("a degraded (empty) embedding leaves the bucket a11y-only without crashing", async () => {
    const fake = new FakeEmbeddingPort({ degradeFor: new Set(["A"]) });
    const { orchestrator } = makeOrchestrator({ fake });

    const result = await orchestrator.execute(graph([node("n-a", "A")]));

    expect(fake.callCount).toBe(1);
    expect(result.canonicalMap.get(id("n-a"))).toBe(id("n-a"));
    expect(result.classes.size).toBe(1);
  });
});

describe("RefineIdentities — determinism (AC10)", () => {
  it("produces deep-equal results across repeated runs", async () => {
    const run = async (): Promise<unknown> => {
      const fake = orthogonalScript();
      const { orchestrator } = makeOrchestrator({ fake });
      return orchestrator.execute(threeDistinctGraph());
    };
    expect(await run()).toEqual(await run());
  });
});

describe("RefineIdentities — confident-label veto wiring (labelsFromIntent)", () => {
  // Two buckets with cosine 1.0 (constVec each) — a guaranteed merge candidate.
  const mergeGraph = (): StateGraph => graph([node("n-x", "X"), node("n-y", "Y")]);
  const mergeScript = (): FakeEmbeddingPort =>
    new FakeEmbeddingPort({
      scripted: new Map<string, readonly number[]>([
        ["X", constVec()],
        ["Y", constVec()],
      ]),
    });

  it("vetoes the merge when confident (llm) labels conflict", async () => {
    const intent: IntentModel = intentModel([
      screen(id("n-x"), "Sign in", "llm"),
      screen(id("n-y"), "Create account", "llm"),
    ]);
    const fake = mergeScript();
    const { orchestrator } = makeOrchestrator({ fake });

    const result = await orchestrator.execute(mergeGraph(), intent);

    // Conflicting confident labels ⇒ kept distinct (two classes).
    expect(result.classes.size).toBe(2);
  });

  it("ignores non-confident (a11y) labels — cosine merge stands", async () => {
    const intent: IntentModel = intentModel([
      screen(id("n-x"), "Sign in", "a11y"),
      screen(id("n-y"), "Create account", "a11y"),
    ]);
    const fake = mergeScript();
    const { orchestrator } = makeOrchestrator({ fake });

    const result = await orchestrator.execute(mergeGraph(), intent);

    // a11y labels are not passed ⇒ no veto ⇒ the two buckets MERGE (one class).
    expect(result.classes.size).toBe(1);
  });
});
