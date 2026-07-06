/**
 * Document assembly tests — design-spec structure (header/TOC/sections/steps),
 * edge-case states (§7), WCAG assertions (§8), self-containment (M87.5) and the
 * document-level T7-xss-payload-suite (M87.2).
 */
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import { renderDocument, META_CSP } from "../document.js";
import { buildReportView } from "../viewmodel.js";
import { PURPOSE_PLACEHOLDER } from "../sections/header.js";
import { EMPTY_MAP_MESSAGE } from "../sections/toc.js";
import { NO_SCREENSHOT_MESSAGE } from "../sections/screenshot.js";
import type { Report, StateGraph, WorkflowMap } from "@flowscout/domain";
import { makeConfidenceScore } from "@flowscout/domain";
import {
  DEFAULT_NODES,
  makeEdge,
  makeGraph,
  makeMap,
  makeNode,
  makeReport,
  makeStep,
  makeWorkflow,
} from "./fixtures.js";
import { XSS_PAYLOADS } from "./xssPayloads.js";

const NO_SCREENSHOTS: ReadonlyMap<string, string | null> = new Map();

function renderDoc(
  map: WorkflowMap,
  graph: StateGraph = makeGraph(DEFAULT_NODES),
  report: Report = makeReport(map),
  screenshotSrcByUri: ReadonlyMap<string, string | null> = NO_SCREENSHOTS,
): string {
  const view = buildReportView(report, map, graph);
  return renderDocument(view, {
    title: `FlowScout report — ${report.metadata.appId}`,
    renderedAt: "2026-07-02T12:00:00.000Z",
    screenshotSrcByUri,
  }).value;
}

function parse(markup: string): Document {
  const window = new Window();
  window.document.write(markup);
  return window.document as unknown as Document;
}

describe("document structure (design spec §1/§2/§3/§4)", () => {
  const map = makeMap([
    makeWorkflow("wf-login", { name: "Sign in", featureGroup: "Authentication" }),
    makeWorkflow("wf-cart", { name: "Add to cart", featureGroup: "Cart" }),
  ]);
  const doc = parse(renderDoc(map));

  it("renders the app purpose prominently with the appId as h1", () => {
    expect(doc.querySelectorAll("h1").length).toBe(1);
    expect(doc.querySelector("h1.fs-app-name")?.textContent).toBe("com.example.app");
    expect(doc.querySelector(".fs-purpose")?.textContent).toContain("A sample shopping app");
  });

  it("renders one landmark each: header, nav, main, footer (WCAG §8)", () => {
    expect(doc.querySelectorAll("header#top").length).toBe(1);
    expect(doc.querySelectorAll('nav[aria-label="Workflow index"]').length).toBe(1);
    expect(doc.querySelectorAll("main#main-content").length).toBe(1);
    expect(doc.querySelectorAll("body > footer").length).toBe(1);
  });

  it("renders a skip link targeting the main landmark", () => {
    const skip = doc.querySelector("a.fs-skip-link");
    expect(skip?.getAttribute("href")).toBe("#main-content");
    expect(skip?.textContent).toBe("Skip to workflows");
  });

  it("every TOC href resolves to an article id in the same document (FR3)", () => {
    const links = Array.from(doc.querySelectorAll(".fs-toc a"));
    expect(links.length).toBe(2);
    for (const link of links) {
      const target = link.getAttribute("href") ?? "";
      expect(target.startsWith("#")).toBe(true);
      expect(doc.querySelector(`article[id="${target.slice(1)}"]`)).not.toBeNull();
    }
  });

  it("groups workflows under feature-group sections with h2 → h3 hierarchy (no skips)", () => {
    const sections = Array.from(doc.querySelectorAll("main section.fs-group"));
    expect(sections.map((s) => s.getAttribute("data-group"))).toEqual(["Authentication", "Cart"]);
    for (const section of sections) {
      expect(section.querySelector("h2")).not.toBeNull();
      expect(section.querySelector("article h3")).not.toBeNull();
      expect(section.querySelector("h4, h5, h6")).toBeNull();
    }
  });

  it("renders steps in order with screen label, description and action; terminal step has no action", () => {
    const article = doc.querySelector('article[aria-labelledby$="-title"]');
    const steps = Array.from(article?.querySelectorAll("ol.fs-steps > li.fs-step") ?? []);
    expect(steps.length).toBe(2);
    expect(steps[0]?.querySelector(".fs-step-screen")?.textContent).toBe("Screen state-a");
    expect(steps[0]?.querySelector(".fs-step-action .fs-chip-action")?.textContent).toBe("tap");
    expect(steps[0]?.querySelector("code.fs-step-payload")?.textContent).toBe('{"x":10,"y":20}');
    expect(steps[1]?.querySelector(".fs-step-action")).toBeNull();
  });

  it("steps without screenshots render the text-only placeholder and no <img>", () => {
    expect(doc.querySelectorAll("img").length).toBe(0);
    expect(doc.querySelector(".fs-step-noshot")?.textContent).toBe(NO_SCREENSHOT_MESSAGE);
  });

  it("ships the restrictive meta CSP (M87.5 SHOULD)", () => {
    const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(meta?.getAttribute("content")).toBe(META_CSP);
  });
});

describe("screenshots (FR5)", () => {
  const shotUri = "shots/state-a.png";
  const map = makeMap([makeWorkflow("wf-1")]);
  const graph = makeGraph([makeNode("state-a", { screenshotUri: shotUri }), makeNode("state-b")]);
  const dataSrc = "data:image/png;base64,iVBORw0KGgo=";

  it("embeds a resolved screenshot with a descriptive alt inside <details open>", () => {
    const doc = parse(renderDoc(map, graph, makeReport(map), new Map([[shotUri, dataSrc]])));
    const img = doc.querySelector("img.fs-screenshot");
    expect(img?.getAttribute("src")).toBe(dataSrc);
    expect(img?.getAttribute("alt")).toBe("Screen: Screen state-a — step 1 of Workflow wf-1");
    expect(img?.closest("details")?.hasAttribute("open")).toBe(true);
  });

  it("collapses screenshots by default for workflows with more than 6 steps", () => {
    const longMap = makeMap([
      makeWorkflow("wf-1", {
        steps: Array.from({ length: 7 }, (_, i) =>
          makeStep(i, "state-a", i === 6 ? { edge: null } : {}),
        ),
      }),
    ]);
    const doc = parse(
      renderDoc(longMap, graph, makeReport(longMap), new Map([[shotUri, dataSrc]])),
    );
    const img = doc.querySelector("img.fs-screenshot");
    expect(img?.closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("degrades to the placeholder when the resolver returned null (hostile/unreadable uri)", () => {
    const doc = parse(renderDoc(map, graph, makeReport(map), new Map([[shotUri, null]])));
    expect(doc.querySelectorAll("img").length).toBe(0);
    expect(doc.querySelector(".fs-step-noshot")?.textContent).toBe(NO_SCREENSHOT_MESSAGE);
  });
});

describe("edge-case states (design spec §7)", () => {
  it("renders the neutral placeholder for an absent or Unknown appPurpose", () => {
    for (const purpose of [undefined, "Unknown"]) {
      const map = makeMap([makeWorkflow("wf-1")], {
        appPurpose: purpose,
        appPurposeConfidence: purpose === undefined ? undefined : null,
      });
      const doc = parse(renderDoc(map));
      const purposeEl = doc.querySelector(".fs-purpose");
      expect(purposeEl).not.toBeNull();
      expect(String(purposeEl?.textContent).trim()).toBe(PURPOSE_PLACEHOLDER);
      expect(doc.querySelector(".fs-confidence")).toBeNull();
    }
  });

  it("shows the confidence chip when a confidence accompanies the purpose", () => {
    const map = makeMap([], { appPurposeConfidence: makeConfidenceScore(0.82) });
    const doc = parse(renderDoc(map));
    expect(doc.querySelector(".fs-confidence")?.textContent).toContain("82% confidence");
  });

  it("renders a valid 'nothing discovered' document for an empty map and empty graph", () => {
    const map = makeMap([]);
    const doc = parse(renderDoc(map, makeGraph([])));
    expect(doc.querySelector(".fs-toc .fs-empty")?.textContent).toBe(EMPTY_MAP_MESSAGE);
    expect(doc.querySelectorAll("main article").length).toBe(0);
    expect(doc.querySelector("h1")).not.toBeNull();
  });

  it.each([
    ["partial", "Partial (budget/step cap reached)"],
    ["running", "Running (exploration in progress)"],
  ] as const)(
    "labels a %s run with a visible status badge (non-color signifier = text)",
    (runStatus, copy) => {
      const map = makeMap([]);
      const base = makeReport(map, {});
      const report = { ...base, metadata: { ...base.metadata, runStatus } };
      const doc = parse(renderDoc(map, makeGraph([]), report));
      const badge = doc.querySelector(".fs-status-warn");
      expect(badge?.textContent).toBe(copy);
    },
  );
});

describe("edge-case states — scale, clamping, determinism (design spec §7)", () => {
  it("collapsible TOC groups (100+ workflows) render as <details open> — nothing hidden by default", () => {
    const many = Array.from({ length: 101 }, (_, i) =>
      makeWorkflow(`wf-${String(i).padStart(3, "0")}`, { featureGroup: "Everything" }),
    );
    const doc = parse(renderDoc(makeMap(many)));
    const details = doc.querySelector("details.fs-toc-group");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(true);
    expect(doc.querySelectorAll(".fs-toc a").length).toBe(101);
  });

  it("clamps >140-char labels via CSS class + title attribute, keeping full text content", () => {
    const long = "L".repeat(150);
    const map = makeMap([
      makeWorkflow("wf-1", { steps: [makeStep(0, "state-a", { description: long, edge: null })] }),
    ]);
    const doc = parse(renderDoc(map));
    const desc = doc.querySelector(".fs-step-desc");
    expect(desc?.classList.contains("fs-clamp")).toBe(true);
    expect(desc?.getAttribute("title")).toBe(long);
    expect(desc?.textContent).toBe(long);
  });

  it("is deterministic — identical output for identical inputs", () => {
    const map = makeMap([makeWorkflow("wf-1"), makeWorkflow("wf-2", { featureGroup: undefined })]);
    expect(renderDoc(map)).toBe(renderDoc(map));
  });
});

describe("self-containment (M87.5 / NFR2)", () => {
  it("contains zero remote resource references and zero <script> tags", () => {
    const map = makeMap([makeWorkflow("wf-1")]);
    const markup = renderDoc(map);
    expect(markup).not.toMatch(/<script/i);
    expect(markup).not.toMatch(/@import/i);
    const remoteRefs = [
      'src="http',
      "src='http",
      'src="//',
      'href="http',
      "href='http",
      'href="//',
      "url(http",
      "url(//",
      'url("http',
      "url('http",
    ];
    for (const needle of remoteRefs) {
      expect(markup.toLowerCase()).not.toContain(needle);
    }
  });
});

/** Build inputs where EVERY untrusted field carries the payload (incl. actionPayload). */
function makeHostileInputs(payload: string): { map: WorkflowMap; graph: StateGraph } {
  const hostileWorkflow = makeWorkflow("wf-1", {
    name: payload,
    description: payload,
    featureGroup: payload,
    steps: [
      makeStep(0, "state-evil", {
        description: payload,
        // actionType is a domain union (compile-time constrained); the free-text payload is hostile.
        edge: makeEdge("state-evil", "state-next", { actionPayload: payload }),
      }),
      makeStep(1, "state-evil", { description: payload, edge: null }),
    ],
  });
  const map = makeMap([hostileWorkflow], { appPurpose: payload });
  const graph = makeGraph([makeNode("state-evil", { label: payload, screenshotUri: payload })]);
  return { map, graph };
}

/** M87.2 core assertion: the parsed output DOM carries zero active markup. */
function expectInertDom(doc: Document): void {
  expect(doc.querySelectorAll("script, iframe, object, embed, svg").length).toBe(0);
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.startsWith("on")).toBe(false);
    }
  }
  for (const el of Array.from(doc.querySelectorAll("[src], [href]"))) {
    const url = (el.getAttribute("src") ?? el.getAttribute("href") ?? "").toLowerCase();
    expect(url.startsWith("javascript:")).toBe(false);
    expect(url.startsWith("data:text")).toBe(false);
  }
}

describe("T7-xss-payload-suite — document level (M87.2)", () => {
  it.each(XSS_PAYLOADS.map((p) => [p.id, p.value] as const))(
    "payload %s injected into every untrusted field renders inert",
    (_id, payload) => {
      const { map, graph } = makeHostileInputs(payload);
      const doc = parse(renderDoc(map, graph, makeReport(map)));

      expectInertDom(doc);
      // The payload is preserved as inert visible text in the workflow title.
      const title = doc.querySelector("article h3");
      expect(title?.textContent).toBe(payload.replaceAll("\u0000", "\uFFFD"));
    },
  );
});
