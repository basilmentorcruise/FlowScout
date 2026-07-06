/**
 * GraphCodec — pure, deterministic StateGraph ⇄ payload serialization (ADR-0008 §5).
 *
 * Maps → arrays sorted by key (code-unit order — locale-independent), Sets → sorted
 * arrays, object keys in a FIXED order: the same graph produces identical bytes
 * across runs/processes (byte-stable — enables future diffing). Edge ORDER is
 * semantic (appendEdge preserves it) and is kept verbatim.
 *
 * Decode rebuilds via `Map`/`Set` and allow-listed fields ONLY (M83.3/T5 —
 * prototype-pollution-safe; no eval/Function/reviver). String content (labels,
 * a11y snapshots, action payloads) round-trips byte-equal — raw and inert
 * (M83.5/M83.8: the upstream `[REDACTED]` marker passes through unchanged; this
 * codec introduces no new secret sink and never de-redacts). No I/O.
 */
import type { Platform, StateEdge, StateGraph, StateIdentity, StateNode } from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";
import {
  asArray,
  asRecord,
  parsePayload,
  PayloadCodecError,
  readEnum,
  readNullableString,
  readString,
} from "./primitives.js";

const PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["ios", "android"]);
const ACTION_TYPES: ReadonlySet<StateEdge["actionType"]> = new Set<StateEdge["actionType"]>([
  "tap",
  "swipe",
  "typeText",
  "scroll",
  "gesture",
  "navigate",
]);

/** Deterministic code-unit comparator (NEVER localeCompare — locale-dependent bytes). */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function encodeNode(node: StateNode): Record<string, unknown> {
  return {
    id: node.id,
    label: node.label,
    platform: node.platform,
    firstSeenAt: node.firstSeenAt,
    a11ySnapshot: node.a11ySnapshot,
    screenshotUri: node.screenshotUri,
  };
}

function encodeEdge(edge: StateEdge): Record<string, unknown> {
  return {
    id: edge.id,
    fromId: edge.fromId,
    toId: edge.toId,
    actionType: edge.actionType,
    actionPayload: edge.actionPayload,
    observedAt: edge.observedAt,
  };
}

function decodeNode(value: unknown): StateNode {
  const record = asRecord(value, "node");
  return {
    id: makeStateIdentity(readString(record, "id")),
    label: readString(record, "label"),
    platform: readEnum(record, "platform", PLATFORMS),
    firstSeenAt: readString(record, "firstSeenAt"),
    a11ySnapshot: readString(record, "a11ySnapshot"),
    screenshotUri: readNullableString(record, "screenshotUri"),
  };
}

function decodeEdge(value: unknown): StateEdge {
  const record = asRecord(value, "edge");
  return {
    id: readString(record, "id"),
    fromId: makeStateIdentity(readString(record, "fromId")),
    toId: makeStateIdentity(readString(record, "toId")),
    actionType: readEnum(record, "actionType", ACTION_TYPES),
    actionPayload: readString(record, "actionPayload"),
    observedAt: readString(record, "observedAt"),
  };
}

/** Encode a StateGraph to its deterministic JSON payload. */
export function encodeGraph(graph: StateGraph): string {
  const sortedNodes = [...graph.nodes.values()].sort((a, b) => byCodeUnit(a.id, b.id));
  const sortedDuplicateIds = [...graph.duplicatePathNodeIds].sort(byCodeUnit);
  return JSON.stringify({
    runId: graph.runId,
    appId: graph.appId,
    appVersion: graph.appVersion,
    platform: graph.platform,
    nodes: sortedNodes.map(encodeNode),
    edges: graph.edges.map(encodeEdge),
    duplicatePathNodeIds: sortedDuplicateIds,
  });
}

/** Decode a payload back into a deep-equal StateGraph (Map/Set rebuilt — M83.3). */
export function decodeGraph(payload: string): StateGraph {
  const record = parsePayload(payload);
  const nodes = new Map<StateIdentity, StateNode>();
  for (const value of asArray(record["nodes"], "nodes")) {
    const node = decodeNode(value);
    nodes.set(node.id, node);
  }
  const edges = asArray(record["edges"], "edges").map(decodeEdge);
  const duplicatePathNodeIds = new Set<StateIdentity>();
  for (const value of asArray(record["duplicatePathNodeIds"], "duplicatePathNodeIds")) {
    if (typeof value !== "string") {
      throw new PayloadCodecError("duplicatePathNodeIds must contain strings");
    }
    duplicatePathNodeIds.add(makeStateIdentity(value));
  }
  return {
    runId: readString(record, "runId"),
    appId: readString(record, "appId"),
    appVersion: readString(record, "appVersion"),
    platform: readEnum(record, "platform", PLATFORMS),
    nodes,
    edges,
    duplicatePathNodeIds,
  };
}
