/**
 * A11yIntentDeriver (tier-1) unit suite — ZERO LlmPort (ADR-0006 AC1/AC2 §4).
 *
 * Covers: concise intent from a11y labels (no LLM); degraded role+position fallback;
 * per-control intent from outgoing edges; never empty / never throws; malformed JSON.
 */
import { describe, it, expect } from "vitest";
import { A11yIntentDeriver } from "../A11yIntentDeriver.js";
import { node, edge, id, SIGN_IN_SNAPSHOT, UNLABELLED_SNAPSHOT } from "./fixtures.js";

const deriver = new A11yIntentDeriver();

describe("A11yIntentDeriver — tier-1 concise intent from a11y labels", () => {
  it("derives a screen purpose from the node label, source=a11y, confidence=null", () => {
    const n = node({ id: id("s1"), label: "Sign In", a11ySnapshot: SIGN_IN_SNAPSHOT });
    const result = deriver.derive(n, SIGN_IN_SNAPSHOT, []);

    expect(result.purpose).toBe("Sign In screen");
    expect(result.source).toBe("a11y");
    expect(result.confidence).toBeNull();
  });

  it("derives screen purpose from a heading when node label is empty", () => {
    const n = node({ id: id("s1"), label: "", a11ySnapshot: SIGN_IN_SNAPSHOT });
    const result = deriver.derive(n, SIGN_IN_SNAPSHOT, []);
    expect(result.purpose).toBe("Sign In screen");
    expect(result.source).toBe("a11y");
  });

  it("derives per-control intent from outgoing edges (submit/input/navigation)", () => {
    const n = node({ id: id("s1"), label: "Sign In", a11ySnapshot: SIGN_IN_SNAPSHOT });
    const edges = [
      edge({ fromId: id("s1"), toId: id("s2"), actionType: "typeText", actionPayload: "Email" }),
      edge({ fromId: id("s1"), toId: id("s3"), actionType: "tap", actionPayload: "Log In" }),
      edge({
        fromId: id("s1"),
        toId: id("s4"),
        actionType: "tap",
        actionPayload: "Forgot password",
      }),
    ];
    const result = deriver.derive(n, SIGN_IN_SNAPSHOT, edges);

    expect(result.controls).toHaveLength(3);
    const [input, submit, nav] = result.controls;
    expect(input?.affordance).toBe("input");
    expect(input?.intent).toContain("Email");
    expect(submit?.affordance).toBe("submit");
    expect(submit?.intent).toContain("Log In");
    expect(nav?.affordance).toBe("navigation");
    expect(result.controls.every((c) => c.source === "a11y" && c.confidence === null)).toBe(true);
  });

  it("classifies dismiss and toggle affordances by label keywords", () => {
    const n = node({ id: id("s1"), label: "Settings", a11ySnapshot: "{}" });
    const edges = [
      edge({ fromId: id("s1"), toId: id("s2"), actionType: "tap", actionPayload: "Cancel" }),
      edge({
        fromId: id("s1"),
        toId: id("s3"),
        actionType: "tap",
        actionPayload: "Enable notifications",
      }),
    ];
    const result = deriver.derive(n, "{}", edges);
    expect(result.controls[0]?.affordance).toBe("dismiss");
    expect(result.controls[1]?.affordance).toBe("toggle");
  });
});

describe("A11yIntentDeriver — degraded fallback (AC2: never empty, never throws)", () => {
  it("yields a degraded screen purpose for an unlabelled snapshot", () => {
    const n = node({ id: id("s1"), label: "", a11ySnapshot: UNLABELLED_SNAPSHOT });
    const result = deriver.derive(n, UNLABELLED_SNAPSHOT, []);

    expect(result.purpose.length).toBeGreaterThan(0);
    expect(result.purpose).toContain("Unlabelled screen");
    expect(result.source).toBe("degraded");
    expect(result.confidence).toBeNull();
  });

  it("yields a degraded control intent (action + position) when no label is available", () => {
    const n = node({ id: id("s1"), label: "", a11ySnapshot: UNLABELLED_SNAPSHOT });
    const edges = [
      edge({ fromId: id("s1"), toId: id("s2"), actionType: "tap", actionPayload: '{"x":1,"y":2}' }),
    ];
    const result = deriver.derive(n, UNLABELLED_SNAPSHOT, edges);
    const control = result.controls[0];
    expect(control?.intent.length).toBeGreaterThan(0);
    expect(control?.intent).toContain("position 1");
    expect(control?.source).toBe("degraded");
  });

  it("never throws and returns a present purpose on malformed JSON", () => {
    const n = node({ id: id("s1"), label: "", a11ySnapshot: "not-json{{{" });
    expect(() => deriver.derive(n, "not-json{{{", [])).not.toThrow();
    const result = deriver.derive(n, "not-json{{{", []);
    expect(result.purpose.length).toBeGreaterThan(0);
    expect(result.source).toBe("degraded");
  });

  it("returns empty controls for a node with no edges, no crash", () => {
    const n = node({ id: id("s1"), label: "Home", a11ySnapshot: "{}" });
    const result = deriver.derive(n, "{}", []);
    expect(result.controls).toEqual([]);
    expect(result.purpose).toBe("Home screen");
  });

  it("composes a generic 'Activate' intent for a labelled control with an unknown affordance", () => {
    const n = node({ id: id("s1"), label: "Gallery", a11ySnapshot: "{}" });
    const edges = [
      edge({ fromId: id("s1"), toId: id("s2"), actionType: "swipe", actionPayload: "photo-3" }),
    ];
    const result = deriver.derive(n, "{}", edges);
    expect(result.controls[0]?.affordance).toBe("unknown");
    expect(result.controls[0]?.intent).toBe("Activate photo-3");
  });

  it("flattens an array-rooted snapshot without crashing", () => {
    const snapshot = JSON.stringify([{ role: "button", label: "OK" }]);
    const n = node({ id: id("s1"), label: "", a11ySnapshot: snapshot });
    const result = deriver.derive(n, snapshot, []);
    expect(result.purpose).toBe("OK screen");
    expect(result.source).toBe("a11y");
  });

  it("treats a screen as a11y if any control is labelled even when the screen heading is absent", () => {
    const n = node({ id: id("s1"), label: "", a11ySnapshot: "{}" });
    const edges = [
      edge({ fromId: id("s1"), toId: id("s2"), actionType: "tap", actionPayload: "Continue" }),
    ];
    const result = deriver.derive(n, "{}", edges);
    expect(result.source).toBe("a11y");
    expect(result.controls[0]?.affordance).toBe("submit");
  });
});
