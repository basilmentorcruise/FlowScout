/**
 * Screenshot resolution pipeline tests (T2/T3 — M87.3/M87.4).
 *
 * Uses an injected fake ScreenshotFs so containment is tested as LOGIC (including
 * symlink escapes via fake realpath), not as an accident of temp-dir layout:
 * scheme allowlist, store realpath containment, MIME allowlist, size cap,
 * secure-by-default disabled store, embed vs reference mode.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_SCREENSHOT_BYTES,
  resolveScreenshotMap,
  resolveScreenshotSrc,
  type ScreenshotFs,
  type ScreenshotResolverOptions,
} from "../screenshots.js";
import { HOSTILE_IMAGE_URIS } from "./xssPayloads.js";

const ROOT = "/store";
const PNG_BYTES = Buffer.from("fake-png-bytes");

interface FakeFsSpec {
  /** path → realpath (missing ⇒ ENOENT). */
  readonly realpaths: Record<string, string>;
  /** realpath → contents (missing ⇒ EACCES on read). */
  readonly files: Record<string, Buffer>;
}

function makeFakeFs(spec: FakeFsSpec): ScreenshotFs {
  return {
    realpath: (path) => {
      const real = spec.realpaths[path];
      return real === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(real);
    },
    readFile: (path) => {
      const bytes = spec.files[path];
      return bytes === undefined
        ? Promise.reject(new Error(`EACCES: ${path}`))
        : Promise.resolve(bytes);
    },
  };
}

const STORE_FS = makeFakeFs({
  realpaths: {
    [ROOT]: ROOT,
    "/store/shots/a.png": "/store/shots/a.png",
    "/store/shots/b.jpg": "/store/shots/b.jpg",
    "/store/shots/c.jpeg": "/store/shots/c.jpeg",
    "/store/shots/d.webp": "/store/shots/d.webp",
    "/store/shots/e.gif": "/store/shots/e.gif",
    "/store/shots/f.svg": "/store/shots/f.svg",
    "/store/shots/big.png": "/store/shots/big.png",
    "/store/shots/unreadable.png": "/store/shots/unreadable.png",
    "/store/link.png": "/outside/escape.png", // symlink escaping the store
    "/secret.png": "/secret.png", // exists but outside the store
    "/outside/escape.png": "/outside/escape.png",
  },
  files: {
    "/store/shots/a.png": PNG_BYTES,
    "/store/shots/b.jpg": PNG_BYTES,
    "/store/shots/c.jpeg": PNG_BYTES,
    "/store/shots/d.webp": PNG_BYTES,
    "/store/shots/big.png": Buffer.alloc(64),
    "/outside/escape.png": Buffer.from("outside-store"),
    "/secret.png": Buffer.from("top-level-secret-file"),
  },
});

function options(overrides: Partial<ScreenshotResolverOptions> = {}): ScreenshotResolverOptions {
  return {
    mode: "embed",
    rootDir: ROOT,
    fs: STORE_FS,
    maxBytes: DEFAULT_MAX_SCREENSHOT_BYTES,
    ...overrides,
  };
}

describe("resolveScreenshotSrc — embed mode (M87.3)", () => {
  it("inlines an in-store png as data:image/png;base64 (raw uri never emitted)", async () => {
    const src = await resolveScreenshotSrc("shots/a.png", options());
    expect(src).toBe(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
    expect(src).not.toContain("shots/a.png");
  });

  it.each([
    ["shots/b.jpg", "image/jpeg"],
    ["shots/c.jpeg", "image/jpeg"],
    ["shots/d.webp", "image/webp"],
  ])("maps %s to MIME %s", async (uri, mime) => {
    const src = await resolveScreenshotSrc(uri, options());
    expect(src?.startsWith(`data:${mime};base64,`)).toBe(true);
  });

  it("accepts a file: URI that resolves inside the store", async () => {
    const src = await resolveScreenshotSrc("file:///store/shots/a.png", options());
    expect(src).toBe(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
  });

  it.each([["shots/e.gif"], ["shots/f.svg"]])(
    "rejects non-allowlisted extension %s (MIME allowlist)",
    async (uri) => {
      expect(await resolveScreenshotSrc(uri, options())).toBeNull();
    },
  );

  it("rejects a ../ traversal even when the target EXISTS (containment, not ENOENT)", async () => {
    expect(await resolveScreenshotSrc("../secret.png", options())).toBeNull();
  });

  it("rejects a symlink whose realpath escapes the store", async () => {
    expect(await resolveScreenshotSrc("link.png", options())).toBeNull();
  });

  it.each(HOSTILE_IMAGE_URIS.map((p) => [p.id, p.value] as const))(
    "degrades hostile uri %s to the placeholder (null)",
    async (_id, uri) => {
      expect(await resolveScreenshotSrc(uri, options())).toBeNull();
    },
  );

  it("returns null when no store root is configured (secure default M87.4)", async () => {
    expect(await resolveScreenshotSrc("shots/a.png", options({ rootDir: undefined }))).toBeNull();
  });

  it("returns null for an empty uri, a missing file and an unreadable file", async () => {
    expect(await resolveScreenshotSrc("", options())).toBeNull();
    expect(await resolveScreenshotSrc("shots/missing.png", options())).toBeNull();
    expect(await resolveScreenshotSrc("shots/unreadable.png", options())).toBeNull();
  });

  it("returns null for a malformed file: URI", async () => {
    expect(await resolveScreenshotSrc("file://%zz-bad", options())).toBeNull();
  });

  it("returns null when the file exceeds the size cap (T6)", async () => {
    expect(await resolveScreenshotSrc("shots/big.png", options({ maxBytes: 32 }))).toBeNull();
  });
});

describe("resolveScreenshotSrc — reference mode", () => {
  it("emits the ORIGINAL contained uri (no read, no data:)", async () => {
    const src = await resolveScreenshotSrc("shots/a.png", options({ mode: "reference" }));
    expect(src).toBe("shots/a.png");
  });

  it("still requires store containment (in-root realpath) before emitting", async () => {
    expect(await resolveScreenshotSrc("../secret.png", options({ mode: "reference" }))).toBeNull();
    expect(await resolveScreenshotSrc("link.png", options({ mode: "reference" }))).toBeNull();
  });

  it.each(HOSTILE_IMAGE_URIS.map((p) => [p.id, p.value] as const))(
    "degrades hostile uri %s to the placeholder in reference mode too",
    async (_id, uri) => {
      expect(await resolveScreenshotSrc(uri, options({ mode: "reference" }))).toBeNull();
    },
  );
});

describe("resolveScreenshotMap", () => {
  it("resolves unique uris once and keeps hostile entries as null placeholders", async () => {
    const map = await resolveScreenshotMap(
      ["shots/a.png", "shots/a.png", "../secret.png", "shots/e.gif"],
      options(),
    );
    expect(map.size).toBe(3);
    expect(map.get("shots/a.png")).toContain("data:image/png;base64,");
    expect(map.get("../secret.png")).toBeNull();
    expect(map.get("shots/e.gif")).toBeNull();
  });
});
