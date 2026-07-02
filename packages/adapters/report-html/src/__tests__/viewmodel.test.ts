/**
 * View-model derivation tests — grouping (FR3), step resolution (FR4),
 * the #88 annotation seam, and T6 truncation.
 */
import { describe, it, expect } from "vitest";
import {
  buildReportView,
  deriveAnnotations,
  groupByFeature,
  DEFAULT_MAX_STRING_LENGTH,
  UNGROUPED_LABEL,
  UNKNOWN_SCREEN_LABEL,
} from "../viewmodel.js";
import { DEFAULT_NODES, makeGraph, makeMap, makeReport, makeStep, makeWorkflow } from "./fixtures.js";
import { makeConfidenceScore } from "@flowscout/domain";

const graph = makeGraph(DEFAULT_NODES);
const limits = { maxStringLength: DEFAULT_MAX_STRING_LENGTH };

function view(workflows: ReturnType<typeof makeWorkflow>[], mapOverrides = {}) {
  const map = makeMap(workflows, mapOverrides);
  return buildReportView(makeReport(map), map, graph);
}

describe("groupByFeature (FR3)", () => {
  it("groups by featureGroup in first-seen order with Ungrouped always last", () => {
    const workflows = [
      makeWorkflow("wf-3", { featureGroup: "Checkout" }),
      makeWorkflow("wf-1", { featureGroup: undefined }),
      makeWorkflow("wf-2", { featureGroup: "Authentication" }),
      makeWorkflow("wf-4", { featureGroup: "Ungrouped" }),
    ];
    const groups = groupByFeature(workflows, limits, graph, deriveAnnotations(makeMap(workflows)));
    expect(groups.map((g) => g.name)).toEqual(["Checkout", "Authentication", UNGROUPED_LABEL]);
    // absent featureGroup and literal "Ungrouped" merge into one catch-all
    expect(groups[2]?.workflows.map((w) => w.id)).toEqual(["wf-1", "wf-4"]);
  });

  it("sorts workflows by id within a group (deterministic)", () => {
    const workflows = [
      makeWorkflow("wf-b", { featureGroup: "Checkout" }),
      makeWorkflow("wf-a", { featureGroup: "Checkout" }),
    ];
    const groups = groupByFeature(workflows, limits, graph, deriveAnnotations(makeMap(workflows)));
    expect(groups[0]?.workflows.map((w) => w.id)).toEqual(["wf-a", "wf-b"]);
  });

  it("marks groups with more than 15 workflows as collapsible", () => {
    const many = Array.from({ length: 16 }, (_, i) =>
      makeWorkflow(`wf-${String(i).padStart(2, "0")}`, { featureGroup: "Big" }),
    );
    const small = [makeWorkflow("wf-x", { featureGroup: "Small" })];
    const groups = groupByFeature(
      [...many, ...small],
      limits,
      graph,
      deriveAnnotations(makeMap([...many, ...small])),
    );
    expect(groups.find((g) => g.name === "Big")?.collapsible).toBe(true);
    expect(groups.find((g) => g.name === "Small")?.collapsible).toBe(false);
  });
});

describe("step resolution (FR4)", () => {
  it("orders steps by stepIndex and resolves screen labels from the graph", () => {
    const wf = makeWorkflow("wf-1", {
      steps: [
        makeStep(1, "state-b", { edge: null }),
        makeStep(0, "state-a"),
      ],
    });
    const [group] = view([wf]).groups;
    const steps = group?.workflows[0]?.steps ?? [];
    expect(steps.map((s) => s.index)).toEqual([0, 1]);
    expect(steps[0]?.screenLabel).toBe("Screen state-a");
    expect(steps[0]?.displayNumber).toBe(1);
  });

  it("renders a labelled placeholder for a stateId missing from the graph", () => {
    const wf = makeWorkflow("wf-1", { steps: [makeStep(0, "state-ghost", { edge: null })] });
    const steps = view([wf]).groups[0]?.workflows[0]?.steps ?? [];
    expect(steps[0]?.screenLabel).toBe(UNKNOWN_SCREEN_LABEL);
  });

  it("gives the terminal step (edge === null) no action", () => {
    const steps = view([makeWorkflow("wf-1")]).groups[0]?.workflows[0]?.steps ?? [];
    expect(steps[0]?.action).not.toBeNull();
    expect(steps[1]?.action).toBeNull();
  });

  it("opens screenshots by default only for workflows of 6 or fewer steps", () => {
    const short = makeWorkflow("wf-short");
    const long = makeWorkflow("wf-long", {
      steps: Array.from({ length: 7 }, (_, i) =>
        makeStep(i, "state-a", i === 6 ? { edge: null } : {}),
      ),
    });
    const workflows = view([short, long]).groups[0]?.workflows ?? [];
    expect(workflows.find((w) => w.id === "wf-short")?.screenshotsOpen).toBe(true);
    expect(workflows.find((w) => w.id === "wf-long")?.screenshotsOpen).toBe(false);
  });
});

describe("header view (FR2)", () => {
  it("exposes the purpose with a whole-number confidence percentage", () => {
    const v = view([], { appPurpose: "A ride app", appPurposeConfidence: makeConfidenceScore(0.824) });
    expect(v.header.purpose).toBe("A ride app");
    expect(v.header.confidencePct).toBe(82);
  });

  it("maps absent and 'Unknown' purpose to the null placeholder with no confidence", () => {
    expect(view([], { appPurpose: undefined, appPurposeConfidence: undefined }).header.purpose).toBeNull();
    const unknown = view([], { appPurpose: "Unknown", appPurposeConfidence: null }).header;
    expect(unknown.purpose).toBeNull();
    expect(unknown.confidencePct).toBeNull();
  });
});

describe("deriveAnnotations — the #88 seam (ADR-0009 §4)", () => {
  it("returns empty annotation slots for every workflow", () => {
    const map = makeMap([makeWorkflow("wf-1"), makeWorkflow("wf-2")]);
    const annotations = deriveAnnotations(map);
    expect(annotations.size).toBe(2);
    for (const slots of annotations.values()) {
      expect(slots.indexBadges).toEqual([]);
      expect(slots.detailBadges).toEqual([]);
      expect(slots.callouts).toEqual([]);
    }
  });

  it("is empty regardless of duplicateGroups being absent or []", () => {
    const absent = deriveAnnotations(makeMap([makeWorkflow("wf-1")]));
    const empty = deriveAnnotations(makeMap([makeWorkflow("wf-1")], { duplicateGroups: [] }));
    expect([...absent.values()]).toEqual([...empty.values()]);
  });
});

describe("T6 truncation (truncate-then-encode)", () => {
  it("caps every untrusted display string at the configured limit", () => {
    const long = "x".repeat(50);
    const wf = makeWorkflow("wf-1", {
      name: long,
      description: long,
      steps: [makeStep(0, "state-a", { description: long, edge: null })],
    });
    const map = makeMap([wf], { appPurpose: long });
    const v = buildReportView(makeReport(map), map, graph, { maxStringLength: 10 });
    expect(v.header.purpose).toBe("x".repeat(10) + "…");
    const workflow = v.groups[0]?.workflows[0];
    expect(workflow?.name).toBe("x".repeat(10) + "…");
    expect(workflow?.steps[0]?.description).toBe("x".repeat(10) + "…");
  });

  it("leaves strings at or below the limit untouched", () => {
    const map = makeMap([makeWorkflow("wf-1")]);
    const v = buildReportView(makeReport(map), map, graph, { maxStringLength: 4000 });
    expect(v.groups[0]?.workflows[0]?.name).toBe("Workflow wf-1");
  });
});
