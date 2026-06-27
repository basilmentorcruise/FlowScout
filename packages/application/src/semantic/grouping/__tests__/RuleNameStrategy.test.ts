/**
 * RuleNameStrategy — tier-1 deterministic naming/grouping (#56). Zero LLM.
 */
import { describe, it, expect } from "vitest";
import { RuleNameStrategy } from "../RuleNameStrategy.js";
import { UNGROUPED } from "../GroupingConfig.js";
import type { RedactedScreenSignal } from "../RuleNameStrategy.js";
import type { StateIdentity } from "@flowscout/domain";
import {
  SIGN_IN_STATE,
  HOME_STATE,
  CART_STATE,
  CHECKOUT_STATE,
  LOGIN_WORKFLOW,
  CHECKOUT_WORKFLOW,
  workflow,
  step,
  id,
} from "./fixtures.js";

function signals(
  entries: readonly (readonly [StateIdentity, RedactedScreenSignal])[],
): Map<StateIdentity, RedactedScreenSignal> {
  return new Map(entries);
}

describe("RuleNameStrategy", () => {
  const strategy = new RuleNameStrategy();

  it("derives a rich name + 'Authentication' group from login intent (rule, confidence null)", () => {
    const result = strategy.derive(
      LOGIN_WORKFLOW,
      signals([
        [SIGN_IN_STATE, { purpose: "Sign in screen", controlIntents: ["Submit the login form"] }],
        [HOME_STATE, { purpose: "Home dashboard", controlIntents: [] }],
      ]),
    );
    expect(result.labeling.name).toBe("Sign in screen → Home dashboard");
    expect(result.labeling.featureGroup).toBe("Authentication");
    expect(result.labeling.confidence).toBeNull();
    expect(result.labeling.description).toContain("Sign in screen");
    expect(result.weak).toBe(false);
  });

  it("derives 'Cart & Checkout' group from checkout intent", () => {
    const result = strategy.derive(
      CHECKOUT_WORKFLOW,
      signals([
        [CART_STATE, { purpose: "Shopping cart", controlIntents: ["Proceed to checkout"] }],
        [CHECKOUT_STATE, { purpose: "Checkout and payment", controlIntents: ["Place order"] }],
      ]),
    );
    expect(result.labeling.featureGroup).toBe("Cart & Checkout");
    expect(result.weak).toBe(false);
  });

  it("missing intent ⇒ provisional name kept + 'Ungrouped' + weak=true", () => {
    const wf = workflow({
      id: "wf-x",
      name: "Some Path",
      description: "Provisional desc",
      steps: [step(0, id("unknown-state"), "Tap around")],
    });
    const result = strategy.derive(wf, signals([]));
    expect(result.labeling.name).toBe("Some Path");
    expect(result.labeling.description).toBe("Provisional desc");
    expect(result.labeling.featureGroup).toBe(UNGROUPED);
    expect(result.weak).toBe(true);
  });

  it("blank provisional name falls back to a non-empty default (never empty)", () => {
    const wf = workflow({
      id: "wf-blank",
      name: "   ",
      description: "  ",
      steps: [step(0, id("s-blank"), "  ")],
    });
    const result = strategy.derive(wf, signals([]));
    expect(result.labeling.name.length).toBeGreaterThan(0);
    expect(result.labeling.description.length).toBeGreaterThan(0);
  });

  it("de-duplicates repeated screen purposes in order", () => {
    const s = id("s-rep");
    const wf = workflow({
      id: "wf-rep",
      steps: [step(0, s, "a"), step(1, s, "b")],
    });
    const result = strategy.derive(
      wf,
      signals([[s, { purpose: "Search results", controlIntents: ["search"] }]]),
    );
    // single de-duplicated purpose ⇒ no " → " join
    expect(result.labeling.name).toBe("Search results");
    expect(result.labeling.featureGroup).toBe("Search & Browse");
  });

  it("classifies a workflow with a group but a present name as not weak", () => {
    const result = strategy.derive(
      LOGIN_WORKFLOW,
      signals([[SIGN_IN_STATE, { purpose: "Password entry", controlIntents: [] }]]),
    );
    expect(result.labeling.featureGroup).toBe("Authentication");
    expect(result.weak).toBe(false);
  });
});
