/**
 * Pagination-cursor codec tests (E7.1 / #83 — T4/M83.4 evidence).
 *
 * The cursor is an OPAQUE token, decoded DEFENSIVELY: shape and field types are
 * validated after a plain bounded parse; ANY malformed/oversized/mistyped input
 * yields `null` (treated as the first page by callers) — never a throw, never a
 * stack leak. Decoded values only ever flow into bound SQL params (T3).
 */
import { describe, it, expect } from "vitest";
import { encodeRunPageCursor, decodeRunPageCursor } from "../sqlite/cursor.js";

describe("run-page cursor codec", () => {
  it("round-trips a keyset position through an opaque token", () => {
    const position = { startedAt: "2026-07-02T10:00:00.000Z", id: "run-42" };
    const token = encodeRunPageCursor(position);
    // Opaque: no raw field values visible in the token.
    expect(token).not.toContain("run-42");
    expect(decodeRunPageCursor(token)).toEqual(position);
  });

  it("returns null (first page) for malformed tokens — never a throw (T4)", () => {
    const malformed = [
      "",
      "%%%not-base64%%%",
      "AAAA", // valid base64, not JSON
      Buffer.from("[1,2,3]", "utf8").toString("base64url"), // array, not object
      Buffer.from("null", "utf8").toString("base64url"),
      Buffer.from('"a string"', "utf8").toString("base64url"),
      Buffer.from('{"s":123,"i":"x"}', "utf8").toString("base64url"), // wrong type
      Buffer.from('{"s":"t"}', "utf8").toString("base64url"), // missing field
      Buffer.from('{"i":"x"}', "utf8").toString("base64url"),
    ];
    for (const token of malformed) {
      expect(() => decodeRunPageCursor(token)).not.toThrow();
      expect(decodeRunPageCursor(token)).toBeNull();
    }
  });

  it("rejects oversized tokens up front (T4 — bounded input)", () => {
    const oversized = Buffer.from(
      JSON.stringify({ s: "x".repeat(10_000), i: "y" }),
      "utf8",
    ).toString("base64url");
    expect(decodeRunPageCursor(oversized)).toBeNull();
    expect(decodeRunPageCursor("A".repeat(100_000))).toBeNull();
  });

  it("returns null for null/undefined input (first page)", () => {
    expect(decodeRunPageCursor(null)).toBeNull();
    expect(decodeRunPageCursor(undefined)).toBeNull();
  });

  it("does not pollute Object.prototype via a __proto__-laden token (decode is read-only)", () => {
    const hostile = Buffer.from('{"s":"t","i":"x","__proto__":{"polluted":true}}').toString(
      "base64url",
    );
    const decoded = decodeRunPageCursor(hostile);
    expect(decoded).toEqual({ startedAt: "t", id: "x" });
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
