/**
 * WorkflowExtractor — pure, deterministic rule-based workflow extraction (#54 / E3.1).
 *
 * Turns a finalized `StateGraph` VALUE into ordered end-to-end `Workflow[]`
 * (entry → outcome) via bounded DFS. Zero I/O, no driver, no LLM, no embeddings, no
 * repository port — trivially unit-testable (architect plan §4–5).
 *
 * Determinism is a hard requirement (AC2): every Map/Set is drained through an explicit
 * stable sort, and the workflow `id` is a content-derived hash of the ordered
 * state + edge.id chain — never a random UUID. Shuffling `graph.edges[]` yields a
 * deep-equal result, including ids.
 *
 * What this ticket does NOT do (deferred): naming/grouping/app-purpose (#56),
 * semantic hidden-path flagging (#58). Hence every workflow here has
 * `isHiddenPath = false` and `inferenceConfidence = null`, and `name`/`description`
 * are provisional rule placeholders #56 overwrites (AC6 / OQ3 guard).
 */
import type { StateEdge, StateGraph, StateIdentity, Workflow } from "@flowscout/domain";
import { type EntryPolicy, ruleBasedEntryPolicy } from "./EntryPolicy.js";
import { type OutcomePolicy, ruleBasedOutcomePolicy } from "./OutcomePolicy.js";
import { type ExtractionConfig, defaultExtractionConfig } from "./ExtractionConfig.js";
import { GraphAdjacency } from "./GraphAdjacency.js";
import { buildSteps } from "./WorkflowStepBuilder.js";

/** The extractor's public return contract. `orphanStateIds` is extractor-internal, not a domain field. */
export interface ExtractionResult {
  readonly workflows: readonly Workflow[];
  readonly orphanStateIds: readonly StateIdentity[];
}

/** One enumerated path, ready to be turned into a Workflow. */
interface EnumeratedPath {
  readonly states: readonly StateIdentity[];
  readonly edges: readonly StateEdge[];
}

/**
 * Pure rule-based extractor. Construct with policies + caps (DI); `extract` is sync
 * and side-effect-free.
 */
export class WorkflowExtractor {
  private readonly entryPolicy: EntryPolicy;
  private readonly outcomePolicy: OutcomePolicy;
  private readonly config: ExtractionConfig;

  constructor(
    entryPolicy: EntryPolicy = ruleBasedEntryPolicy,
    outcomePolicy: OutcomePolicy = ruleBasedOutcomePolicy,
    config: ExtractionConfig = defaultExtractionConfig,
  ) {
    this.entryPolicy = entryPolicy;
    this.outcomePolicy = outcomePolicy;
    this.config = config;
  }

  /** Extract end-to-end workflows from a finalized state graph. Pure; never throws on shape. */
  extract(graph: StateGraph): ExtractionResult {
    const adjacency = new GraphAdjacency(graph);
    const entries = this.entryPolicy.entries(graph, adjacency);

    const paths: EnumeratedPath[] = [];
    const visitedNodes = new Set<StateIdentity>();
    // Mutable cap state shared across the per-entry DFS calls.
    const capState = { stopped: false };

    for (const entry of entries) {
      if (capState.stopped) break;
      this.dfs(
        graph,
        adjacency,
        entry,
        [entry],
        [],
        new Set<StateIdentity>([entry]),
        paths,
        visitedNodes,
        capState,
      );
    }

    const workflows = this.toWorkflows(graph, paths);
    const orphanStateIds = this.collectOrphans(adjacency, visitedNodes);
    return { workflows, orphanStateIds };
  }

  /**
   * Bounded DFS from `node`. Emits a path when the node is an outcome, has no
   * unvisited outgoing edges, or a cap forces a stop. Uses a PER-PATH `visitedOnPath`
   * set so cycles close the path rather than infinite-recurse.
   */
  private dfs(
    graph: StateGraph,
    adjacency: GraphAdjacency,
    node: StateIdentity,
    pathStates: readonly StateIdentity[],
    pathEdges: readonly StateEdge[],
    visitedOnPath: ReadonlySet<StateIdentity>,
    out: EnumeratedPath[],
    visitedNodes: Set<StateIdentity>,
    capState: { stopped: boolean },
  ): void {
    // An outcome terminates the path here even if it has outgoing edges.
    if (this.outcomePolicy.isOutcome(node, graph, adjacency)) {
      this.emit(out, pathStates, pathEdges, visitedNodes, capState);
      return;
    }

    const outgoing = adjacency.edgesFrom(node);
    let recursed = false;

    for (const edge of outgoing) {
      if (capState.stopped) break;

      // Back-edge / cycle: close the current path into a workflow; do NOT recurse.
      // `edge.toId` is an ancestor already on `pathStates`, so it is still marked
      // visited via the emit below — only nodes BEYOND the cut are left unmarked.
      if (visitedOnPath.has(edge.toId)) {
        this.emit(out, pathStates, pathEdges, visitedNodes, capState);
        recursed = true;
        continue;
      }

      // Length cap: emit the truncated path (nothing silently dropped) and stop
      // descending. `edge.toId` is NOT appended, so it is intentionally left unmarked
      // here and surfaced as an orphan — symmetric with nodes further past the cut (#73).
      if (pathStates.length + 1 > this.config.maxPathLength) {
        this.emit(out, pathStates, pathEdges, visitedNodes, capState);
        recursed = true;
        continue;
      }

      this.dfs(
        graph,
        adjacency,
        edge.toId,
        [...pathStates, edge.toId],
        [...pathEdges, edge],
        new Set<StateIdentity>([...visitedOnPath, edge.toId]),
        out,
        visitedNodes,
        capState,
      );
      recursed = true;
    }

    // No child path was emitted (no outgoing edges, or a custom OutcomePolicy left a
    // sink non-terminal) ⇒ this path is still a workflow.
    if (!recursed) {
      this.emit(out, pathStates, pathEdges, visitedNodes, capState);
    }
  }

  /**
   * Record a path unless the workflow cap has already been hit. Flipping `capState.stopped`
   * here is the SINGLE source of cap enforcement — the per-entry and per-edge loops check it.
   *
   * Marking `visitedNodes` here (over the states actually appended to an emitted path) is
   * the SINGLE source of "visited" truth (#73): a node counts as visited only when it lands
   * on a real, emitted workflow path. Uncapped this is benign — every reachable node ends up
   * on some emitted path — but under a maxPathLength cut the node just past the boundary is
   * correctly left unmarked and surfaced as an orphan, symmetric with nodes further out.
   */
  private emit(
    out: EnumeratedPath[],
    pathStates: readonly StateIdentity[],
    pathEdges: readonly StateEdge[],
    visitedNodes: Set<StateIdentity>,
    capState: { stopped: boolean },
  ): void {
    if (capState.stopped) return;
    out.push({ states: pathStates, edges: pathEdges });
    for (const stateId of pathStates) visitedNodes.add(stateId);
    if (out.length >= this.config.maxWorkflows) {
      capState.stopped = true;
    }
  }

  /** Turn enumerated paths into deduped Workflow objects (dedupe by content-derived id). */
  private toWorkflows(graph: StateGraph, paths: readonly EnumeratedPath[]): readonly Workflow[] {
    const byId = new Map<string, Workflow>();
    for (const path of paths) {
      const id = workflowId(path.states, path.edges);
      if (byId.has(id)) continue;
      const steps = buildSteps(graph, path.states, path.edges);
      byId.set(id, {
        id,
        name: provisionalName(graph, path.states),
        description: provisionalDescription(graph, path.states),
        steps,
        isHiddenPath: false,
        inferenceConfidence: null,
      });
    }
    return [...byId.values()];
  }

  /** Nodes declared/referenced in the graph that no enumerated path ever visited. */
  private collectOrphans(
    adjacency: GraphAdjacency,
    visitedNodes: ReadonlySet<StateIdentity>,
  ): readonly StateIdentity[] {
    const orphans: StateIdentity[] = [];
    for (const nodeId of adjacency.allNodeIds()) {
      if (!visitedNodes.has(nodeId)) orphans.push(nodeId);
    }
    return orphans.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

/** No-arg-friendly factory wiring the rule-based defaults (composition at #59's root). */
export function defaultWorkflowExtractor(): WorkflowExtractor {
  return new WorkflowExtractor();
}

/**
 * Content-derived, deterministic workflow id: a pure FNV-1a 64-bit hash (hex) of the
 * ordered `stateId` + `edge.id` chain. Stable across runs and edge-shuffles (AC2) —
 * never random. Self-contained (no `node:crypto`) so the module stays dependency-free
 * and importable from any runtime.
 */
export function workflowId(states: readonly StateIdentity[], edges: readonly StateEdge[]): string {
  const chain: string[] = [];
  for (const state of states) chain.push(`s:${String(state)}`);
  for (const e of edges) chain.push(`e:${e.id}`);
  // States and edges are pushed in disjoint, length-prefixed-free order; because the
  // state count is `edges.length + 1` for a real path, the two segments can never be
  // confused, and the chain is fully determined by content (AC2).
  return fnv1a64Hex(chain.join("|"));
}

/** A 64-bit FNV-1a hash renders to this many hex characters (16 nibbles). */
const FNV64_HEX_WIDTH = 16;
/** Hexadecimal radix for rendering the hash. */
const HEX_RADIX = 16;

/** FNV-1a 64-bit hash → 16-char lowercase hex. Deterministic, collision-resistant enough for ids. */
function fnv1a64Hex(input: string): string {
  // 64-bit FNV-1a using BigInt for exact wrap-around arithmetic.
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_64 = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(HEX_RADIX).padStart(FNV64_HEX_WIDTH, "0");
}

/** Provisional rule placeholder name (#56 overwrites). "<entry label> → <outcome label>". */
function provisionalName(graph: StateGraph, states: readonly StateIdentity[]): string {
  return `${entryLabel(graph, states)} → ${outcomeLabel(graph, states)}`;
}

/** Provisional rule one-liner (#56 overwrites). Never carries purpose/group data. */
function provisionalDescription(graph: StateGraph, states: readonly StateIdentity[]): string {
  const hops = Math.max(0, states.length - 1);
  return `Path from "${entryLabel(graph, states)}" to "${outcomeLabel(graph, states)}" in ${String(hops)} step(s)`;
}

function entryLabel(graph: StateGraph, states: readonly StateIdentity[]): string {
  const first = states[0];
  return first === undefined ? "(empty)" : labelOf(graph, first);
}

function outcomeLabel(graph: StateGraph, states: readonly StateIdentity[]): string {
  const last = states[states.length - 1];
  return last === undefined ? "(empty)" : labelOf(graph, last);
}

function labelOf(graph: StateGraph, nodeId: StateIdentity): string {
  return graph.nodes.get(nodeId)?.label ?? String(nodeId);
}
