/**
 * PersistenceAdapters stub tests.
 * Verifies that all repository methods reject with "not yet implemented" until E4/E5 lands.
 */
import { describe, it, expect } from "vitest";
import {
  PrismaRunRepository,
  PrismaStateGraphRepository,
  PrismaReportRepository,
} from "../PersistenceAdapters.js";
import type { Run, StateGraph, StateNode, StateEdge, Report } from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";

const stateId1 = makeStateIdentity("state-1");
const stateId2 = makeStateIdentity("state-2");

const fakeRun: Run = {
  id: "run-1",
  appId: "app-1",
  appVersion: "1.0.0",
  platform: "ios",
  budget: { maxSteps: 100, maxLlmCalls: 50, maxTokens: 10000, maxRevisitsPerState: 3, plateauWindow: 40, plateauWarnRatio: 0.75 },
  status: "completed",
  startedAt: "2026-06-20T00:00:00.000Z",
  finishedAt: null,
  driverVersion: "0.0.1",
  policyVersion: "0.0.1",
  schemaVersion: "0.0.1",
};

const fakeNode: StateNode = {
  id: stateId1,
  label: "Home",
  platform: "ios",
  firstSeenAt: "2026-06-20T00:00:00.000Z",
  a11ySnapshot: '{"role":"application"}',
  screenshotUri: null,
};

const fakeEdge: StateEdge = {
  id: "edge-1",
  fromId: stateId1,
  toId: stateId2,
  actionType: "tap",
  actionPayload: "{}",
  observedAt: "2026-06-20T00:00:01.000Z",
};

const fakeGraph: StateGraph = {
  runId: "run-1",
  appId: "app-1",
  appVersion: "1.0.0",
  platform: "ios",
  nodes: new Map([[stateId1, fakeNode]]),
  edges: [fakeEdge],
  duplicatePathNodeIds: new Set(),
};

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
  totalStates: 1,
  totalWorkflows: 0,
  duplicatePathCount: 0,
};

describe("PrismaRunRepository (stub)", () => {
  const repo = new PrismaRunRepository();

  it("save rejects with not-implemented error", async () => {
    await expect(repo.save(fakeRun)).rejects.toThrow("not yet implemented");
  });

  it("findById rejects with not-implemented error", async () => {
    await expect(repo.findById("run-1")).rejects.toThrow("not yet implemented");
  });

  it("findByAppId rejects with not-implemented error", async () => {
    await expect(repo.findByAppId("app-1")).rejects.toThrow("not yet implemented");
  });

  it("update rejects with not-implemented error", async () => {
    await expect(repo.update("run-1", { status: "completed" })).rejects.toThrow(
      "not yet implemented",
    );
  });
});

describe("PrismaStateGraphRepository (stub)", () => {
  const repo = new PrismaStateGraphRepository();

  it("saveGraph rejects with not-implemented error", async () => {
    await expect(repo.saveGraph(fakeGraph)).rejects.toThrow("not yet implemented");
  });

  it("upsertNode rejects with not-implemented error", async () => {
    await expect(repo.upsertNode("run-1", fakeNode)).rejects.toThrow("not yet implemented");
  });

  it("appendEdge rejects with not-implemented error", async () => {
    await expect(repo.appendEdge("run-1", fakeEdge)).rejects.toThrow("not yet implemented");
  });

  it("findByRunId rejects with not-implemented error", async () => {
    await expect(repo.findByRunId("run-1")).rejects.toThrow("not yet implemented");
  });

  it("findStatesByApp rejects with not-implemented error", async () => {
    await expect(repo.findStatesByApp("app-1")).rejects.toThrow("not yet implemented");
  });
});

describe("PrismaReportRepository (stub)", () => {
  const repo = new PrismaReportRepository();

  it("save rejects with not-implemented error", async () => {
    await expect(repo.save(fakeReport)).rejects.toThrow("not yet implemented");
  });

  it("findById rejects with not-implemented error", async () => {
    await expect(repo.findById("report-1")).rejects.toThrow("not yet implemented");
  });

  it("findByRunId rejects with not-implemented error", async () => {
    await expect(repo.findByRunId("run-1")).rejects.toThrow("not yet implemented");
  });

  it("findByAppId rejects with not-implemented error", async () => {
    await expect(repo.findByAppId("app-1")).rejects.toThrow("not yet implemented");
  });
});
