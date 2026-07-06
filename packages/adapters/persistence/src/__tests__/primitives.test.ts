/**
 * Codec primitive helpers — typed-error paths (E7.1 / #83).
 * Every malformed field yields a PayloadCodecError, never a raw TypeError.
 */
import { describe, it, expect } from "vitest";
import {
  asArray,
  asRecord,
  isSafePayloadKey,
  parsePayload,
  PayloadCodecError,
  readBoolean,
  readEnum,
  readNullableString,
  readNumber,
  readString,
  readStringArray,
} from "../sqlite/codec/primitives.js";

describe("codec primitives", () => {
  it("parsePayload rejects non-JSON and non-object roots", () => {
    expect(() => parsePayload("not json")).toThrow(PayloadCodecError);
    expect(() => parsePayload("[1,2]")).toThrow(PayloadCodecError);
    expect(() => parsePayload("null")).toThrow(PayloadCodecError);
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 });
  });

  it("asRecord / asArray narrow or throw typed errors", () => {
    expect(() => asRecord("x", "ctx")).toThrow(PayloadCodecError);
    expect(() => asRecord([1], "ctx")).toThrow(PayloadCodecError);
    expect(() => asArray({}, "ctx")).toThrow(PayloadCodecError);
    expect(asArray([1], "ctx")).toEqual([1]);
  });

  it("field readers validate types", () => {
    const record: Record<string, unknown> = { s: "v", n: 1, b: true, nil: null, bad: {} };
    expect(readString(record, "s")).toBe("v");
    expect(() => readString(record, "n")).toThrow(PayloadCodecError);
    expect(readNullableString(record, "nil")).toBeNull();
    expect(() => readNullableString(record, "n")).toThrow(PayloadCodecError);
    expect(readNumber(record, "n")).toBe(1);
    expect(() => readNumber(record, "s")).toThrow(PayloadCodecError);
    expect(() => readNumber({ n: Number.NaN }, "n")).toThrow(PayloadCodecError);
    expect(readBoolean(record, "b")).toBe(true);
    expect(() => readBoolean(record, "s")).toThrow(PayloadCodecError);
  });

  it("readEnum enforces the allow-list", () => {
    const allowed: ReadonlySet<"ios" | "android"> = new Set(["ios", "android"]);
    expect(readEnum({ p: "ios" }, "p", allowed)).toBe("ios");
    expect(() => readEnum({ p: "windows" }, "p", allowed)).toThrow(PayloadCodecError);
  });

  it("readStringArray enforces element types", () => {
    expect(readStringArray({ xs: ["a", "b"] }, "xs")).toEqual(["a", "b"]);
    expect(() => readStringArray({ xs: "a" }, "xs")).toThrow(PayloadCodecError);
    expect(() => readStringArray({ xs: ["a", 1] }, "xs")).toThrow(PayloadCodecError);
  });

  it("isSafePayloadKey rejects the three pollution keys (T5/M83.3)", () => {
    expect(isSafePayloadKey("__proto__")).toBe(false);
    expect(isSafePayloadKey("constructor")).toBe(false);
    expect(isSafePayloadKey("prototype")).toBe(false);
    expect(isSafePayloadKey("label")).toBe(true);
  });
});
