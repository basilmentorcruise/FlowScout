/**
 * SemanticDuplicateDetector — unit suite (#58).
 *
 * Covers the differentiator + precision guards: genuine hidden path flagged, precision floor
 * (similar-but-distinct NOT flagged — AC2), same-raw-id convergence left to E2, transitive label-veto
 * guard (AC3), prominence/tie-break, immutability, and determinism (AC10). Pure & deterministic.
 */
import { describe, it, expect } from "vitest";
import type { CanonicalIdentityMap, StateIdentity, IntentModel } from "@flowscout/domain";
import { SemanticDuplicateDetector } from "../SemanticDuplicateDetector.js";
import { defaultDuplicateDetectorConfig } from "../DuplicateDetectorConfig.js";
import { id, workflow, screen, intentModel } from "./fixtures.js";

function canonMap(pairs: readonly (readonly [string, string])[]): CanonicalIdentityMap {
  const m = new Map<StateIdentity, StateIdentity>();
  for (const [from, to] of pairs) m.set(id(from), id(to));
  return m;
}

const ENTRY = id("entry");
const MID = id("mid");

function detector(confirmWithIntent = true): SemanticDuplicateDetector {
  return new SemanticDuplicateDetector(
    confirmWithIntent ? defaultDuplicateDetectorConfig() : { confirmWithIntent: false },
  );
}

describe("SemanticDuplicateDetector — genuine hidden path (the differentiator)", () => {
  it("flags a cross-identity convergence and marks the longer route hidden", () => {
    // out-x and out-y are DISTINCT a11y buckets the refiner merged → canonical out-x.
    const map = canonMap([
      ["out-x", "out-x"],
      ["out-y", "out-x"],
    ]);
    const wfShort = workflow("wf-short", [ENTRY, id("out-x")]); // 2 steps (prominent)
    const wfLong = workflow("wf-long", [ENTRY, MID, id("out-y")]); // 3 steps (hidden)

    const result = detector().detect([wfShort, wfLong], map);

    expect(result.duplicateGroups).toHaveLength(1);
    const group = result.duplicateGroups[0];
    expect(group?.outcomeIdentity).toBe(id("out-x"));
    expect(group?.canonicalWorkflowId).toBe("wf-short");
    expect(group?.hiddenWorkflowIds).toEqual(["wf-long"]);
    expect(group?.workflowIds).toEqual(["wf-long", "wf-short"]);
    // The hidden route's copy is flagged; the prominent route is not.
    const byId = new Map(result.workflows.map((w) => [w.id, w]));
    expect(byId.get("wf-long")?.isHiddenPath).toBe(true);
    expect(byId.get("wf-short")?.isHiddenPath).toBe(false);
  });
});

describe("SemanticDuplicateDetector — precision floor (AC2)", () => {
  it("does NOT flag a similar-but-distinct pair the refiner kept distinct", () => {
    // The refiner did NOT merge: each raw outcome maps to itself → different canonical ids.
    const map = canonMap([
      ["out-confirmed", "out-confirmed"],
      ["out-cancelled", "out-cancelled"],
    ]);
    const wfA = workflow("wf-a", [ENTRY, id("out-confirmed")]);
    const wfB = workflow("wf-b", [ENTRY, id("out-cancelled")]);

    const result = detector().detect([wfA, wfB], map);

    expect(result.duplicateGroups).toHaveLength(0);
    expect(result.workflows.every((w) => !w.isHiddenPath)).toBe(true);
  });

  it("leaves pure same-raw-id convergence to E2 (not flagged here)", () => {
    // Both workflows end at the SAME raw identity ⇒ E2's structural case, not a semantic duplicate.
    const map = canonMap([["out-x", "out-x"]]);
    const wfA = workflow("wf-a", [ENTRY, id("out-x")]);
    const wfB = workflow("wf-b", [MID, id("out-x")]);

    const result = detector().detect([wfA, wfB], map);

    expect(result.duplicateGroups).toHaveLength(0);
  });
});

describe("SemanticDuplicateDetector — transitive label-veto guard (AC3)", () => {
  // A and B co-class transitively via middle bucket C → one canonical id (A).
  const transitiveMap = canonMap([
    ["out-a", "out-a"],
    ["out-c", "out-a"],
    ["out-b", "out-a"],
  ]);
  const wfA = workflow("wf-a", [ENTRY, id("out-a")]);
  const wfB = workflow("wf-b", [ENTRY, MID, id("out-b")]);

  it("suppresses the false duplicate when confident outcome purposes conflict", () => {
    const intent: IntentModel = intentModel([
      screen(id("out-a"), "Order confirmed", "llm"),
      screen(id("out-b"), "Order cancelled", "llm"),
    ]);

    const result = detector().detect([wfA, wfB], transitiveMap, intent);

    expect(result.duplicateGroups).toHaveLength(0);
    expect(result.workflows.every((w) => !w.isHiddenPath)).toBe(true);
  });

  it("flags the clean transitive merge when purposes agree", () => {
    const intent: IntentModel = intentModel([
      screen(id("out-a"), "Order confirmed", "llm"),
      screen(id("out-b"), "Order confirmed", "llm"),
    ]);

    const result = detector().detect([wfA, wfB], transitiveMap, intent);

    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.duplicateGroups[0]?.hiddenWorkflowIds).toEqual(["wf-b"]);
  });

  it("does not suppress when a conflicting purpose is not LLM-confident", () => {
    const intent: IntentModel = intentModel([
      screen(id("out-a"), "Order confirmed", "llm"),
      screen(id("out-b"), "Order cancelled", "a11y"), // not confident ⇒ ignored
    ]);

    const result = detector().detect([wfA, wfB], transitiveMap, intent);

    expect(result.duplicateGroups).toHaveLength(1);
  });

  it("confirmWithIntent=false bypasses the suppression gate", () => {
    const intent: IntentModel = intentModel([
      screen(id("out-a"), "Order confirmed", "llm"),
      screen(id("out-b"), "Order cancelled", "llm"),
    ]);

    const result = detector(false).detect([wfA, wfB], transitiveMap, intent);

    expect(result.duplicateGroups).toHaveLength(1);
  });
});

describe("SemanticDuplicateDetector — prominence & determinism", () => {
  it("breaks an equal-length tie by lexicographically-smallest workflow id", () => {
    const map = canonMap([
      ["out-x", "out-x"],
      ["out-y", "out-x"],
    ]);
    const wfZ = workflow("wf-z", [ENTRY, id("out-x")]); // 2 steps
    const wfA = workflow("wf-a", [ENTRY, id("out-y")]); // 2 steps (tie) → smallest id wins

    const result = detector().detect([wfZ, wfA], map);

    expect(result.duplicateGroups[0]?.canonicalWorkflowId).toBe("wf-a");
    expect(result.duplicateGroups[0]?.hiddenWorkflowIds).toEqual(["wf-z"]);
  });

  it("never mutates the input workflows (returns copies)", () => {
    const map = canonMap([
      ["out-x", "out-x"],
      ["out-y", "out-x"],
    ]);
    const wfShort = workflow("wf-short", [ENTRY, id("out-x")]);
    const wfLong = workflow("wf-long", [ENTRY, MID, id("out-y")]);
    const inputs = [wfShort, wfLong];

    detector().detect(inputs, map);

    expect(wfShort.isHiddenPath).toBe(false);
    expect(wfLong.isHiddenPath).toBe(false);
  });

  it("ignores a stepless workflow without crashing (AC9)", () => {
    const map = canonMap([["out-x", "out-x"]]);
    const stepless = workflow("wf-empty", []);
    const wf = workflow("wf-a", [ENTRY, id("out-x")]);

    const result = detector().detect([stepless, wf], map);

    expect(result.duplicateGroups).toHaveLength(0);
    expect(result.workflows).toHaveLength(2);
  });

  it("produces deep-equal results across repeated runs (AC10)", () => {
    const map = canonMap([
      ["out-x", "out-x"],
      ["out-y", "out-x"],
    ]);
    const wfShort = workflow("wf-short", [ENTRY, id("out-x")]);
    const wfLong = workflow("wf-long", [ENTRY, MID, id("out-y")]);

    const a = detector().detect([wfShort, wfLong], map);
    const b = detector().detect([wfShort, wfLong], map);
    expect(a).toEqual(b);
  });
});
