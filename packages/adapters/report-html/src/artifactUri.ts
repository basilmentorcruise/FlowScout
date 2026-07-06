/**
 * Artifact-URI helper (ADR-0009 §2): converts the renderer's truthful absolute
 * `file://` URI into the canonical persisted form — a POSIX path RELATIVE to the
 * configured artifacts root (portable run DB, no personal absolute paths).
 *
 * Pure; #89's use-case is the intended single conversion point.
 */
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";

/** Thrown when the file URI does not live under the artifacts root. */
export class ArtifactUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactUriError";
  }
}

/**
 * `file:///…/artifacts/runs/run-1/report.html` + root `/…/artifacts`
 *   → `runs/run-1/report.html` (POSIX separators).
 * Rejects URIs outside `rootDir` (including `..` escapes).
 */
export function toRelativeArtifactUri(rootDir: string, fileUri: string): string {
  let absolutePath: string;
  try {
    absolutePath = fileURLToPath(fileUri);
  } catch (cause) {
    throw new ArtifactUriError(`artifactUri is not a valid file:// URI: ${String(cause)}`);
  }
  const root = nodePath.resolve(rootDir);
  const relative = nodePath.relative(root, nodePath.resolve(absolutePath));
  if (relative.length === 0 || relative.startsWith("..") || nodePath.isAbsolute(relative)) {
    throw new ArtifactUriError("artifact URI resolves outside the artifacts root");
  }
  return relative.split(nodePath.sep).join("/");
}
