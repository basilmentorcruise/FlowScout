/**
 * HtmlReportRenderer — the real ReportRendererPort implementation (#87, ADR-0009).
 *
 * Thin shell over pure composition: validate outputDir → resolve screenshots →
 * compose document (viewmodel + sections through the SafeHtml boundary) →
 * atomic write (tmp + rename; unlink on failure — no partial artifact).
 *
 * Security posture (threat model):
 * - M87.1/M87.2: every dynamic value flows through html.ts (see document.ts/sections).
 * - M87.3: screenshot embed/reference via screenshots.ts scheme allowlist + store
 *   containment; the raw screenshotUri is never emitted in embed mode.
 * - M87.4: outputDir is caller/config-owned and must already exist; the artifact
 *   filename is the fixed literal "report.html" (trivially sanitized token); the
 *   final write path is realpath-contained in outputDir; unwritable dir → typed
 *   error with no partial artifact.
 * - M87.7: zero runtime dependencies; no eval in the render path.
 */
import { constants as fsConstants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import type { Report, RenderOptions, RenderResult, ReportRendererPort } from "@flowscout/domain";
import type { StateGraph, WorkflowMap } from "@flowscout/domain";
import { renderDocument } from "./document.js";
import { buildReportView, DEFAULT_MAX_STRING_LENGTH, type ReportView } from "./viewmodel.js";
import {
  DEFAULT_MAX_SCREENSHOT_BYTES,
  resolveScreenshotMap,
  type ScreenshotFs,
} from "./screenshots.js";

/** The fixed, allowlisted artifact filename (M87.4 — never derived from input). */
export const REPORT_FILENAME = "report.html";

export type ReportRenderErrorCode = "OUTPUT_DIR_UNAVAILABLE" | "WRITE_FAILED";

/** Typed render failure (clear error contract for the #89 use-case). */
export class ReportRenderError extends Error {
  constructor(
    readonly code: ReportRenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReportRenderError";
  }
}

/** Filesystem seam — injectable for tests; defaults to node:fs/promises. */
export interface RendererFs extends ScreenshotFs {
  readonly writeFile: (path: string, data: string, encoding: "utf8") => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly stat: (path: string) => Promise<{ isDirectory(): boolean }>;
  readonly access: (path: string, mode: number) => Promise<void>;
}

export interface HtmlReportRendererOptions {
  /**
   * The FlowScout screenshot store root. When omitted, screenshot access is
   * DISABLED (secure default — M87.4) and steps degrade to the text placeholder.
   */
  readonly screenshotRootDir?: string;
  /** Injected clock (NFR3 determinism in tests). */
  readonly clock?: () => Date;
  /** T6 caps — see viewmodel.ts / screenshots.ts defaults. */
  readonly maxStringLength?: number;
  readonly maxScreenshotBytes?: number;
  readonly fs?: Partial<RendererFs>;
}

const DEFAULT_FS: RendererFs = {
  readFile: (path) => fsPromises.readFile(path),
  realpath: (path) => fsPromises.realpath(path),
  writeFile: (path, data, encoding) => fsPromises.writeFile(path, data, { encoding }),
  rename: (from, to) => fsPromises.rename(from, to),
  unlink: (path) => fsPromises.unlink(path),
  stat: (path) => fsPromises.stat(path),
  access: (path, mode) => fsPromises.access(path, mode),
};

export class HtmlReportRenderer implements ReportRendererPort {
  private readonly fs: RendererFs;
  private readonly clock: () => Date;
  private readonly screenshotRootDir: string | undefined;
  private readonly maxStringLength: number;
  private readonly maxScreenshotBytes: number;

  constructor(options: HtmlReportRendererOptions = {}) {
    this.fs = { ...DEFAULT_FS, ...options.fs };
    this.clock = options.clock ?? (() => new Date());
    this.screenshotRootDir = options.screenshotRootDir;
    this.maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
    this.maxScreenshotBytes = options.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES;
  }

  async render(
    report: Report,
    workflowMap: WorkflowMap,
    stateGraph: StateGraph,
    options: RenderOptions,
  ): Promise<RenderResult> {
    const artifactPath = await this.resolveArtifactPath(options.outputDir);
    const view = buildReportView(report, workflowMap, stateGraph, {
      maxStringLength: this.maxStringLength,
    });
    const document = await this.composeDocument(view, report, options);
    await this.writeAtomically(artifactPath, document);
    return {
      artifactUri: pathToFileURL(artifactPath).href,
      generatedAt: this.clock().toISOString(),
      sizeBytes: Buffer.byteLength(document, "utf8"),
    };
  }

  /** M87.4: outputDir must exist, be a writable directory, and contain the artifact. */
  private async resolveArtifactPath(outputDir: string): Promise<string> {
    let realOutputDir: string;
    try {
      const stat = await this.fs.stat(outputDir);
      if (!stat.isDirectory()) {
        throw new Error("not a directory");
      }
      await this.fs.access(outputDir, fsConstants.W_OK);
      realOutputDir = await this.fs.realpath(outputDir);
    } catch (cause) {
      throw new ReportRenderError(
        "OUTPUT_DIR_UNAVAILABLE",
        `outputDir is missing or not a writable directory: ${String(cause)}`,
      );
    }
    const artifactPath = nodePath.resolve(realOutputDir, REPORT_FILENAME);
    if (nodePath.dirname(artifactPath) !== realOutputDir) {
      throw new ReportRenderError("WRITE_FAILED", "artifact path escaped outputDir");
    }
    return artifactPath;
  }

  private async composeDocument(
    view: ReportView,
    report: Report,
    options: RenderOptions,
  ): Promise<string> {
    const uris = view.groups
      .flatMap((group) => group.workflows)
      .flatMap((workflow) => workflow.steps)
      .map((step) => step.screenshotUri)
      .filter((uri): uri is string => uri !== null);
    const screenshotSrcByUri = await resolveScreenshotMap(uris, {
      mode: options.embedScreenshots ? "embed" : "reference",
      rootDir: this.screenshotRootDir,
      fs: this.fs,
      maxBytes: this.maxScreenshotBytes,
    });
    return renderDocument(view, {
      title: options.title ?? `FlowScout report — ${report.metadata.appId}`,
      renderedAt: this.clock().toISOString(),
      screenshotSrcByUri,
    }).value;
  }

  /** Atomic write: tmp + rename; best-effort unlink on failure (no partial artifact). */
  private async writeAtomically(artifactPath: string, document: string): Promise<void> {
    const tmpPath = `${artifactPath}.tmp-${String(process.pid)}`;
    try {
      await this.fs.writeFile(tmpPath, document, "utf8");
      await this.fs.rename(tmpPath, artifactPath);
    } catch (cause) {
      try {
        await this.fs.unlink(tmpPath);
      } catch {
        // tmp never materialized — nothing to clean.
      }
      throw new ReportRenderError("WRITE_FAILED", `failed to write artifact: ${String(cause)}`);
    }
  }
}
