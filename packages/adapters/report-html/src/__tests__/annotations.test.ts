/**
 * #88 — hidden/duplicate-path visualization tests (E4.2).
 *
 * Covers the acceptance criteria of issue #88 over deriveAnnotations + the badge and
 * convergence partials, the design-spec copy/structure (§3/§5/§9), determinism (AC 6)
 * and the WCAG 1.4.3 contrast verification the design spec §3/§8 mandates at build time.
 */
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import type { DuplicatePathGroup, StateGraph, WorkflowMap } from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";
import { deriveAnnotations, EMPTY_ANNOTATIONS, UNKNOWN_SCREEN_LABEL } from "../annotations.js";
import { renderHiddenBadgeDetail, renderHiddenBadgeIndex } from "../sections/badge.js";
import { renderConvergenceCallout } from "../sections/convergence.js";
import { renderDocument } from "../document.js";
import { buildReportView, DEFAULT_MAX_STRING_LENGTH } from "../viewmodel.js";
import { REPORT_STYLESHEET } from "../assets/styles.js";
import {
  DEFAULT_NODES,
  makeGraph,
  makeMap,
  makeNode,
  makeReport,
  makeWorkflow,
} from "./fixtures.js";

const limits = { maxStringLength: DEFAULT_MAX_STRING_LENGTH };

/** The sample convergence outcome node all group fixtures point at. */
const OUTCOME_NODE = makeNode("state-confirm", { label: "Order confirmed" });
const GRAPH = makeGraph([...DEFAULT_NODES, OUTCOME_NODE]);

function makeGroup(overrides: Partial<DuplicatePathGroup> = {}): DuplicatePathGroup {
  return {
    outcomeIdentity: makeStateIdentity("state-confirm"),
    workflowIds: ["hidden", "main"],
    canonicalWorkflowId: "main",
    hiddenWorkflowIds: ["hidden"],
    ...overrides,
  };
}

/** Map with a canonical route, a hidden converging route, and an unrelated workflow. */
function makeConvergingMap(overrides: Partial<WorkflowMap> = {}): WorkflowMap {
  return makeMap(
    [
      makeWorkflow("main", { name: "Buy via search", featureGroup: "Shopping" }),
      makeWorkflow("hidden", {
        name: "Buy via promo tile",
        featureGroup: "Shopping",
        isHiddenPath: true,
      }),
      makeWorkflow("other", { name: "View profile", featureGroup: "Account" }),
    ],
    { duplicateGroups: [makeGroup()], ...overrides },
  );
}

function renderMarkup(map: WorkflowMap, graph: StateGraph = GRAPH): string {
  const report = makeReport(map);
  return renderDocument(buildReportView(report, map, graph), {
    title: "t",
    renderedAt: "2026-07-15T12:00:00.000Z",
    screenshotSrcByUri: new Map(),
  }).value;
}

function parse(markup: string): Document {
  const window = new Window();
  window.document.write(markup);
  return window.document as unknown as Document;
}

describe("deriveAnnotations — hidden-path badge (AC 1)", () => {
  it("emits index + detail badges only for isHiddenPath workflows", () => {
    const annotations = deriveAnnotations(makeConvergingMap(), GRAPH, limits);
    const hidden = annotations.get("hidden");
    expect(hidden?.indexBadges).toHaveLength(1);
    expect(hidden?.detailBadges).toHaveLength(1);
    const plain = annotations.get("other");
    expect(plain?.indexBadges).toHaveLength(0);
    expect(plain?.detailBadges).toHaveLength(0);
  });

  it("badges the workflow in BOTH the TOC index and its detail header in the document", () => {
    const doc = parse(renderMarkup(makeConvergingMap()));
    const tocBadges = doc.querySelectorAll(".fs-toc .fs-badge-hidden");
    expect(tocBadges.length).toBe(1);
    expect(tocBadges[0]?.closest("li")?.querySelector("a")?.textContent).toContain(
      "Buy via promo tile",
    );
    const headerBadge = doc.querySelector("article#wf-hidden .fs-workflow-header .fs-badge-hidden");
    expect(headerBadge).not.toBeNull();
    expect(headerBadge?.textContent).toContain("Hidden path");
  });

  it("uses a non-color signifier: icon + exact 'Hidden path' label/aria-label (spec §3/§9)", () => {
    const detail = renderHiddenBadgeDetail().value;
    expect(detail).toContain('aria-label="Hidden path"');
    expect(detail).toContain("Hidden path");
    expect(detail).toContain('class="fs-icon"');
    expect(detail).toContain('aria-hidden="true"');
    const index = renderHiddenBadgeIndex().value;
    expect(index).toContain('aria-label="Hidden path"');
    expect(index).toContain('class="fs-icon"');
  });
});

describe("deriveAnnotations — convergence callout (AC 2/AC 3)", () => {
  it("renders the callout on EVERY converging workflow, not just the hidden one", () => {
    const doc = parse(renderMarkup(makeConvergingMap()));
    expect(doc.querySelectorAll("article#wf-main aside.fs-duplicate-callout").length).toBe(1);
    expect(doc.querySelectorAll("article#wf-hidden aside.fs-duplicate-callout").length).toBe(1);
    expect(doc.querySelectorAll("article#wf-other aside.fs-duplicate-callout").length).toBe(0);
  });

  it("states 'N distinct paths reach the same outcome' with the resolved outcome label", () => {
    const doc = parse(renderMarkup(makeConvergingMap()));
    const title = doc.querySelector("#wf-main .fs-duplicate-title");
    expect(title?.textContent).toContain("2 distinct paths reach the same outcome");
    const outcome = doc.querySelector("#wf-main .fs-duplicate-outcome");
    expect(outcome?.textContent.trim()).toBe("Outcome: Order confirmed");
  });

  it("distinguishes canonical vs hidden routes with exact chips, canonical pinned first", () => {
    const doc = parse(renderMarkup(makeConvergingMap()));
    const routes = Array.from(doc.querySelectorAll("#wf-hidden .fs-duplicate-routes > li"));
    expect(routes.length).toBe(2);
    expect(routes[0]?.classList.contains("fs-route-canonical")).toBe(true);
    expect(routes[0]?.querySelector(".fs-chip")?.textContent).toBe("Canonical route");
    expect(routes[1]?.classList.contains("fs-route-hidden")).toBe(true);
    expect(routes[1]?.querySelector(".fs-chip")?.textContent).toBe("Hidden route");
  });

  it("labels a third+ route (neither canonical nor hidden) as 'Alternate route' (spec §5.2)", () => {
    const map = makeMap(
      [
        makeWorkflow("main", { name: "Canonical" }),
        makeWorkflow("hidden", { name: "Hidden", isHiddenPath: true }),
        makeWorkflow("alt", { name: "Alternate" }),
      ],
      {
        duplicateGroups: [makeGroup({ workflowIds: ["alt", "hidden", "main"] })],
      },
    );
    const doc = parse(renderMarkup(map));
    const chips = Array.from(
      doc.querySelectorAll("#wf-main .fs-duplicate-routes .fs-chip"),
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(["Canonical route", "Alternate route", "Hidden route"]);
    expect(doc.querySelector("#wf-main .fs-duplicate-title")?.textContent).toContain(
      "3 distinct paths",
    );
  });

  it("jump-links every route to an anchor that exists in the same document", () => {
    const doc = parse(renderMarkup(makeConvergingMap()));
    const links = Array.from(doc.querySelectorAll(".fs-duplicate-routes a"));
    expect(links.length).toBe(4); // 2 routes × 2 converging articles
    for (const link of links) {
      const href = link.getAttribute("href") ?? "";
      expect(href).toMatch(/^#[A-Za-z0-9_-]+$/);
      expect(doc.getElementById(href.slice(1))).not.toBeNull();
    }
  });
});

describe("deriveAnnotations — convergence callout details + resilience (AC 3/NFR4/T6)", () => {
  it("marks only the current workflow's own route with '(this workflow)'", () => {
    const doc = parse(renderMarkup(makeConvergingMap()));
    const markers = Array.from(doc.querySelectorAll("#wf-main .fs-you-are-here"));
    expect(markers.length).toBe(1);
    expect(markers[0]?.textContent).toBe("(this workflow)");
    expect(markers[0]?.closest("li")?.classList.contains("fs-route-canonical")).toBe(true);
    const hiddenMarker = doc.querySelector("#wf-hidden .fs-you-are-here");
    expect(hiddenMarker?.closest("li")?.classList.contains("fs-route-hidden")).toBe(true);
  });

  it("co-fires badge AND callout on a hidden converging workflow — never deduplicated (spec §5.2)", () => {
    const doc = parse(renderMarkup(makeConvergingMap()));
    const article = doc.querySelector("article#wf-hidden");
    expect(article?.querySelector(".fs-workflow-header .fs-badge-hidden")).not.toBeNull();
    expect(article?.querySelector("aside.fs-duplicate-callout")).not.toBeNull();
  });

  it("gives a group member with isHiddenPath:false a callout but no badge (orthogonality)", () => {
    const annotations = deriveAnnotations(makeConvergingMap(), GRAPH, limits);
    const canonical = annotations.get("main");
    expect(canonical?.callouts).toHaveLength(1);
    expect(canonical?.detailBadges).toHaveLength(0);
    expect(canonical?.indexBadges).toHaveLength(0);
  });

  it("falls back to 'Unknown screen' when the outcomeIdentity is missing from the graph (NFR4)", () => {
    const map = makeConvergingMap({
      duplicateGroups: [makeGroup({ outcomeIdentity: makeStateIdentity("state-ghost") })],
    });
    const doc = parse(renderMarkup(map));
    expect(doc.querySelector("#wf-main .fs-duplicate-outcome")?.textContent.trim()).toBe(
      `Outcome: ${UNKNOWN_SCREEN_LABEL}`,
    );
  });

  it("renders a route whose workflow is missing from the map as inert text (NFR4, no crash)", () => {
    const map = makeConvergingMap({
      duplicateGroups: [makeGroup({ workflowIds: ["ghost", "hidden", "main"] })],
    });
    const doc = parse(renderMarkup(map));
    const links = Array.from(doc.querySelectorAll("#wf-main .fs-duplicate-routes a"));
    expect(links.map((a) => a.textContent)).toEqual([
      "Buy via search",
      "ghost",
      "Buy via promo tile",
    ]);
  });

  it("length-caps untrusted route names and outcome labels (T6)", () => {
    const long = "n".repeat(80);
    const map = makeMap(
      [
        makeWorkflow("main", { name: long }),
        makeWorkflow("hidden", { name: long, isHiddenPath: true }),
      ],
      { duplicateGroups: [makeGroup()] },
    );
    const graph = makeGraph([makeNode("state-confirm", { label: long })]);
    const annotations = deriveAnnotations(map, graph, { maxStringLength: 10 });
    const markup = annotations.get("main")?.callouts[0]?.value ?? "";
    expect(markup).toContain("n".repeat(10) + "…");
    expect(markup).not.toContain("n".repeat(11));
  });
});

describe("duplicateGroups absent or empty (AC 4)", () => {
  it("derives the shared EMPTY annotations for a pre-#59 map and for []", () => {
    const workflows = [makeWorkflow("wf-1"), makeWorkflow("wf-2")];
    const absent = deriveAnnotations(makeMap(workflows), GRAPH, limits);
    const empty = deriveAnnotations(makeMap(workflows, { duplicateGroups: [] }), GRAPH, limits);
    for (const derived of [absent, empty]) {
      expect(derived.size).toBe(2);
      for (const slots of derived.values()) {
        expect(slots).toBe(EMPTY_ANNOTATIONS);
      }
    }
  });

  it("renders byte-identical documents for absent vs [] groups, with zero badges/callouts", () => {
    const workflows = [makeWorkflow("wf-1"), makeWorkflow("wf-2")];
    const absentMarkup = renderMarkup(makeMap(workflows));
    const emptyMarkup = renderMarkup(makeMap(workflows, { duplicateGroups: [] }));
    expect(absentMarkup).toBe(emptyMarkup);
    const doc = parse(absentMarkup);
    expect(doc.querySelectorAll(".fs-duplicate-callout, .fs-badge-hidden").length).toBe(0);
  });
});

describe("determinism (AC 6 / NFR3)", () => {
  it("renders byte-identical output for the same converging inputs twice", () => {
    expect(renderMarkup(makeConvergingMap())).toBe(renderMarkup(makeConvergingMap()));
  });

  it("keeps callouts in first-seen duplicateGroups order on a shared workflow", () => {
    const map = makeMap(
      [
        makeWorkflow("main", { name: "Main" }),
        makeWorkflow("wf-b", { name: "B" }),
        makeWorkflow("wf-a", { name: "A" }),
      ],
      {
        duplicateGroups: [
          makeGroup({ workflowIds: ["wf-b", "main"], hiddenWorkflowIds: ["wf-b"] }),
          makeGroup({
            outcomeIdentity: makeStateIdentity("state-a"),
            workflowIds: ["wf-a", "main"],
            hiddenWorkflowIds: ["wf-a"],
          }),
        ],
      },
    );
    const annotations = deriveAnnotations(map, GRAPH, limits);
    const callouts = annotations.get("main")?.callouts ?? [];
    expect(callouts).toHaveLength(2);
    expect(callouts[0]?.value).toContain("Order confirmed");
    expect(callouts[1]?.value).toContain("Screen state-a");
  });
});

describe("convergence partial markup (design spec §5.2)", () => {
  it("emits the exact aside structure with aria-label and the merge icon", () => {
    const markup = renderConvergenceCallout({
      pathCount: 2,
      outcomeLabel: "Order confirmed",
      routes: [
        { anchorId: "wf-a", name: "A", role: "canonical", isCurrent: true },
        { anchorId: "wf-b", name: "B", role: "hidden", isCurrent: false },
      ],
    }).value;
    expect(markup).toContain(
      '<aside class="fs-duplicate-callout" aria-label="Duplicate path group">',
    );
    expect(markup).toContain("<strong>2 distinct paths reach the same outcome</strong>");
    expect(markup).toContain('class="fs-icon"');
    expect(markup).toContain('href="#wf-a"');
    expect(markup).toContain('href="#wf-b"');
  });

  it("entity-encodes hostile route names and outcome labels (T7 in added markup)", () => {
    const hostile = "<script>alert(1)</script>";
    const markup = renderConvergenceCallout({
      pathCount: 2,
      outcomeLabel: hostile,
      routes: [{ anchorId: "wf-a", name: hostile, role: "canonical", isCurrent: false }],
    }).value;
    expect(markup).not.toContain(hostile);
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("WCAG 1.4.3 contrast verification of the semantic token pairs (spec §3/§6/§8)", () => {
  const WCAG_AA_NORMAL_TEXT = 4.5;
  const SRGB_LINEAR_CUTOFF = 0.04045;

  function token(name: string): string {
    const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(REPORT_STYLESHEET);
    if (!match?.[1]) {
      throw new Error(`token ${name} not found in stylesheet`);
    }
    return match[1];
  }

  function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5]
      .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((channel) =>
        channel <= SRGB_LINEAR_CUTOFF ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  }

  function contrast(fg: string, bg: string): number {
    const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
  }

  it.each([
    ["--fs-color-hidden-fg", "--fs-color-hidden-bg"],
    ["--fs-color-duplicate-fg", "--fs-color-duplicate-bg"],
    ["--fs-color-canonical-fg", "--fs-color-canonical-bg"],
  ])("%s on %s meets 4.5:1", (fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });
});
