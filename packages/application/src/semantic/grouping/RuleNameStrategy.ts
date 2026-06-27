/**
 * RuleNameStrategy — TIER 1 of naming/grouping (#56, ADR-0007 §3.2).
 *
 * DETERMINISTIC, always-runs, NO LLM. Derives a human-readable `name`/`description` and a
 * provisional `featureGroup` for one workflow from its steps + the (already-redacted) screen
 * purposes / control intents joined from the consumed `IntentModel`. Richer than the
 * extractor's label-only provisional name, but never empty and never throwing.
 *
 * Provenance: a rule-derived labeling carries `confidence: null` (the "confidence non-null IFF
 * LLM" rule shared with `intent.ts`/`workflow.ts`). Missing intent ⇒ the workflow's existing
 * provisional name/description stand and `featureGroup = "Ungrouped"`.
 *
 * Pure: operates only on the passed (already-redacted) signal. No I/O, no SDK, no LlmPort —
 * so the bulk of #56's logic is fully testable with zero LLM (ADR-0007 §4).
 */
import type { StateIdentity, Workflow, WorkflowLabeling } from "@flowscout/domain";
import { UNGROUPED } from "./GroupingConfig.js";

/** The redacted semantic signal for one screen, joined from the consumed `IntentModel`. */
export interface RedactedScreenSignal {
  /** The screen's one-line purpose (already redacted). May be empty if no intent. */
  readonly purpose: string;
  /** The redacted intents of the screen's controls. */
  readonly controlIntents: readonly string[];
}

/** Tier-1 output for one workflow: the labeling plus whether it is weak (drives tier-2 gating). */
export interface RuleLabelingResult {
  readonly labeling: WorkflowLabeling;
  /** True when signal was thin — name fell back to provisional OR group is "Ungrouped". */
  readonly weak: boolean;
}

/** Max chars of a derived workflow name (token bound + report readability; no magic literals). */
export const MAX_NAME_CHARS = 120;
/** Max chars of a derived workflow description. */
export const MAX_DESCRIPTION_CHARS = 280;

/**
 * Ordered feature-group classification rules. The FIRST group whose any keyword appears in the
 * lowercased screen/control signal wins — deterministic (order-stable). Add groups by appending;
 * never reorder existing entries without an ADR (it changes historical labels).
 */
export const FEATURE_GROUP_RULES: readonly {
  readonly group: string;
  readonly keywords: readonly string[];
}[] = [
  {
    group: "Authentication",
    keywords: [
      "sign in",
      "sign-in",
      "signin",
      "log in",
      "login",
      "log-in",
      "sign up",
      "signup",
      "register",
      "password",
      "passcode",
      "credential",
      "authenticate",
      "two-factor",
      "verification code",
    ],
  },
  {
    group: "Cart & Checkout",
    keywords: [
      "cart",
      "checkout",
      "check out",
      "payment",
      "pay ",
      "billing",
      "shipping",
      "place order",
      "purchase",
      "buy ",
    ],
  },
  {
    group: "Search & Browse",
    keywords: ["search", "browse", "filter", "sort by", "catalog", "explore", "discover"],
  },
  {
    group: "Onboarding",
    keywords: ["onboarding", "welcome", "get started", "tutorial", "carousel", "next slide"],
  },
  {
    group: "Profile & Settings",
    keywords: ["profile", "settings", "preferences", "account", "edit profile"],
  },
  {
    group: "Messaging",
    keywords: ["message", "chat", "inbox", "conversation", "compose"],
  },
  {
    group: "Media",
    keywords: ["play ", "video", "photo", "gallery", "media", "stream"],
  },
];

export class RuleNameStrategy {
  /**
   * Derives a deterministic labeling for one workflow from the redacted screen signal.
   *
   * @param workflow  the frozen extractor workflow (its `id`/`steps` are invariant).
   * @param signals   redacted screen signal keyed by `StateIdentity` (already redacted upstream).
   */
  derive(
    workflow: Workflow,
    signals: ReadonlyMap<StateIdentity, RedactedScreenSignal>,
  ): RuleLabelingResult {
    const purposes = this.orderedPurposes(workflow, signals);
    const classText = this.classificationText(workflow, signals);
    const featureGroup = this.classifyGroup(classText) ?? UNGROUPED;

    const name =
      purposes.length > 0
        ? cap(purposes.join(" → "), MAX_NAME_CHARS)
        : nonEmpty(workflow.name, "Workflow");
    const description =
      purposes.length > 0
        ? cap(
            `${String(purposes.length)} screen(s): ${purposes.join(" → ")}`,
            MAX_DESCRIPTION_CHARS,
          )
        : nonEmpty(workflow.description, name);

    const weak = purposes.length === 0 || featureGroup === UNGROUPED;

    return {
      labeling: { name, description, featureGroup, confidence: null },
      weak,
    };
  }

  /** Ordered, de-duplicated non-empty screen purposes along the workflow's steps. */
  private orderedPurposes(
    workflow: Workflow,
    signals: ReadonlyMap<StateIdentity, RedactedScreenSignal>,
  ): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const step of workflow.steps) {
      const purpose = signals.get(step.stateId)?.purpose.trim();
      if (purpose && purpose.length > 0 && !seen.has(purpose)) {
        seen.add(purpose);
        out.push(purpose);
      }
    }
    return out;
  }

  /** Lowercased join of every purpose + control intent + step description for group matching. */
  private classificationText(
    workflow: Workflow,
    signals: ReadonlyMap<StateIdentity, RedactedScreenSignal>,
  ): string {
    const parts: string[] = [];
    for (const step of workflow.steps) {
      parts.push(step.description);
      const signal = signals.get(step.stateId);
      if (signal) {
        parts.push(signal.purpose);
        parts.push(...signal.controlIntents);
      }
    }
    parts.push(workflow.name);
    return parts.join(" ").toLowerCase();
  }

  /** First feature group whose any keyword appears in the text; null if none match. */
  private classifyGroup(text: string): string | null {
    for (const rule of FEATURE_GROUP_RULES) {
      if (rule.keywords.some((kw) => text.includes(kw))) {
        return rule.group;
      }
    }
    return null;
  }
}

/** Truncates to `max` chars on a word-ish boundary (deterministic). */
function cap(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** Returns `value` trimmed, or the fallback if `value` is blank. Never empty. */
function nonEmpty(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
