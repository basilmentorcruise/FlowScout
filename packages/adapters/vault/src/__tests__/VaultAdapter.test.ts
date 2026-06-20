/**
 * VaultAdapter stub tests.
 * Verifies that all methods reject with "not yet implemented" until E6 lands.
 */
import { describe, it, expect } from "vitest";
import { VaultAdapter } from "../VaultAdapter.js";

describe("VaultAdapter (stub)", () => {
  const adapter = new VaultAdapter();

  it("store rejects with not-implemented error", async () => {
    await expect(
      adapter.store("app1", "label", { username: "u", password: "p", otpSeed: null }),
    ).rejects.toThrow("not yet implemented");
  });

  it("retrieve rejects with not-implemented error", async () => {
    await expect(adapter.retrieve("app1", "label")).rejects.toThrow("not yet implemented");
  });

  it("listLabels rejects with not-implemented error", async () => {
    await expect(adapter.listLabels("app1")).rejects.toThrow("not yet implemented");
  });

  it("delete rejects with not-implemented error", async () => {
    await expect(adapter.delete("app1", "label")).rejects.toThrow("not yet implemented");
  });
});
