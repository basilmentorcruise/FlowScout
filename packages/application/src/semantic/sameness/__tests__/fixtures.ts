/**
 * Shared deterministic fixtures for the E3.5 sameness suites (#58).
 *
 * Builders for StateNode / StateEdge / StateGraph / Workflow / IntentModel, plus a controllable
 * test skeleton projector and scripted embedding vectors. Everything is deterministic — no network,
 * no SDK, no real embedding model (driven entirely by `FakeEmbeddingPort`).
 */
import type {
  StateNode,
  StateEdge,
  StateGraph,
  StateIdentity,
  CrawlBudget,
  Workflow,
  WorkflowStep,
  ControlIntent,
  ScreenIntent,
  IntentModel,
} from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";

export function id(raw: string): StateIdentity {
  return makeStateIdentity(raw);
}

// ── Graph builders ─────────────────────────────────────────────────────────

/**
 * A node whose a11y snapshot carries a single `screen` token. The test projector returns that
 * token, so `FakeEmbeddingPort` scripted vectors can be keyed by it (full cosine control).
 */
export function node(idRaw: string, screen: string, snapshot?: string): StateNode {
  return {
    id: id(idRaw),
    label: "",
    platform: "ios",
    firstSeenAt: "2026-06-26T00:00:00.000Z",
    a11ySnapshot: snapshot ?? JSON.stringify({ screen }),
    screenshotUri: null,
  };
}

let edgeSeq = 0;
export function edge(fromId: StateIdentity, toId: StateIdentity): StateEdge {
  edgeSeq += 1;
  return {
    id: `edge-${String(edgeSeq)}`,
    fromId,
    toId,
    actionType: "tap",
    actionPayload: "",
    observedAt: "2026-06-26T00:00:00.000Z",
  };
}

export function graph(nodes: readonly StateNode[], edges: readonly StateEdge[] = []): StateGraph {
  return {
    runId: "run-1",
    appId: "app-1",
    appVersion: "1.0.0",
    platform: "ios",
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges,
    duplicatePathNodeIds: new Set(),
  };
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

// ── The controllable test projector ─────────────────────────────────────────

/**
 * Test skeleton projector: returns the `screen` token from a `{ "screen": "X" }` snapshot, so the
 * embedded skeleton text is deterministic and scriptable. Falls back to the raw string otherwise.
 */
export function screenProjector(redactedSnapshot: string): string {
  try {
    const parsed = JSON.parse(redactedSnapshot) as { screen?: unknown };
    if (typeof parsed.screen === "string") return parsed.screen;
  } catch {
    /* not the screen-token shape — fall through */
  }
  return redactedSnapshot;
}

// ── Scripted embedding vectors (dim = 256 = MIN_EMBEDDING_DIM) ────────────────

export const DIM = 256;

/** A constant all-ones vector — two of these have cosine 1.0 (a guaranteed merge). */
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
 * A "bridge" vector: a shared base on axis 0 plus a small `s`-offset on axis `i`. With `s = 0.3`,
 * two bridge vectors on different offset-axes each have cosine ≈ 0.958 to the base (axis-0 only)
 * but cosine ≈ 0.917 to EACH OTHER — so A and B merge only TRANSITIVELY through the base C
 * (A–C and C–B clear 0.94; A–B does not). This is the transitive label-veto-bypass fixture.
 */
export function bridgeVec(i: number, s = 0.3): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = 1;
  if (i > 0) v[i % DIM] = s;
  return v;
}

// ── Workflow builders ────────────────────────────────────────────────────────

export function step(stepIndex: number, stateId: StateIdentity): WorkflowStep {
  return { stepIndex, stateId, edge: null, description: `step ${String(stepIndex)}` };
}

/** Build a workflow whose terminal step's stateId is the outcome identity. */
export function workflow(idRaw: string, stateIds: readonly StateIdentity[]): Workflow {
  return {
    id: idRaw,
    name: `${idRaw} path`,
    description: "Provisional path",
    steps: stateIds.map((s, i) => step(i, s)),
    isHiddenPath: false,
    inferenceConfidence: null,
  };
}

// ── Intent builders ──────────────────────────────────────────────────────────

export function control(edgeId: string, intent: string): ControlIntent {
  return { edgeId, actionType: "tap", intent, affordance: "navigation", source: "a11y", confidence: null };
}

/** A screen intent. `source` defaults to "a11y"; pass "llm" for a confident label. */
export function screen(
  stateId: StateIdentity,
  purpose: string,
  source: "a11y" | "llm" | "degraded" = "a11y",
): ScreenIntent {
  return { stateId, purpose, source, confidence: null, controls: [] };
}

export function intentModel(screens: readonly ScreenIntent[], runId = "run-1"): IntentModel {
  return { runId, screens };
}
