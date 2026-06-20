import { describe, it, expect } from "vitest";
import { makeStateIdentity } from "../models/state-graph.js";

describe("makeStateIdentity", () => {
  it("creates a StateIdentity from a non-empty string", () => {
    const id = makeStateIdentity("home-screen-abc123");
    expect(id).toBe("home-screen-abc123");
  });

  it("throws when given an empty string", () => {
    expect(() => makeStateIdentity("")).toThrow("StateIdentity must be a non-empty string");
  });

  it("throws when given a whitespace-only string", () => {
    expect(() => makeStateIdentity("   ")).toThrow("StateIdentity must be a non-empty string");
  });

  it("preserves special characters in the identity string", () => {
    const id = makeStateIdentity("screen:login#main/tab-0");
    expect(id).toBe("screen:login#main/tab-0");
  });
});
