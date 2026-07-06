/**
 * Sanity tests for the conformance-suite fixtures themselves
 * (the contract sections are exercised by the consuming packages).
 */
import { describe, it, expect } from "vitest";
import {
  defaultRunFixtures,
  defaultGraphFixtures,
  defaultReportFixtures,
  REDACTED_MARKER,
  HOSTILE_MARKUP,
} from "../fixtures.js";

describe("persistence fixtures", () => {
  it("makeRun applies overrides on top of a valid base run", () => {
    const run = defaultRunFixtures.makeRun({ id: "custom", status: "completed" });
    expect(run.id).toBe("custom");
    expect(run.status).toBe("completed");
    expect(run.budget.maxSteps).toBeGreaterThan(0);
  });

  it("makeGraph produces nodes carrying the redaction marker and hostile markup (T1/T7 seeds)", () => {
    const graph = defaultGraphFixtures.makeGraph();
    const labels = [...graph.nodes.values()].map((n) => n.label).join(" ");
    expect(labels).toContain(REDACTED_MARKER);
    expect(labels).toContain(HOSTILE_MARKUP);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.duplicatePathNodeIds.size).toBeGreaterThan(0);
  });

  it("makeLargeGraph produces the requested node count with multi-KB a11y blobs (NFR5)", () => {
    const nodeCount = 250;
    const minBlobBytes = 2000;
    const graph = defaultGraphFixtures.makeLargeGraph("run-x", nodeCount);
    expect(graph.nodes.size).toBe(nodeCount);
    expect(graph.edges).toHaveLength(nodeCount - 1);
    const first = [...graph.nodes.values()][0];
    expect(first?.a11ySnapshot.length).toBeGreaterThan(minBlobBytes);
  });

  it("makeReport exercises every optional WorkflowMap field with a not-yet-rendered artifactUri", () => {
    const report = defaultReportFixtures.makeReport();
    expect(report.metadata.artifactUri).toBe("");
    expect(report.workflowMap.appPurpose).toBeDefined();
    expect(report.workflowMap.appPurposeConfidence).toBeDefined();
    expect(report.workflowMap.duplicateGroups).toBeDefined();
    expect(report.workflowMap.workflows[0]?.featureGroup).toBeDefined();
  });
});
