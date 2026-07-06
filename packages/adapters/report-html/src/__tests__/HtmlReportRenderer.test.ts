/**
 * HtmlReportRenderer artifact tests (e4-plan.md #87 "Artifact tests").
 *
 * Real-filesystem integration through temp dirs: RenderResult contract (file://
 * absolute URI, sizeBytes, injected clock), atomic write + no-partial-artifact on
 * failure (M87.4), screenshot embed/reference end-to-end incl. store containment
 * (M87.3), self-containment of the written artifact (M87.5), determinism (NFR3).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import type { StateGraph, WorkflowMap } from "@flowscout/domain";
import { HtmlReportRenderer, ReportRenderError, REPORT_FILENAME } from "../HtmlReportRenderer.js";
import { EMPTY_MAP_MESSAGE } from "../sections/toc.js";
import { makeGraph, makeMap, makeNode, makeReport, makeWorkflow } from "./fixtures.js";

const FIXED_NOW = "2026-07-02T12:00:00.000Z";
const clock = (): Date => new Date(FIXED_NOW);

const SHOT_URI = "shots/state-a.png";
const SHOT_BYTES = Buffer.from("fake-png-bytes-for-embed");

let outputDir: string;
let storeDir: string;

async function makeTempDirs(): Promise<void> {
  outputDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "fs87-out-"));
  storeDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "fs87-store-"));
  await fs.mkdir(nodePath.join(storeDir, "shots"), { recursive: true });
  await fs.writeFile(nodePath.join(storeDir, "shots", "state-a.png"), SHOT_BYTES);
}

beforeEach(makeTempDirs);

afterEach(async () => {
  await fs.chmod(outputDir, 0o755).catch(() => undefined);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.rm(storeDir, { recursive: true, force: true });
});

function makeInputs(): { map: WorkflowMap; graph: StateGraph } {
  const map = makeMap([
    makeWorkflow("wf-login", { name: "Sign in", featureGroup: "Authentication" }),
    makeWorkflow("wf-cart", { name: "Add to cart", featureGroup: "Cart" }),
  ]);
  const graph = makeGraph([makeNode("state-a", { screenshotUri: SHOT_URI }), makeNode("state-b")]);
  return { map, graph };
}

function makeRenderer(overrides: ConstructorParameters<typeof HtmlReportRenderer>[0] = {}) {
  return new HtmlReportRenderer({ clock, screenshotRootDir: storeDir, ...overrides });
}

async function listFiles(dir: string): Promise<string[]> {
  return fs.readdir(dir);
}

describe("render() — artifact contract (AC1)", () => {
  it("writes report.html to outputDir and returns a truthful RenderResult", async () => {
    const { map, graph } = makeInputs();
    const result = await makeRenderer().render(makeReport(map), map, graph, {
      outputDir,
      embedScreenshots: true,
    });

    const artifactPath = nodePath.join(await fs.realpath(outputDir), REPORT_FILENAME);
    expect(result.artifactUri).toBe(pathToFileURL(artifactPath).href);
    expect(result.artifactUri.startsWith("file://")).toBe(true);
    expect(result.generatedAt).toBe(FIXED_NOW);

    const written = await fs.stat(artifactPath);
    expect(result.sizeBytes).toBe(written.size);
    expect(await listFiles(outputDir)).toEqual([REPORT_FILENAME]); // no stray tmp file
  });

  it("uses the caller title when given and a FlowScout default otherwise", async () => {
    const { map, graph } = makeInputs();
    const renderer = makeRenderer();
    await renderer.render(makeReport(map), map, graph, {
      outputDir,
      embedScreenshots: true,
      title: "Custom title",
    });
    let markup = await fs.readFile(nodePath.join(outputDir, REPORT_FILENAME), "utf8");
    expect(markup).toContain("<title>Custom title</title>");

    await renderer.render(makeReport(map), map, graph, { outputDir, embedScreenshots: true });
    markup = await fs.readFile(nodePath.join(outputDir, REPORT_FILENAME), "utf8");
    expect(markup).toContain("<title>FlowScout report — com.example.app</title>");
  });

  it("renders a valid 'nothing discovered' artifact for an empty map + empty graph", async () => {
    const map = makeMap([]);
    const result = await makeRenderer().render(makeReport(map), map, makeGraph([]), {
      outputDir,
      embedScreenshots: true,
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    const markup = await fs.readFile(nodePath.join(outputDir, REPORT_FILENAME), "utf8");
    expect(markup).toContain(EMPTY_MAP_MESSAGE);
    expect(markup).not.toMatch(/<script/i);
  });
});

describe("render() — determinism (NFR3)", () => {
  it("produces byte-identical artifacts for identical inputs and clock", async () => {
    const { map, graph } = makeInputs();
    const otherDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "fs87-out2-"));
    try {
      const renderer = makeRenderer();
      await renderer.render(makeReport(map), map, graph, { outputDir, embedScreenshots: true });
      await renderer.render(makeReport(map), map, graph, {
        outputDir: otherDir,
        embedScreenshots: true,
      });
      const first = await fs.readFile(nodePath.join(outputDir, REPORT_FILENAME), "utf8");
      const second = await fs.readFile(nodePath.join(otherDir, REPORT_FILENAME), "utf8");
      expect(first).toBe(second);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });
});

describe("render() — screenshot pipeline end-to-end (M87.3)", () => {
  it("embeds the store screenshot as base64 and never emits the raw screenshotUri", async () => {
    const { map, graph } = makeInputs();
    await makeRenderer().render(makeReport(map), map, graph, {
      outputDir,
      embedScreenshots: true,
    });
    const markup = await fs.readFile(nodePath.join(outputDir, REPORT_FILENAME), "utf8");
    expect(markup).toContain(`data:image/png;base64,${SHOT_BYTES.toString("base64")}`);
    expect(markup).not.toContain(SHOT_URI);
    for (const remote of ['src="http', 'href="http', 'src="//', 'href="//']) {
      expect(markup).not.toContain(remote);
    }
  });

  it("emits only the contained relative uri in reference mode (no base64, no read)", async () => {
    const { map, graph } = makeInputs();
    await makeRenderer().render(makeReport(map), map, graph, {
      outputDir,
      embedScreenshots: false,
    });
    const markup = await fs.readFile(nodePath.join(outputDir, REPORT_FILENAME), "utf8");
    expect(markup).toContain(`src="${SHOT_URI}"`);
    expect(markup).not.toContain("data:image/");
  });

  it("keeps a ../ traversal screenshotUri contained — placeholder, no secret bytes", async () => {
    const secret = Buffer.from("outside-store-secret-bytes");
    const secretPath = nodePath.join(nodePath.dirname(storeDir), "fs87-secret.png");
    await fs.writeFile(secretPath, secret);
    try {
      const map = makeMap([makeWorkflow("wf-1")]);
      const graph = makeGraph([
        makeNode("state-a", { screenshotUri: "../fs87-secret.png" }),
        makeNode("state-b"),
      ]);
      await makeRenderer().render(makeReport(map), map, graph, {
        outputDir,
        embedScreenshots: true,
      });
      const markup = await fs.readFile(nodePath.join(outputDir, REPORT_FILENAME), "utf8");
      expect(markup).not.toContain(secret.toString("base64"));
      expect(markup).not.toContain("fs87-secret");
      expect(markup).toContain("No screenshot captured for this screen.");
    } finally {
      await fs.rm(secretPath, { force: true });
    }
  });

  it("degrades to text-only when no screenshot store is configured (secure default)", async () => {
    const { map, graph } = makeInputs();
    await new HtmlReportRenderer({ clock }).render(makeReport(map), map, graph, {
      outputDir,
      embedScreenshots: true,
    });
    const markup = await fs.readFile(nodePath.join(outputDir, REPORT_FILENAME), "utf8");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("No screenshot captured for this screen.");
  });
});

describe("render() — outputDir failures (M87.4: typed error, no partial artifact)", () => {
  it("rejects with OUTPUT_DIR_UNAVAILABLE for a missing outputDir", async () => {
    const { map, graph } = makeInputs();
    const missing = nodePath.join(outputDir, "does-not-exist");
    const attempt = makeRenderer().render(makeReport(map), map, graph, {
      outputDir: missing,
      embedScreenshots: true,
    });
    await expect(attempt).rejects.toBeInstanceOf(ReportRenderError);
    await expect(attempt).rejects.toMatchObject({ code: "OUTPUT_DIR_UNAVAILABLE" });
    expect(await listFiles(outputDir)).toEqual([]);
  });

  it("rejects with OUTPUT_DIR_UNAVAILABLE when outputDir is a file", async () => {
    const { map, graph } = makeInputs();
    const filePath = nodePath.join(outputDir, "a-file");
    await fs.writeFile(filePath, "x");
    await expect(
      makeRenderer().render(makeReport(map), map, graph, {
        outputDir: filePath,
        embedScreenshots: true,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_DIR_UNAVAILABLE" });
  });

  it("rejects with OUTPUT_DIR_UNAVAILABLE for an unwritable outputDir and leaves it empty", async () => {
    const { map, graph } = makeInputs();
    await fs.chmod(outputDir, 0o500);
    await expect(
      makeRenderer().render(makeReport(map), map, graph, { outputDir, embedScreenshots: true }),
    ).rejects.toMatchObject({ code: "OUTPUT_DIR_UNAVAILABLE" });
    await fs.chmod(outputDir, 0o755);
    expect(await listFiles(outputDir)).toEqual([]);
  });
});

describe("render() — write failures (M87.4: no partial artifact)", () => {
  it("does NOT create the outputDir (the caller owns the workspace)", async () => {
    const { map, graph } = makeInputs();
    const missing = nodePath.join(outputDir, "nested", "never-created");
    await makeRenderer()
      .render(makeReport(map), map, graph, { outputDir: missing, embedScreenshots: true })
      .catch(() => undefined);
    await expect(fs.stat(missing)).rejects.toThrow();
  });

  it("unlinks the tmp file and rejects WRITE_FAILED when the atomic rename fails", async () => {
    const { map, graph } = makeInputs();
    const renderer = makeRenderer({
      fs: { rename: () => Promise.reject(new Error("disk full")) },
    });
    await expect(
      renderer.render(makeReport(map), map, graph, { outputDir, embedScreenshots: true }),
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });
    expect(await listFiles(outputDir)).toEqual([]); // tmp cleaned, no report.html
  });

  it("rejects WRITE_FAILED cleanly when even the tmp write fails (nothing to unlink)", async () => {
    const { map, graph } = makeInputs();
    const renderer = makeRenderer({
      fs: { writeFile: () => Promise.reject(new Error("EDQUOT")) },
    });
    await expect(
      renderer.render(makeReport(map), map, graph, { outputDir, embedScreenshots: true }),
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });
    expect(await listFiles(outputDir)).toEqual([]);
  });
});
