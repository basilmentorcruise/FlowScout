/**
 * Shared deterministic fixtures for the intent-inference suites (#55).
 * Builders for StateNode / StateEdge / StateGraph + a small budget factory.
 */
import type {
  StateNode,
  StateEdge,
  StateGraph,
  StateIdentity,
  CrawlBudget,
} from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";

export function id(raw: string): StateIdentity {
  return makeStateIdentity(raw);
}

export function node(overrides: Partial<StateNode> & { id: StateIdentity }): StateNode {
  return {
    label: "",
    platform: "ios",
    firstSeenAt: "2026-06-26T00:00:00.000Z",
    a11ySnapshot: "{}",
    screenshotUri: null,
    ...overrides,
  };
}

let edgeSeq = 0;
export function edge(
  overrides: Partial<StateEdge> & { fromId: StateIdentity; toId: StateIdentity },
): StateEdge {
  edgeSeq += 1;
  return {
    id: `edge-${String(edgeSeq)}`,
    actionType: "tap",
    actionPayload: "",
    observedAt: "2026-06-26T00:00:00.000Z",
    ...overrides,
  };
}

export function graph(nodes: readonly StateNode[], edges: readonly StateEdge[]): StateGraph {
  return {
    runId: "run-1",
    appId: "app-1",
    appVersion: "1.0.0",
    platform: "ios",
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges,
    duplicatePathNodeIds: new Set(),
  };
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

/** A labelled sign-in screen snapshot (used across tier-1 + eval scenarios). */
export const SIGN_IN_SNAPSHOT = JSON.stringify({
  role: "application",
  children: [
    { role: "staticText", label: "Sign In" },
    { role: "textField", label: "Email", value: "" },
    { role: "secureTextField", label: "Password", value: "" },
    { role: "button", label: "Log In" },
    { role: "link", label: "Forgot password" },
  ],
});

/** An icon-only / unlabelled screen (degraded tier-1). */
export const UNLABELLED_SNAPSHOT = JSON.stringify({
  role: "application",
  children: [{ role: "button" }, { role: "button" }],
});

/** A snapshot carrying a secret value + OTP-shaped text (redaction scenario). */
export const SECRET_SNAPSHOT = JSON.stringify({
  role: "application",
  children: [
    { role: "secureTextField", label: "Password", value: "hunter2-SECRET" },
    { role: "staticText", label: "Your code is 482913" },
  ],
});
