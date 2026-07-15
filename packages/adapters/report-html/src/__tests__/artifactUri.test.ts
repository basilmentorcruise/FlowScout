/**
 * toRelativeArtifactUri unit tests (ADR-0009 §2 — persisted artifactUri is a POSIX
 * path relative to the artifacts root; never absolute, never outside the root).
 */
import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import * as nodePath from "node:path";
import { toRelativeArtifactUri, ArtifactUriError } from "../artifactUri.js";

const root = nodePath.resolve("/opt/flowscout/artifacts");

describe("toRelativeArtifactUri", () => {
  it("converts a file:// URI under the root to a POSIX relative path", () => {
    const uri = pathToFileURL(nodePath.join(root, "runs", "run-1", "report.html")).href;
    expect(toRelativeArtifactUri(root, uri)).toBe("runs/run-1/report.html");
  });

  it("rejects a URI outside the root", () => {
    const uri = pathToFileURL("/etc/passwd").href;
    expect(() => toRelativeArtifactUri(root, uri)).toThrow(ArtifactUriError);
  });

  it("rejects the root itself (an artifact must be a file under the root)", () => {
    expect(() => toRelativeArtifactUri(root, pathToFileURL(root).href)).toThrow(ArtifactUriError);
  });

  it("rejects non-file URIs", () => {
    expect(() => toRelativeArtifactUri(root, "https://example.com/report.html")).toThrow(
      ArtifactUriError,
    );
  });
});
