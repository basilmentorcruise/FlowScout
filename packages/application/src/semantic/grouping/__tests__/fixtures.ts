/**
 * Shared deterministic fixtures for the naming/grouping suites (#56 / E3.3).
 * Builders for Workflow / WorkflowStep / IntentModel + a small budget factory.
 */
import type {
  CrawlBudget,
  ControlIntent,
  IntentModel,
  ScreenIntent,
  StateIdentity,
  Workflow,
  WorkflowStep,
} from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";

export function id(raw: string): StateIdentity {
  return makeStateIdentity(raw);
}

export function budget(overrides: Partial<CrawlBudget> = {}): CrawlBudget {
  return {
    maxSteps: 100,
    maxLlmCalls: 5,
    maxTokens: 10_000,
    maxRevisitsPerState: 3,
    plateauWindow: 40,
    plateauWarnRatio: 0.75,
    ...overrides,
  };
}

/** Build a workflow step (terminal step passes `edge: null`). */
export function step(stepIndex: number, stateId: StateIdentity, description: string): WorkflowStep {
  return { stepIndex, stateId, edge: null, description };
}

/** Build a workflow with the extractor-style provisional defaults. */
export function workflow(
  overrides: Partial<Workflow> & { id: string; steps: readonly WorkflowStep[] },
): Workflow {
  return {
    name: "<entry> → <outcome>",
    description: "Provisional path",
    isHiddenPath: false,
    inferenceConfidence: null,
    ...overrides,
  };
}

/** Build a control intent overlay entry. */
export function control(edgeId: string, intent: string, affordance = "navigation"): ControlIntent {
  return { edgeId, actionType: "tap", intent, affordance, source: "a11y", confidence: null };
}

/** Build a screen intent overlay entry. */
export function screen(
  stateId: StateIdentity,
  purpose: string,
  controls: readonly ControlIntent[] = [],
): ScreenIntent {
  return { stateId, purpose, source: "a11y", confidence: null, controls };
}

/** Build an intent model overlay. */
export function intentModel(screens: readonly ScreenIntent[], runId = "run-1"): IntentModel {
  return { runId, screens };
}

// ── Canonical fixtures (a login + a checkout workflow with rich intent) ───────

export const SIGN_IN_STATE = id("screen-signin");
export const HOME_STATE = id("screen-home");
export const CART_STATE = id("screen-cart");
export const CHECKOUT_STATE = id("screen-checkout");
export const ORDER_DONE_STATE = id("screen-order-confirmed");

export const LOGIN_WORKFLOW: Workflow = workflow({
  id: "wf-login",
  steps: [step(0, SIGN_IN_STATE, "Enter credentials"), step(1, HOME_STATE, "Arrive at home")],
});

export const CHECKOUT_WORKFLOW: Workflow = workflow({
  id: "wf-checkout",
  steps: [
    step(0, CART_STATE, "Review cart"),
    step(1, CHECKOUT_STATE, "Enter payment"),
    step(2, ORDER_DONE_STATE, "Order placed"),
  ],
});

export const RICH_INTENT: IntentModel = intentModel([
  screen(SIGN_IN_STATE, "Sign in screen", [control("e1", "Submit the login form", "submit")]),
  screen(HOME_STATE, "Home dashboard", [control("e2", "Open menu")]),
  screen(CART_STATE, "Shopping cart", [control("e3", "Proceed to checkout", "navigation")]),
  screen(CHECKOUT_STATE, "Checkout and payment", [control("e4", "Place order", "submit")]),
  screen(ORDER_DONE_STATE, "Order confirmed", []),
]);
