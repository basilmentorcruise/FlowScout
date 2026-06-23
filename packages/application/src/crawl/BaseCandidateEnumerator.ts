/**
 * BaseCandidateEnumerator — derives base CandidateAction candidates from an a11y snapshot.
 *
 * This is the pure collaborator that converts the observed A11ySnapshot into base-level
 * CandidateActions (tap/typeText on visible elements) BEFORE probes add their candidates.
 *
 * Design (§2 of E2.7 plan):
 *   - Kept as a tiny, independently-testable pure unit.
 *   - Default: `defaultEnumerateBaseCandidates` — pure fn, no I/O.
 *   - Injectable for testing (FakeEnumerator can provide synthetic candidates).
 *
 * The enumeration strategy:
 *   - Parse the a11y snapshot as JSON (best-effort; degrade gracefully on failure).
 *   - Walk the element tree; emit a `tap` candidate for each interactive element.
 *   - For text-entry fields (role: textField, searchField, textView), also emit a `typeText` stub.
 *   - Deduplicate by elementId (structural stability).
 *
 * Port-only: no adapter/SDK imports (T10/NFR1).
 */
import type { A11ySnapshot, CandidateAction } from "@flowscout/domain";

// ── Type for the enumerator function ─────────────────────────────────────────

/** A function that converts an a11y snapshot into base candidate actions. */
export type BaseCandidateEnumeratorFn = (snapshot: A11ySnapshot) => readonly CandidateAction[];

// ── Interactive role sets (named constants) ───────────────────────────────────

/** Roles that produce a `tap` candidate. */
const TAPPABLE_ROLES = new Set([
  "button",
  "cell",
  "link",
  "menuItem",
  "tab",
  "switch",
  "checkbox",
  "radio",
  "segmentedControl",
  "picker",
  "pickerWheel",
  "image", // may be tappable when inside a button
  "other", // catch-all for custom controls
]);

/** Roles that produce both `tap` and `typeText` candidates. */
const TEXT_ENTRY_ROLES = new Set(["textField", "searchField", "textView"]);

/** Maximum candidates per enumeration (bounds prompt size, T3/T11). */
const MAX_CANDIDATES_PER_SCREEN = 20;

// ── Default enumerator implementation ────────────────────────────────────────

/**
 * Enumerates base CandidateActions from a (redacted) a11y snapshot.
 *
 * This is the default BaseCandidateEnumeratorFn injected by defaultCollaborators().
 * It is a pure function — no I/O, deterministic, unit-testable.
 *
 * Degrades gracefully: if the snapshot is empty or non-JSON, returns [].
 */
export function defaultEnumerateBaseCandidates(snapshot: A11ySnapshot): readonly CandidateAction[] {
  if (!snapshot || snapshot.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    // Non-JSON snapshot — cannot enumerate structurally; degrade to empty
    return [];
  }

  const candidates: CandidateAction[] = [];
  const seen = new Set<string>();

  walkNode(parsed, candidates, seen);

  return candidates.slice(0, MAX_CANDIDATES_PER_SCREEN);
}

// ── Tree walker ───────────────────────────────────────────────────────────────

function walkNode(node: unknown, candidates: CandidateAction[], seen: Set<string>): void {
  if (node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) {
      walkNode(item, candidates, seen);
    }
    return;
  }

  const obj = node as Record<string, unknown>;
  emitCandidatesForNode(obj, candidates, seen);

  if (Array.isArray(obj["children"])) {
    for (const child of obj["children"] as unknown[]) {
      walkNode(child, candidates, seen);
    }
  }
}

/** Emits tap/typeText candidates for a single a11y node (if interactive and not hidden). */
function emitCandidatesForNode(
  obj: Record<string, unknown>,
  candidates: CandidateAction[],
  seen: Set<string>,
): void {
  const role = typeof obj["role"] === "string" ? obj["role"] : null;
  const id = typeof obj["id"] === "string" ? obj["id"] : null;
  const isHidden = obj["hidden"] === true || obj["isHidden"] === true;

  if (isHidden || role === null || id === null || seen.has(id)) return;

  const label = typeof obj["label"] === "string" ? obj["label"] : "";
  const tapPayload = JSON.stringify({ elementId: id });
  const tapKey = `tap::${tapPayload}`;

  emitRoleCandidates(role, id, label, tapPayload, tapKey, candidates, seen);
}

/** Dispatches candidate emission based on the element's role. */
function emitRoleCandidates(
  role: string,
  id: string,
  label: string,
  tapPayload: string,
  tapKey: string,
  candidates: CandidateAction[],
  seen: Set<string>,
): void {
  if (TAPPABLE_ROLES.has(role)) {
    emitTapCandidate(id, role, label, tapPayload, tapKey, candidates, seen);
  }
  if (TEXT_ENTRY_ROLES.has(role)) {
    emitTextEntryCandidates(id, role, label, tapPayload, tapKey, candidates, seen);
  }
}

function emitTapCandidate(
  id: string,
  role: string,
  label: string,
  tapPayload: string,
  tapKey: string,
  candidates: CandidateAction[],
  seen: Set<string>,
): void {
  if (seen.has(tapKey)) return;
  seen.add(id);
  seen.add(tapKey);
  candidates.push({
    actionType: "tap",
    actionPayload: tapPayload,
    rationale: `tap ${role}${label ? `: ${label}` : ""} (id=${id})`,
  });
}

function emitTextEntryCandidates(
  id: string,
  role: string,
  label: string,
  tapPayload: string,
  tapKey: string,
  candidates: CandidateAction[],
  seen: Set<string>,
): void {
  const typeKey = `typeText::${tapPayload}`;
  if (!seen.has(typeKey)) {
    seen.add(typeKey);
    // typeText stub: the text value is a placeholder; the policy/user fills it
    candidates.push({
      actionType: "typeText",
      actionPayload: JSON.stringify({ elementId: id, text: "" }),
      rationale: `typeText into ${role}${label ? `: ${label}` : ""} (id=${id})`,
    });
  }
  if (!seen.has(tapKey)) {
    seen.add(tapKey);
    candidates.push({
      actionType: "tap",
      actionPayload: tapPayload,
      rationale: `tap ${role}${label ? `: ${label}` : ""} to focus (id=${id})`,
    });
  }
}
