/**
 * Capstone fixture + wiring helper for the E3.6 `BuildWorkflowMap` E2E (#59).
 *
 * A deterministic, multi-screen `StateGraph` VALUE plus a `buildUseCase(...)` helper that assembles
 * the five merged E3 passes EXACTLY as `packages/api`'s `wire.ts` will — over fakes, no network, no
 * simulator, no real LLM. The helper threads ONE shared `RunBudgetMeter` into all three budgeted
 * passes (the §4 shared-ceiling decision), so this fixture doubles as executable documentation of
 * the composition-root assembly.
 *
 * The graph carries, on purpose, BOTH duplicate cases the detector must tell apart:
 *   - DISTINCT-identity convergence: `out-a` and `out-b` are different raw buckets whose fake
 *     embeddings are scripted to cosine 1.0 ⇒ the refiner merges them ⇒ the longer route is a
 *     hidden/duplicate path (≥1 `DuplicatePathGroup`).
 *   - STRUCTURAL convergence: `hub` is one node reached via two paths with the SAME raw id (also in
 *     `duplicatePathNodeIds`) ⇒ E2's structural case ⇒ must NOT be flagged semantically (precision).
 *   - a CLEAN outcome (`leaf`) whose a11y snapshot carries a SYNTHETIC OTP token (redaction probe).
 */
import type {
  StateGraph,
  StateNode,
  StateEdge,
  StateIdentity,
  CrawlBudget,
  EmbeddingPort,
  LlmPort,
} from "@flowscout/domain";
import { makeStateIdentity, SamenessRefiner, defaultSamenessConfig } from "@flowscout/domain";

import { WorkflowExtractor } from "../extraction/WorkflowExtractor.js";
import { InferIntent, defaultInferIntentConfig } from "../intent/InferIntent.js";
import type { InferIntentConfig } from "../intent/InferIntent.js";
import { A11yIntentDeriver } from "../intent/A11yIntentDeriver.js";
import { LlmIntentRefiner } from "../intent/LlmIntentRefiner.js";
import { IntentBudgetGuard } from "../intent/IntentBudgetGuard.js";
import { InMemoryIntentCache } from "../intent/InMemoryIntentCache.js";
import { RefineIdentities } from "../sameness/RefineIdentities.js";
import { defaultRefineIdentitiesConfig } from "../sameness/RefineIdentitiesConfig.js";
import { SemanticDuplicateDetector } from "../sameness/SemanticDuplicateDetector.js";
import { defaultDuplicateDetectorConfig } from "../sameness/DuplicateDetectorConfig.js";
import { EmbeddingBudgetGuard } from "../sameness/EmbeddingBudgetGuard.js";
import { InMemoryEmbeddingCache } from "../sameness/InMemoryEmbeddingCache.js";
import { RuleNameStrategy } from "../grouping/RuleNameStrategy.js";
import { LlmNamingRefiner } from "../grouping/LlmNamingRefiner.js";
import { AppPurposeInferer } from "../grouping/AppPurposeInferer.js";
import { NameAndGroupWorkflows } from "../grouping/NameAndGroupWorkflows.js";
import { InMemoryGroupingCache } from "../grouping/InMemoryGroupingCache.js";
import { defaultGroupingConfig } from "../grouping/GroupingConfig.js";
import type { GroupingConfig } from "../grouping/GroupingConfig.js";
import { CredentialRedactor } from "../../crawl/redaction/CredentialRedactor.js";
import { InMemoryStateGraphRepository } from "../../crawl/persistence/InMemoryStateGraphRepository.js";
import { RunBudgetMeter } from "../budget/RunBudgetMeter.js";
import { BuildWorkflowMap } from "../BuildWorkflowMap.js";

// ── Constants ────────────────────────────────────────────────────────────────

export const RUN_ID = "run-capstone";

/** A synthetic OTP token planted in a node snapshot — must appear in NO output and NO prompt. */
export const SYNTHETIC_OTP = "482913";

// Screen tokens (the test skeleton projector returns these; embeddings are scripted by them).
const SCREENS = {
  ENTRY: "ENTRY",
  MID: "MID",
  OUTA: "OUTA",
  OUTB: "OUTB",
  P: "P",
  Q: "Q",
  HUB: "HUB",
  LEAF: "LEAF",
} as const;

// ── Builders ────────────────────────────────────────────────────────────────

export function id(raw: string): StateIdentity {
  return makeStateIdentity(raw);
}

function node(idRaw: string, snapshot: string, seq: number): StateNode {
  return {
    id: id(idRaw),
    label: idRaw,
    platform: "ios",
    // Distinct, increasing firstSeenAt so `entry` is the deterministic launch node.
    firstSeenAt: `2026-06-26T00:00:0${String(seq)}.000Z`,
    a11ySnapshot: snapshot,
    screenshotUri: null,
  };
}

function screenSnapshot(screen: string): string {
  return JSON.stringify({ screen });
}

let edgeSeq = 0;
function edge(from: string, to: string): StateEdge {
  edgeSeq += 1;
  return {
    id: `edge-${String(edgeSeq)}`,
    fromId: id(from),
    toId: id(to),
    actionType: "tap",
    actionPayload: "",
    observedAt: "2026-06-26T00:00:00.000Z",
  };
}

/**
 * Build the capstone fixture graph. `edgeSeq` is reset so edge ids are stable across calls
 * (determinism — two independent builds produce identical graphs).
 */
export function buildCapstoneGraph(): StateGraph {
  edgeSeq = 0;
  const nodes: StateNode[] = [
    node("entry", screenSnapshot(SCREENS.ENTRY), 0),
    node("mid", screenSnapshot(SCREENS.MID), 1),
    node("out-a", screenSnapshot(SCREENS.OUTA), 2),
    node("out-b", screenSnapshot(SCREENS.OUTB), 3),
    node("p", screenSnapshot(SCREENS.P), 4),
    node("q", screenSnapshot(SCREENS.Q), 5),
    node("hub", screenSnapshot(SCREENS.HUB), 6),
    // The clean leaf carries a synthetic OTP in observed static text (redaction probe).
    node(
      "leaf",
      JSON.stringify({ screen: SCREENS.LEAF, label: `Your verification code is ${SYNTHETIC_OTP}` }),
      7,
    ),
  ];
  const edges: StateEdge[] = [
    edge("entry", "out-a"), // short route to outcome A
    edge("entry", "mid"),
    edge("mid", "out-b"), // long route to outcome B (merges with A → hidden)
    edge("entry", "p"),
    edge("p", "hub"), // structural convergence (same raw id, two routes)
    edge("entry", "q"),
    edge("q", "hub"),
    edge("entry", "leaf"), // clean outcome with the OTP probe
  ];
  return {
    runId: RUN_ID,
    appId: "app-capstone",
    appVersion: "1.0.0",
    platform: "ios",
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges,
    // E2 flagged `hub` as a structural convergence point.
    duplicatePathNodeIds: new Set<StateIdentity>([id("hub")]),
  };
}

/** A constant all-ones vector — two of these have cosine 1.0 (a guaranteed merge). */
const DIM = 256;
export function constVec(): number[] {
  return new Array<number>(DIM).fill(1);
}
/** A unit vector on axis `i` — distinct axes are orthogonal (cosine 0, never a merge). */
export function axisVec(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i % DIM] = 1;
  return v;
}

/**
 * Scripted embedding vectors keyed by screen token. `out-a`/`out-b` (OUTA/OUTB) ⇒ constVec ⇒ merge;
 * every other screen is on a distinct orthogonal axis ⇒ no unwanted merge (precision).
 */
export function scriptedVectors(): ReadonlyMap<string, readonly number[]> {
  return new Map<string, readonly number[]>([
    [SCREENS.ENTRY, axisVec(10)],
    [SCREENS.MID, axisVec(11)],
    [SCREENS.OUTA, constVec()],
    [SCREENS.OUTB, constVec()],
    [SCREENS.P, axisVec(13)],
    [SCREENS.Q, axisVec(14)],
    [SCREENS.HUB, axisVec(15)],
    [SCREENS.LEAF, axisVec(16)],
  ]);
}

/** Number of distinct a11y buckets (= graph nodes) — the one-embedding-per-bucket ceiling. */
export const DISTINCT_BUCKETS = 8;

/**
 * The test skeleton projector: returns the `screen` token from a `{ "screen": "X", ... }` snapshot
 * so the embedded skeleton text is deterministic + scriptable. Mirrors the sameness eval fixture.
 */
function screenProjector(redactedSnapshot: string): string {
  try {
    const parsed = JSON.parse(redactedSnapshot) as { screen?: unknown };
    if (typeof parsed.screen === "string") return parsed.screen;
  } catch {
    /* not the screen-token shape */
  }
  return redactedSnapshot;
}

export function budget(overrides: Partial<CrawlBudget> = {}): CrawlBudget {
  return {
    maxSteps: 100,
    maxLlmCalls: 50,
    maxTokens: 1_000_000,
    maxRevisitsPerState: 3,
    plateauWindow: 40,
    plateauWarnRatio: 0.75,
    ...overrides,
  };
}

// ── Use-case wiring helper (mirrors `wire.ts`) ───────────────────────────────

export interface WiredCapstone {
  readonly useCase: BuildWorkflowMap;
  readonly meter: RunBudgetMeter;
}

export interface BuildUseCaseOptions {
  readonly graph?: StateGraph;
  readonly llm: LlmPort;
  readonly embeddings: EmbeddingPort;
  readonly crawlBudget: CrawlBudget;
  readonly intentConfig?: InferIntentConfig;
  readonly groupingConfig?: GroupingConfig;
  /** A fixed clock so `finalisedAt` is deterministic across runs (deep-equal). */
  readonly clock?: () => string;
  /** When true, omit the clock so `BuildWorkflowMap`'s real default (`Date`) is exercised. */
  readonly useRealClock?: boolean;
}

/**
 * Assemble `BuildWorkflowMap` from fakes, threading ONE shared `RunBudgetMeter` into the intent,
 * naming/purpose, and embedding budget guards — exactly the §4 shared-ceiling wiring `wire.ts` uses.
 */
export function buildUseCase(options: BuildUseCaseOptions): WiredCapstone {
  const {
    graph = buildCapstoneGraph(),
    llm,
    embeddings,
    crawlBudget,
    intentConfig = defaultInferIntentConfig(),
    groupingConfig = defaultGroupingConfig(),
    clock = () => "2026-06-26T12:00:00.000Z",
  } = options;

  const repo = new InMemoryStateGraphRepository();
  void repo.saveGraph(graph);

  const redactor = new CredentialRedactor();

  // ONE shared meter over the run budget → ONE global LLM+embedding ceiling (§4 / AC5).
  const meter = new RunBudgetMeter(crawlBudget);
  const intentGuard = new IntentBudgetGuard(meter);
  const embeddingGuard = new EmbeddingBudgetGuard(meter);

  // #54
  const extractor = new WorkflowExtractor();
  // #55
  const inferIntent = new InferIntent(
    redactor,
    new A11yIntentDeriver(),
    new LlmIntentRefiner(llm, intentGuard, new InMemoryIntentCache()),
    intentConfig,
  );
  // #58 (refine + detect)
  const refineIdentities = new RefineIdentities(
    embeddings,
    new InMemoryEmbeddingCache(),
    redactor,
    embeddingGuard,
    new SamenessRefiner(defaultSamenessConfig()),
    screenProjector,
    defaultRefineIdentitiesConfig(),
  );
  const detector = new SemanticDuplicateDetector(defaultDuplicateDetectorConfig());
  // #56 — one shared grouping cache between the naming refiner and the purpose inferer (as in wire.ts).
  const groupingCache = new InMemoryGroupingCache();
  const nameAndGroup = new NameAndGroupWorkflows(
    redactor,
    new RuleNameStrategy(),
    new LlmNamingRefiner(llm, intentGuard, groupingCache, redactor),
    new AppPurposeInferer(llm, intentGuard, groupingCache, redactor, groupingConfig),
    groupingConfig,
  );

  const useCase = options.useRealClock
    ? new BuildWorkflowMap(
        repo,
        extractor,
        inferIntent,
        refineIdentities,
        detector,
        nameAndGroup,
        meter,
      )
    : new BuildWorkflowMap(
        repo,
        extractor,
        inferIntent,
        refineIdentities,
        detector,
        nameAndGroup,
        meter,
        clock,
      );
  return { useCase, meter };
}
