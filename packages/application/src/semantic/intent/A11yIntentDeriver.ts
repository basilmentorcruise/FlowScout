/**
 * A11yIntentDeriver — TIER 1 of intent inference (#55, ADR-0006 §3.2).
 *
 * Deterministic, ALWAYS runs, NO LLM. Derives a per-screen `purpose` and per-control
 * `intent`/`affordance` from the accessibility labels/roles/traits in the (already-REDACTED)
 * a11y skeleton plus the controls referenced by a node's outgoing edges.
 *
 * Resilience contract (PRD edge cases / ADR-0006 AC2):
 *   - Missing/empty labels ⇒ a DEGRADED-but-present intent (role + position), `source:"degraded"`.
 *   - NEVER emits an empty `purpose`/`intent`; NEVER throws (malformed JSON ⇒ degraded).
 *   - `confidence` is always null here (non-null only for `source:"llm"`).
 *
 * Pure: no LlmPort, no I/O, no SDK — fully testable with zero LLM (most coverage lives here,
 * by the cost-first design). Operates ONLY on the redacted snapshot it is handed.
 */
import type { StateNode, StateEdge, ScreenIntent, ControlIntent } from "@flowscout/domain";

/** Affordance classes derived from action type + control labels. */
const AFFORDANCE_NAVIGATION = "navigation";
const AFFORDANCE_SUBMIT = "submit";
const AFFORDANCE_INPUT = "input";
const AFFORDANCE_TOGGLE = "toggle";
const AFFORDANCE_DISMISS = "dismiss";
const AFFORDANCE_UNKNOWN = "unknown";

/** Label keywords (lower-cased substrings) that hint at a submit affordance. */
const SUBMIT_KEYWORDS = [
  "submit",
  "sign in",
  "log in",
  "login",
  "continue",
  "next",
  "confirm",
  "done",
  "save",
  "send",
];
/** Label keywords that hint at a dismiss/cancel affordance. */
const DISMISS_KEYWORDS = ["cancel", "close", "dismiss", "back", "skip"];
/** Label keywords that hint at a toggle affordance. */
const TOGGLE_KEYWORDS = ["toggle", "switch", "enable", "disable", "show", "hide"];

/** Roles that read as interactive buttons in an a11y tree. */
const BUTTON_ROLES = new Set(["button", "link", "tab", "menuitem"]);
/** Roles that read as text inputs. */
const INPUT_ROLES = new Set([
  "textField",
  "textfield",
  "searchField",
  "secureTextField",
  "textbox",
  "searchbox",
]);

/** A flattened, redacted a11y element used for tier-1 derivation. */
interface A11yElement {
  readonly label: string;
  readonly role: string;
  /** 1-based position in document order (for degraded "row N" fallbacks). */
  readonly position: number;
}

export class A11yIntentDeriver {
  /**
   * Derives a tier-1 `ScreenIntent` for a node and its outgoing edges.
   *
   * @param node            the StateNode (its `a11ySnapshot` MUST already be redacted).
   * @param redactedSnapshot the redacted a11y skeleton (parsed for labels/roles).
   * @param outgoingEdges   the node's outgoing edges = observed control affordances.
   *                        Each `actionPayload` MUST already be redacted (redactText).
   */
  derive(
    node: StateNode,
    redactedSnapshot: string,
    outgoingEdges: readonly StateEdge[],
  ): ScreenIntent {
    const elements = this.flatten(redactedSnapshot);
    const purpose = this.derivePurpose(node, elements);
    const screenHasSignal = purpose.source === "a11y";

    const controls = outgoingEdges.map((edge, idx) => this.deriveControl(edge, idx, elements));

    // The screen is "degraded" only if BOTH its purpose AND every control are degraded —
    // a labelled control still gives the screen real a11y signal.
    const anyControlSignal = controls.some((c) => c.source === "a11y");
    const source = screenHasSignal || anyControlSignal ? "a11y" : "degraded";

    return {
      stateId: node.id,
      purpose: purpose.text,
      source,
      confidence: null,
      controls,
    };
  }

  // ── Screen purpose ────────────────────────────────────────────────────────

  private derivePurpose(
    node: StateNode,
    elements: readonly A11yElement[],
  ): { text: string; source: "a11y" | "degraded" } {
    const label = node.label.trim();
    if (label.length > 0) {
      return { text: `${label} screen`, source: "a11y" };
    }

    // Fall back to the most prominent labelled heading/element on the screen.
    const heading = elements.find((el) => el.label.trim().length > 0);
    if (heading) {
      return { text: `${heading.label.trim()} screen`, source: "a11y" };
    }

    // Degraded: no labels anywhere — describe by element count/role, never empty.
    if (elements.length > 0) {
      const firstRole = elements[0]?.role ?? "view";
      return {
        text: `Unlabelled screen (${String(elements.length)} elements, e.g. ${firstRole})`,
        source: "degraded",
      };
    }
    return { text: "Unlabelled screen (no accessibility elements)", source: "degraded" };
  }

  // ── Per-control intent ────────────────────────────────────────────────────

  private deriveControl(
    edge: StateEdge,
    index: number,
    elements: readonly A11yElement[],
  ): ControlIntent {
    const label = this.controlLabel(edge, elements);
    const affordance = this.classifyAffordance(edge.actionType, label);

    if (label.length > 0) {
      return {
        edgeId: edge.id,
        actionType: edge.actionType,
        intent: this.composeIntent(affordance, label),
        affordance,
        source: "a11y",
        confidence: null,
      };
    }

    // Degraded: no label for this control — describe by action type + position.
    return {
      edgeId: edge.id,
      actionType: edge.actionType,
      intent: `${edge.actionType} control at position ${String(index + 1)}`,
      affordance,
      source: "degraded",
      confidence: null,
    };
  }

  /**
   * Resolves a human label for a control. Prefers a meaningful redacted payload, else matches
   * the element list by position, else empty (⇒ degraded).
   */
  private controlLabel(edge: StateEdge, elements: readonly A11yElement[]): string {
    const payload = edge.actionPayload.trim();
    if (payload.length > 0 && !this.looksLikeCoordinates(payload)) {
      return payload;
    }
    // Best-effort: associate input/tap edges with a labelled interactive element.
    const interactive = elements.find(
      (el) => el.label.trim().length > 0 && (BUTTON_ROLES.has(el.role) || INPUT_ROLES.has(el.role)),
    );
    return interactive?.label.trim() ?? "";
  }

  private composeIntent(affordance: string, label: string): string {
    switch (affordance) {
      case AFFORDANCE_SUBMIT:
        return `Submit: ${label}`;
      case AFFORDANCE_INPUT:
        return `Enter ${label}`;
      case AFFORDANCE_TOGGLE:
        return `Toggle ${label}`;
      case AFFORDANCE_DISMISS:
        return `Dismiss: ${label}`;
      case AFFORDANCE_NAVIGATION:
        return `Navigate to ${label}`;
      default:
        return `Activate ${label}`;
    }
  }

  private classifyAffordance(actionType: string, label: string): string {
    const lower = label.toLowerCase();
    if (actionType === "typeText") return AFFORDANCE_INPUT;
    if (this.matchesAny(lower, SUBMIT_KEYWORDS)) return AFFORDANCE_SUBMIT;
    if (this.matchesAny(lower, DISMISS_KEYWORDS)) return AFFORDANCE_DISMISS;
    if (this.matchesAny(lower, TOGGLE_KEYWORDS)) return AFFORDANCE_TOGGLE;
    if (actionType === "navigate") return AFFORDANCE_NAVIGATION;
    if (actionType === "tap" && label.length > 0) return AFFORDANCE_NAVIGATION;
    return AFFORDANCE_UNKNOWN;
  }

  private matchesAny(haystack: string, needles: readonly string[]): boolean {
    return needles.some((n) => haystack.includes(n));
  }

  private looksLikeCoordinates(payload: string): boolean {
    // e.g. "{"x":12,"y":34}" or "12,34" — not a human label.
    return /^[{[]/.test(payload) || /^\s*\d+\s*,\s*\d+\s*$/.test(payload);
  }

  // ── A11y flattening (resilient, redaction-respecting) ─────────────────────

  /**
   * Flattens a redacted a11y snapshot into a label/role/position list.
   * Best-effort + total: malformed JSON ⇒ empty list (caller degrades, never throws).
   */
  private flatten(redactedSnapshot: string): A11yElement[] {
    if (!redactedSnapshot || redactedSnapshot.trim().length === 0) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(redactedSnapshot);
    } catch {
      return [];
    }
    const out: A11yElement[] = [];
    const counter = { n: 0 };
    this.walk(parsed, out, counter);
    return out;
  }

  private walk(node: unknown, out: A11yElement[], counter: { n: number }): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) this.walk(item, out, counter);
      return;
    }
    const obj = node as Record<string, unknown>;
    const label = this.readLabel(obj);
    const role = this.readRole(obj);
    if (label.length > 0 || role.length > 0) {
      counter.n += 1;
      out.push({ label, role, position: counter.n });
    }
    const children = obj["children"];
    if (Array.isArray(children)) {
      for (const child of children) this.walk(child, out, counter);
    }
  }

  private readLabel(obj: Record<string, unknown>): string {
    for (const field of ["label", "accessibilityLabel", "name", "title", "text", "placeholder"]) {
      // eslint-disable-next-line security/detect-object-injection -- field from a fixed allowlist
      const v = obj[field];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
    return "";
  }

  private readRole(obj: Record<string, unknown>): string {
    for (const field of ["role", "type"]) {
      // eslint-disable-next-line security/detect-object-injection -- field from a fixed allowlist
      const v = obj[field];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
    return "";
  }
}
