/**
 * Screenshot resolution pipeline (T2/T3 — M87.3/M87.4).
 *
 * Containment ruling: every screenshotUri-derived path is realpath-resolved and MUST
 * fall inside the configured screenshot store root before any read. When no store root
 * is configured, screenshot access is DISABLED entirely (secure by default) and every
 * step degrades to the text-only placeholder.
 *
 * - embed mode: read from the store, inline as data:image/<png|jpeg|webp>;base64 —
 *   the raw screenshotUri string is never emitted.
 * - reference mode: emit only the original URI once it passes BOTH the lexical scheme
 *   allowlist (safeImageSrc) and store realpath containment.
 * - anything else (hostile scheme, out-of-root, unreadable, unknown extension,
 *   oversized) → null → the no-image placeholder.
 */
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import { safeImageSrc, type ImageSrcMode } from "./html.js";

/** Fixed MIME allowlist keyed by lowercase extension (M87.3). */
const EXTENSION_MIME: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

/** T6 guard: screenshots larger than this degrade to the placeholder. */
export const DEFAULT_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

export interface ScreenshotFs {
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly realpath: (path: string) => Promise<string>;
}

export interface ScreenshotResolverOptions {
  readonly mode: ImageSrcMode;
  /** The FlowScout screenshot store root. undefined ⇒ screenshot access disabled. */
  readonly rootDir: string | undefined;
  readonly fs: ScreenshotFs;
  readonly maxBytes: number;
}

/** Convert a screenshotUri (file: URI or plain path) to a local path, or null. */
function toLocalPath(uri: string): string | null {
  if (uri.toLowerCase().startsWith("file:")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  // Any other scheme (http:, data:, javascript:, blob:, …) is not a local path.
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) ? null : uri;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + nodePath.sep);
}

/** Realpath-resolve `uri` inside the store root; null when it escapes or is unusable. */
async function resolveContainedPath(
  uri: string,
  rootDir: string,
  fs: ScreenshotFs,
): Promise<string | null> {
  const localPath = toLocalPath(uri);
  if (localPath === null) {
    return null;
  }
  try {
    const realRoot = await fs.realpath(rootDir);
    const absolute = nodePath.resolve(realRoot, localPath);
    const real = await fs.realpath(absolute);
    return isInside(realRoot, real) ? real : null;
  } catch {
    // Missing file / unreadable root — degrade, never partially trust the path.
    return null;
  }
}

/**
 * Resolve one screenshotUri to a safe `<img src>` value or null (placeholder).
 * The returned value has ALWAYS passed safeImageSrc for its mode.
 */
export async function resolveScreenshotSrc(
  uri: string,
  options: ScreenshotResolverOptions,
): Promise<string | null> {
  if (uri.length === 0 || options.rootDir === undefined) {
    return null;
  }
  const contained = await resolveContainedPath(uri, options.rootDir, options.fs);
  if (contained === null) {
    return null;
  }
  const mime = EXTENSION_MIME.get(nodePath.extname(contained).toLowerCase());
  if (mime === undefined) {
    return null;
  }
  if (options.mode === "reference") {
    return safeImageSrc(uri, "reference");
  }
  let bytes: Buffer;
  try {
    bytes = await options.fs.readFile(contained);
  } catch {
    return null;
  }
  if (bytes.byteLength > options.maxBytes) {
    return null;
  }
  return safeImageSrc(`data:${mime};base64,${bytes.toString("base64")}`, "embed");
}

/** Resolve the unique screenshot URIs of a run into a lookup map for the sections. */
export async function resolveScreenshotMap(
  uris: Iterable<string>,
  options: ScreenshotResolverOptions,
): Promise<Map<string, string | null>> {
  const unique = [...new Set(uris)];
  const entries = await Promise.all(
    unique.map(async (uri): Promise<[string, string | null]> => {
      return [uri, await resolveScreenshotSrc(uri, options)];
    }),
  );
  return new Map(entries);
}
