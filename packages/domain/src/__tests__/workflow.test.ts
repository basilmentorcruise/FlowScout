import { describe, it, expect } from "vitest";
import { makeConfidenceScore } from "../models/workflow.js";

describe("makeConfidenceScore", () => {
  it("creates a ConfidenceScore for 0", () => {
    expect(makeConfidenceScore(0)).toBe(0);
  });

  it("creates a ConfidenceScore for 1", () => {
    expect(makeConfidenceScore(1)).toBe(1);
  });

  it("creates a ConfidenceScore for a mid-range value", () => {
    expect(makeConfidenceScore(0.75)).toBe(0.75);
  });

  it("throws when value is less than 0", () => {
    expect(() => makeConfidenceScore(-0.1)).toThrow("ConfidenceScore must be in [0, 1]");
  });

  it("throws when value is greater than 1", () => {
    expect(() => makeConfidenceScore(1.1)).toThrow("ConfidenceScore must be in [0, 1]");
  });
});
