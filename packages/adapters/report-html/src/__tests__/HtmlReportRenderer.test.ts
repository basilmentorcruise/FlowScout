/**
 * HtmlReportRenderer stub tests.
 * Verifies that render rejects with "not yet implemented" until E4 lands.
 */
import { describe, it, expect } from "vitest";
import { HtmlReportRenderer } from "../HtmlReportRenderer.js";
import type { Report, WorkflowMap, StateGraph } from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";

const fakeReport: Report = {
  metadata: {
    reportId: "report-1",
    runId: "run-1",
    appId: "app-1",
    appVersion: "1.0.0",
    generatedAt: "2026-06-20T00:01:00.000Z",
    runStatus: "completed",
    artifactUri: "file:///tmp/report.html",
    schemaVersion: "0.0.1",
  },
  workflowMap: {
    runId: "run-1",
    workflows: [],
    finalisedAt: "2026-06-20T00:01:00.000Z",
  },
  totalStates: 0,
  totalWorkflows: 0,
  duplicatePathCount: 0,
};

const fakeWorkflowMap: WorkflowMap = {
  runId: "run-1",
  workflows: [],
  finalisedAt: "2026-06-20T00:01:00.000Z",
};

const fakeGraph: StateGraph = {
  runId: "run-1",
  appId: "app-1",
  appVersion: "1.0.0",
  platform: "ios",
  nodes: new Map([
    [
      makeStateIdentity("state-1"),
      {
        id: makeStateIdentity("state-1"),
        label: "Home",
        platform: "ios",
        firstSeenAt: "2026-06-20T00:00:00.000Z",
        a11ySnapshot: "{}",
        screenshotUri: null,
      },
    ],
  ]),
  edges: [],
  duplicatePathNodeIds: new Set(),
};

describe("HtmlReportRenderer (stub)", () => {
  const renderer = new HtmlReportRenderer();

  it("render rejects with not-implemented error", async () => {
    await expect(
      renderer.render(fakeReport, fakeWorkflowMap, fakeGraph, {
        outputDir: "/tmp",
        embedScreenshots: false,
      }),
    ).rejects.toThrow("not yet implemented");
  });
});
