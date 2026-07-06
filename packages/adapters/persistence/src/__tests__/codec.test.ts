/**
 * Codec unit tests (E7.1 / #83, ADR-0008 §5 + e7 threat model).
 *
 * Evidence for:
 *   - byte-determinism: same aggregate ⇒ identical payload bytes, construction
 *     key-order independent (enables future diffing),
 *   - Map/Set round-trip fidelity (deep-equal reload),
 *   - T1/M83.5: `[REDACTED]` marker passthrough — the codec introduces no new
 *     secret sink and never de-redacts,
 *   - T7/M83.8: strings stored raw/inert — byte-equal, no escaping on write,
 *   - T5/M83.3: prototype-pollution-safe decode (`__proto__`/`constructor` keys
 *     in a hostile payload never pollute Object.prototype).
 */
import { describe, it, expect } from "vitest";
import type { Run, StateGraph } from "@flowscout/domain";
import {
  defaultRunFixtures,
  defaultGraphFixtures,
  defaultReportFixtures,
  REDACTED_MARKER,
  HOSTILE_MARKUP,
} from "@flowscout/testing-persistence";
import { encodeRun, decodeRun } from "../sqlite/codec/RunCodec.js";
import { encodeGraph, decodeGraph } from "../sqlite/codec/GraphCodec.js";
import { encodeReport, decodeReport } from "../sqlite/codec/ReportCodec.js";
import { PayloadCodecError } from "../sqlite/codec/primitives.js";

describe("RunCodec", () => {
  it("round-trips a Run deep-equal", () => {
    const run = defaultRunFixtures.makeRun();
    expect(decodeRun(encodeRun(run))).toEqual(run);
  });

  it("is byte-deterministic and construction-key-order independent", () => {
    const run = defaultRunFixtures.makeRun();
    // Same content, different property insertion order.
    const reordered = {
      schemaVersion: run.schemaVersion,
      finishedAt: run.finishedAt,
      status: run.status,
      id: run.id,
      appVersion: run.appVersion,
      appId: run.appId,
      platform: run.platform,
      policyVersion: run.policyVersion,
      startedAt: run.startedAt,
      driverVersion: run.driverVersion,
      budget: { ...run.budget },
    } satisfies Run;
    expect(encodeRun(run)).toBe(encodeRun(run));
    expect(encodeRun(reordered)).toBe(encodeRun(run));
  });

  it("throws a typed PayloadCodecError on a corrupt payload", () => {
    expect(() => decodeRun("not json")).toThrow(PayloadCodecError);
    expect(() => decodeRun('{"id":42}')).toThrow(PayloadCodecError);
    expect(() => decodeRun('{"id":"r","status":"bogus"}')).toThrow(PayloadCodecError);
  });
});

describe("GraphCodec", () => {
  it("round-trips nodes Map, ordered edges, and duplicate-path Set deep-equal", () => {
    const graph = defaultGraphFixtures.makeGraph();
    const decoded = decodeGraph(encodeGraph(graph));
    expect(decoded).toEqual(graph);
    expect(decoded.nodes).toBeInstanceOf(Map);
    expect(decoded.duplicatePathNodeIds).toBeInstanceOf(Set);
    expect(decoded.edges.map((e) => e.id)).toEqual(graph.edges.map((e) => e.id));
  });

  it("is byte-deterministic regardless of Map/Set insertion order", () => {
    const graph = defaultGraphFixtures.makeGraph();
    const reversedNodes = new Map([...graph.nodes.entries()].reverse());
    const reversedDupes = new Set([...graph.duplicatePathNodeIds].reverse());
    const shuffled: StateGraph = {
      ...graph,
      nodes: reversedNodes,
      duplicatePathNodeIds: reversedDupes,
    };
    expect(encodeGraph(graph)).toBe(encodeGraph(graph));
    expect(encodeGraph(shuffled)).toBe(encodeGraph(graph));
  });

  it("passes the [REDACTED] marker through unchanged — no new sink, no de-redaction (T1/M83.5)", () => {
    const graph = defaultGraphFixtures.makeGraph();
    const payload = encodeGraph(graph);
    expect(payload).toContain(REDACTED_MARKER);
    const decoded = decodeGraph(payload);
    for (const [id, node] of graph.nodes) {
      // Byte-equal: raw/inert, marker intact, no unmasking (also T7/M83.8).
      expect(decoded.nodes.get(id)?.label).toBe(node.label);
      expect(decoded.nodes.get(id)?.a11ySnapshot).toBe(node.a11ySnapshot);
    }
  });

  it("stores hostile markup raw/inert — no escaping on write (T7/M83.8)", () => {
    const node = defaultGraphFixtures.makeNode({ label: HOSTILE_MARKUP });
    const graph = defaultGraphFixtures.makeGraph({
      nodes: new Map([[node.id, node]]),
      edges: [],
      duplicatePathNodeIds: new Set(),
    });
    const decoded = decodeGraph(encodeGraph(graph));
    expect(decoded.nodes.get(node.id)?.label).toBe(HOSTILE_MARKUP);
  });

  it("does not pollute Object.prototype on a __proto__/constructor-laden payload (T5/M83.3)", () => {
    const hostile =
      '{"runId":"r","appId":"a","appVersion":"1","platform":"ios",' +
      '"nodes":[{"id":"s","label":"L","platform":"ios","firstSeenAt":"t",' +
      '"a11ySnapshot":"{}","screenshotUri":null,' +
      '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}],' +
      '"edges":[],"duplicatePathNodeIds":[]}';
    const decoded = decodeGraph(hostile);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    // Rebuilt node carries the allow-listed fields ONLY — hostile keys dropped.
    const node = decoded.nodes.values().next().value;
    expect(Object.keys(node ?? {})).toEqual([
      "id",
      "label",
      "platform",
      "firstSeenAt",
      "a11ySnapshot",
      "screenshotUri",
    ]);
  });
});

describe("ReportCodec", () => {
  it("round-trips a full Report (all optional #56/#59 WorkflowMap fields) deep-equal", () => {
    const report = defaultReportFixtures.makeReport();
    expect(decodeReport(encodeReport(report))).toEqual(report);
  });

  it("round-trips a minimal WorkflowMap (optional fields ABSENT) without inventing keys", () => {
    const base = defaultReportFixtures.makeReport();
    const minimal = {
      ...base,
      workflowMap: {
        runId: base.workflowMap.runId,
        workflows: [],
        finalisedAt: base.workflowMap.finalisedAt,
      },
    };
    const decoded = decodeReport(encodeReport(minimal));
    expect(decoded).toEqual(minimal);
    expect(Object.keys(decoded.workflowMap)).toEqual(["runId", "workflows", "finalisedAt"]);
  });

  it("is byte-deterministic", () => {
    const report = defaultReportFixtures.makeReport();
    expect(encodeReport(report)).toBe(encodeReport(report));
  });

  it("passes the [REDACTED] marker and hostile markup through unchanged (T1/M83.5, T7/M83.8)", () => {
    const report = defaultReportFixtures.makeReport();
    const payload = encodeReport(report);
    expect(payload).toContain(REDACTED_MARKER);
    const decoded = decodeReport(payload);
    expect(decoded.workflowMap.workflows[0]?.name).toBe(report.workflowMap.workflows[0]?.name);
    expect(decoded.workflowMap.workflows[0]?.name).toContain(HOSTILE_MARKUP);
    expect(decoded.workflowMap.workflows[0]?.description).toContain(REDACTED_MARKER);
  });
});
