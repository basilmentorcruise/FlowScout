/**
 * BaseCandidateEnumerator unit tests.
 */
import { describe, it, expect } from "vitest";
import { defaultEnumerateBaseCandidates } from "../BaseCandidateEnumerator.js";
import type { A11ySnapshot } from "@flowscout/domain";

describe("defaultEnumerateBaseCandidates", () => {
  it("returns empty array for empty snapshot", () => {
    const result = defaultEnumerateBaseCandidates("" as A11ySnapshot);
    expect(result).toHaveLength(0);
  });

  it("returns empty array for non-JSON snapshot", () => {
    const result = defaultEnumerateBaseCandidates("not-json-{{" as A11ySnapshot);
    expect(result).toHaveLength(0);
  });

  it("enumerates tap candidates for button elements", () => {
    const snapshot = JSON.stringify({
      role: "application",
      children: [
        { role: "button", label: "Submit", id: "btn-submit" },
        { role: "button", label: "Cancel", id: "btn-cancel" },
      ],
    }) as A11ySnapshot;

    const result = defaultEnumerateBaseCandidates(snapshot);
    const tapCandidates = result.filter((c) => c.actionType === "tap");
    expect(tapCandidates.length).toBeGreaterThanOrEqual(2);
    expect(tapCandidates.some((c) => c.actionPayload.includes("btn-submit"))).toBe(true);
    expect(tapCandidates.some((c) => c.actionPayload.includes("btn-cancel"))).toBe(true);
  });

  it("enumerates typeText + tap candidates for textField elements", () => {
    const snapshot = JSON.stringify({
      role: "textField",
      label: "Search",
      id: "search-field",
    }) as A11ySnapshot;

    const result = defaultEnumerateBaseCandidates(snapshot);
    expect(result.some((c) => c.actionType === "typeText")).toBe(true);
    expect(result.some((c) => c.actionType === "tap")).toBe(true);
  });

  it("deduplicates candidates by (actionType, actionPayload)", () => {
    const snapshot = JSON.stringify({
      role: "application",
      children: [
        { role: "button", label: "OK", id: "btn-ok" },
        { role: "button", label: "OK again", id: "btn-ok" }, // same id
      ],
    }) as A11ySnapshot;

    const result = defaultEnumerateBaseCandidates(snapshot);
    const tapCount = result.filter(
      (c) => c.actionType === "tap" && c.actionPayload.includes("btn-ok"),
    ).length;
    expect(tapCount).toBe(1); // deduplicated
  });

  it("skips hidden elements", () => {
    const snapshot = JSON.stringify({
      role: "application",
      children: [
        { role: "button", label: "Hidden", id: "btn-hidden", hidden: true },
        { role: "button", label: "Visible", id: "btn-visible" },
      ],
    }) as A11ySnapshot;

    const result = defaultEnumerateBaseCandidates(snapshot);
    expect(result.some((c) => c.actionPayload.includes("btn-hidden"))).toBe(false);
    expect(result.some((c) => c.actionPayload.includes("btn-visible"))).toBe(true);
  });

  it("caps candidates at MAX_CANDIDATES_PER_SCREEN (20)", () => {
    const children = Array.from({ length: 30 }, (_, i) => ({
      role: "button",
      label: `Button ${String(i)}`,
      id: `btn-${String(i)}`,
    }));
    const snapshot = JSON.stringify({ role: "application", children }) as A11ySnapshot;

    const result = defaultEnumerateBaseCandidates(snapshot);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("handles deeply nested elements", () => {
    const snapshot = JSON.stringify({
      role: "application",
      children: [
        {
          role: "other",
          children: [
            {
              role: "other",
              children: [{ role: "button", label: "Deep button", id: "btn-deep" }],
            },
          ],
        },
      ],
    }) as A11ySnapshot;

    const result = defaultEnumerateBaseCandidates(snapshot);
    expect(result.some((c) => c.actionPayload.includes("btn-deep"))).toBe(true);
  });
});
