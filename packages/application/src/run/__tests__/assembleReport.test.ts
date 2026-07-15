/**
 * assembleReport — pure Report factory unit tests (#84 / E7.2, ADR-0008 §3).
 *
 * ACs covered:
 *   - Report = WorkflowMap + counts + run metadata (appId, appVersion, timestamp, status).
 *   - `artifactUri` is the documented "" sentinel (E4 fills the real URI later — OQ3).
 *   - Counts: totalStates = graph.nodes.size, totalWorkflows = workflowMap.workflows.length,
 *     duplicatePathCount = graph.duplicatePathNodeIds.size.
 *   - T7/M84.3: strings are persisted RAW and inert — no escaping/transform on write.
 */
import { describe, it, expect } from "vitest";
import type {
  Run,
  StateGraph,
  StateNode,
  StateIdentity,
  Workflow,
  WorkflowMap,
} from "@flowscout/domain";
import { makeStateIdentity, defaultCrawlBudget } from "@flowscout/domain";
import { assembleReport, REPORT_ID_PREFIX, REPORT_UNRENDERED_URI } from "../assembleReport.js";

const RUN_ID = "run-assemble-1";
const GENERATED_AT = "2026-07-07T10:00:00.000Z";

function makeRun(): Run {
  return {
    id: RUN_ID,
    appId: "com.example.demo",
    appVersion: "2.3.4",
    platform: "ios",
    budget: defaultCrawlBudget(),
    status: "running",
    startedAt: "2026-07-07T09:00:00.000Z",
    finishedAt: null,
    driverVersion: "driver-test",
    policyVersion: "policy-test",
    schemaVersion: "schema-test",
  };
}

function sid(raw: string): StateIdentity {
  return makeStateIdentity(raw);
}

function node(idRaw: string): StateNode {
  return {
    id: sid(idRaw),
    label: `state-${idRaw}`,
    platform: "ios",
    firstSeenAt: "2026-07-07T09:00:01.000Z",
    a11ySnapshot: JSON.stringify({ screen: idRaw }),
    screenshotUri: null,
  };
}

function makeGraph(): StateGraph {
  const nodes = [node("a"), node("b"), node("c")];
  return {
    runId: RUN_ID,
    appId: "com.example.demo",
    appVersion: "2.3.4",
    platform: "ios",
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: [],
    duplicatePathNodeIds: new Set([sid("b"), sid("c")]),
  };
}

function workflow(id: string, name: string): Workflow {
  return {
    id,
    name,
    description: `${name} description`,
    steps: [],
    isHiddenPath: false,
    inferenceConfidence: null,
    featureGroup: "Ungrouped",
  };
}

function makeWorkflowMap(workflows: readonly Workflow[]): WorkflowMap {
  return {
    runId: RUN_ID,
    finalisedAt: "2026-07-07T09:59:00.000Z",
    workflows,
    duplicateGroups: [],
  };
}

describe("assembleReport — pure Report factory (#84)", () => {
  it("assembles metadata from the run + supplied terminal status and timestamp", () => {
    const run = makeRun();
    const report = assembleReport({
      run,
      graph: makeGraph(),
      workflowMap: makeWorkflowMap([workflow("w1", "Sign in")]),
      runStatus: "completed",
      generatedAt: GENERATED_AT,
    });

    expect(report.metadata.reportId).toBe(`${REPORT_ID_PREFIX}${RUN_ID}`);
    expect(report.metadata.runId).toBe(RUN_ID);
    expect(report.metadata.appId).toBe(run.appId);
    expect(report.metadata.appVersion).toBe(run.appVersion);
    expect(report.metadata.generatedAt).toBe(GENERATED_AT);
    expect(report.metadata.runStatus).toBe("completed");
    expect(report.metadata.schemaVersion).toBe(run.schemaVersion);
  });

  it('writes the documented "" artifactUri sentinel — E4 fills the real URI (OQ3)', () => {
    const report = assembleReport({
      run: makeRun(),
      graph: makeGraph(),
      workflowMap: makeWorkflowMap([]),
      runStatus: "partial",
      generatedAt: GENERATED_AT,
    });
    expect(REPORT_UNRENDERED_URI).toBe("");
    expect(report.metadata.artifactUri).toBe(REPORT_UNRENDERED_URI);
  });

  it("derives the three counts from the graph and the workflow map (ADR-0008 §3)", () => {
    const report = assembleReport({
      run: makeRun(),
      graph: makeGraph(),
      workflowMap: makeWorkflowMap([workflow("w1", "Sign in"), workflow("w2", "Checkout")]),
      runStatus: "completed",
      generatedAt: GENERATED_AT,
    });
    expect(report.totalStates).toBe(3);
    expect(report.totalWorkflows).toBe(2);
    expect(report.duplicatePathCount).toBe(2);
  });

  it("tolerates a missing graph (null) with zero graph-derived counts", () => {
    const report = assembleReport({
      run: makeRun(),
      graph: null,
      workflowMap: makeWorkflowMap([workflow("w1", "Sign in")]),
      runStatus: "partial",
      generatedAt: GENERATED_AT,
    });
    expect(report.totalStates).toBe(0);
    expect(report.duplicatePathCount).toBe(0);
    expect(report.totalWorkflows).toBe(1);
  });

  it("keeps WorkflowMap strings RAW and inert — same reference, no escaping (T7/M84.3)", () => {
    const markupName = ["<b>", "Sign in", "</b>", "<script>x</script>"].join("");
    const map = makeWorkflowMap([workflow("w1", markupName)]);
    const report = assembleReport({
      run: makeRun(),
      graph: makeGraph(),
      workflowMap: map,
      runStatus: "completed",
      generatedAt: GENERATED_AT,
    });
    // No copy, no transform: byte-equal raw strings — E4 context-encodes on render.
    expect(report.workflowMap).toBe(map);
    expect(report.workflowMap.workflows[0]?.name).toBe(markupName);
  });
});
