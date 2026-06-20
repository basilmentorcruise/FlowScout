/**
 * State-graph domain model.
 * Nodes = app screens/states; edges = actions between them.
 * Duplicate/hidden-path detection = multiple distinct edge-paths resolving to the same identity node.
 */

/** Opaque identity for a screen/state node, computed by the StateIdentity strategy. */
export type StateIdentity = string & { readonly __brand: "StateIdentity" };

/** Create a StateIdentity from a raw string (factory — validates non-empty). */
export function makeStateIdentity(raw: string): StateIdentity {
  if (!raw || raw.trim().length === 0) {
    throw new Error("StateIdentity must be a non-empty string");
  }
  return raw as StateIdentity;
}

/** Platform the app under test runs on. */
export type Platform = "ios" | "android";

/** A single screen/state node in the crawl state-graph. */
export interface StateNode {
  readonly id: StateIdentity;
  readonly label: string;
  readonly platform: Platform;
  /** ISO-8601 timestamp when this state was first observed. */
  readonly firstSeenAt: string;
  /** Accessibility tree snapshot (serialized) at discovery time. */
  readonly a11ySnapshot: string;
  /** Screenshot URI (local file or object-store URI). */
  readonly screenshotUri: string | null;
}

/** The type of action that produced a graph edge. */
export type ActionType = "tap" | "swipe" | "typeText" | "scroll" | "gesture" | "navigate";

/** A directed edge between two state nodes, representing an observed action. */
export interface StateEdge {
  readonly id: string;
  readonly fromId: StateIdentity;
  readonly toId: StateIdentity;
  readonly actionType: ActionType;
  /** Serialized action payload (e.g. coordinates, text, direction). */
  readonly actionPayload: string;
  /** ISO-8601 timestamp when this transition was first observed. */
  readonly observedAt: string;
}

/** The complete crawl state-graph for one run. */
export interface StateGraph {
  readonly runId: string;
  readonly appId: string;
  readonly appVersion: string;
  readonly platform: Platform;
  readonly nodes: ReadonlyMap<StateIdentity, StateNode>;
  readonly edges: readonly StateEdge[];
  /** IDs of nodes that were reached via multiple distinct paths (duplicate/hidden-path detection). */
  readonly duplicatePathNodeIds: ReadonlySet<StateIdentity>;
}
