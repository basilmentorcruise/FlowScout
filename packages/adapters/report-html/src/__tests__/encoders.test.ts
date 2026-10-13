/**
 * Context-encoder unit tests — safeAnchorId (T4/M88.2 baseline) and
 * safeImageSrc (T2/M87.3 scheme allowlist).
 */
import { describe, it, expect } from "vitest";
import { safeAnchorId, safeImageSrc } from "../html.js";
import { HOSTILE_IMAGE_URIS, XSS_PAYLOADS } from "./xssPayloads.js";

describe("safeAnchorId", () => {
  it("passes through tokens that are already [A-Za-z0-9_-]", () => {
    expect(safeAnchorId("wf-workflow_1")).toBe("wf-workflow_1");
  });

  it("is deterministic — same input, same token", () => {
    expect(safeAnchorId("wf-a b/c")).toBe(safeAnchorId("wf-a b/c"));
  });

  it("emits only allowlisted characters for hostile input", () => {
    for (const payload of XSS_PAYLOADS) {
      expect(safeAnchorId(`wf-${payload.value}`)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("keeps distinct hostile inputs collision-free after sanitization", () => {
    const a = safeAnchorId('wf-"><svg onload=alert(1)>');
    const b = safeAnchorId('wf-"><svg onload=alert(2)>');
    expect(a).not.toBe(b);
  });

  it("never returns an empty token", () => {
    expect(safeAnchorId("")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(safeAnchorId("///")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("safeImageSrc — embed mode (data:image allowlist)", () => {
  it.each(["png", "jpeg", "webp"])("accepts data:image/%s;base64 URIs", (mime) => {
    const uri = `data:image/${mime};base64,iVBORw0KGgo=`;
    expect(safeImageSrc(uri, "embed")).toBe(uri);
  });

  it("rejects non-image and non-base64 data URIs", () => {
    expect(safeImageSrc("data:text/html;base64,PHNjcmlwdD4=", "embed")).toBeNull();
    expect(safeImageSrc("data:image/svg+xml;base64,PHN2Zz4=", "embed")).toBeNull();
    expect(safeImageSrc("data:image/png,rawnotbase64", "embed")).toBeNull();
    expect(safeImageSrc("data:image/gif;base64,R0lGOD==", "embed")).toBeNull();
  });

  it("rejects data URIs whose payload contains non-base64 characters", () => {
    expect(safeImageSrc('data:image/png;base64,"><script>', "embed")).toBeNull();
    // Tightened per arch-review #92: an EMPTY base64 body is rejected too.
    expect(safeImageSrc("data:image/png;base64,", "embed")).toBeNull();
  });

  it("rejects every hostile URI in embed mode", () => {
    for (const hostile of HOSTILE_IMAGE_URIS) {
      expect(safeImageSrc(hostile.value, "embed")).toBeNull();
    }
  });

  it("rejects plain file paths in embed mode (embed emits only generated data URIs)", () => {
    expect(safeImageSrc("shots/state-1.png", "embed")).toBeNull();
    expect(safeImageSrc("file:///store/shots/state-1.png", "embed")).toBeNull();
  });
});

describe("safeImageSrc — reference mode (file:/relative only)", () => {
  it("accepts a plain relative path", () => {
    expect(safeImageSrc("shots/state-1.png", "reference")).toBe("shots/state-1.png");
  });

  it("accepts a file: URI", () => {
    const uri = "file:///store/shots/state-1.png";
    expect(safeImageSrc(uri, "reference")).toBe(uri);
  });

  it("rejects every hostile URI in reference mode", () => {
    for (const hostile of HOSTILE_IMAGE_URIS) {
      expect(safeImageSrc(hostile.value, "reference")).toBeNull();
    }
  });

  it("rejects data: URIs in reference mode (reference emits paths only)", () => {
    expect(safeImageSrc("data:image/png;base64,iVBORw0KGgo=", "reference")).toBeNull();
  });

  it("rejects paths with parent-directory segments", () => {
    expect(safeImageSrc("shots/../../etc/passwd", "reference")).toBeNull();
    expect(safeImageSrc("file:///store/../etc/passwd", "reference")).toBeNull();
  });

  it("rejects backslashes, quotes, whitespace and control characters", () => {
    expect(safeImageSrc("shots\\evil.png", "reference")).toBeNull();
    expect(safeImageSrc('shots/"a".png', "reference")).toBeNull();
    expect(safeImageSrc("shots/a b.png", "reference")).toBeNull();
    expect(safeImageSrc("shots/a\u0000.png", "reference")).toBeNull();
  });

  it("rejects empty strings in both modes", () => {
    expect(safeImageSrc("", "reference")).toBeNull();
    expect(safeImageSrc("", "embed")).toBeNull();
  });
});
