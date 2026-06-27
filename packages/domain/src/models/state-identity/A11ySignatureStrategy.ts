/**
 * A11ySignatureStrategy — the default StateIdentityStrategy for E2.
 *
 * Algorithm (per ADR-0004 §2.2):
 * 1. Parse A11ySnapshot (JSON); on parse failure → degraded path.
 * 2. Project each node to a structural token: (role, stable-key).
 *    stable-key priority: accessibilityIdentifier / testId > normalized label > role only.
 *    Drop pure-value leaf text nodes carrying no role.
 * 3. Normalize labels to suppress volatile content:
 *    - digit runs → "#"
 *    - ISO/clock timestamps → "<ts>"
 *    - currency amounts / percentages → "<num>"
 *    - Drop StaticText/label-only leaf nodes entirely (they carry content, not structure).
 * 4. Build a canonical, order-significant, depth-bounded skeleton with repeated siblings collapsed.
 *    SHA-256 → StateIdentity.
 * 5. Degraded path: makeStateIdentity("degraded:" + sha256(rawTruncated)).
 *
 * Security: never logs raw a11y bodies (NFR5/T7). Pure domain logic — no I/O, no adapter imports.
 */
import { createHash } from "node:crypto";
import type { StateIdentityInput, StateIdentityStrategy } from "../../ports/StateIdentityPort.js";
import { makeStateIdentity } from "../state-graph.js";
import type { StateIdentity } from "../state-graph.js";

// ---------------------------------------------------------------------------
// Configuration constants (named, no magic numbers — ADR-0001 §6)
// ---------------------------------------------------------------------------

/** Maximum tree depth to serialize (beyond this, nodes are omitted). */
const MAX_DEPTH = 10;

/**
 * Maximum number of identical-role-pattern sibling rows to include before collapsing.
 * E.g. 200 chat rows and 3 chat rows hash the same.
 */
const MAX_SIBLING_ROWS = 3;

/** Maximum raw snapshot length accepted before forcing the degraded path (DoS guard, T11). */
const MAX_SNAPSHOT_BYTES = 500_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A parsed a11y node (JSON object with optional fields). */
interface A11yNode {
  type?: string;
  role?: string;
  label?: string;
  value?: string;
  accessibilityIdentifier?: string;
  testId?: string;
  children?: A11yNode[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Regex patterns for volatile content. */
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;
const CLOCK_TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?\b/g;
const CURRENCY_RE = /[$€£¥]\s*\d+(?:[.,]\d+)*/g;
const PERCENTAGE_RE = /\b\d+(?:\.\d+)?%/g;
// Digit run: sequence of 2+ digits not already replaced (leave single digits; replace multi).
const DIGIT_RUN_RE = /\b\d{2,}\b/g;

/**
 * Normalize a label string to suppress volatile content.
 * Order matters: timestamps first (contain digits), then currency/%, then digit runs.
 * Security: this is the same redaction pass used to suppress graph-explosion on dynamic screens (T6).
 */
function normalizeLabel(raw: string): string {
  return raw
    .replace(ISO_TIMESTAMP_RE, "<ts>")
    .replace(CLOCK_TIME_RE, "<ts>")
    .replace(CURRENCY_RE, "<num>")
    .replace(PERCENTAGE_RE, "<num>")
    .replace(DIGIT_RUN_RE, "#");
}

// ---------------------------------------------------------------------------
// Structural token extraction
// ---------------------------------------------------------------------------

/** Roles that carry only content/value, not structure — dropped from the skeleton. */
const CONTENT_ONLY_ROLES = new Set(["StaticText", "Text", "Label"]);

/**
 * Extract the role string from a node.
 * Prefers `type` (XCUITest convention) over `role` (W3C a11y).
 */
function extractRole(node: A11yNode): string {
  return node.type ?? node.role ?? "Unknown";
}

/**
 * Extract the stable key from a node.
 * Priority: accessibilityIdentifier / testId > normalized label > role.
 * The stable key is used for structural identity, NOT content identity.
 */
function extractStableKey(node: A11yNode, role: string): string {
  if (node.accessibilityIdentifier) return node.accessibilityIdentifier;
  if (node.testId) return node.testId;
  const raw = node.label ?? node.value ?? null;
  if (raw) return normalizeLabel(raw);
  return role;
}

/**
 * Returns true if the node is a content-only leaf that should be dropped.
 * A node is content-only if it has a content-only role AND no stable accessibility id.
 */
function isContentOnlyLeaf(node: A11yNode, role: string): boolean {
  if (!CONTENT_ONLY_ROLES.has(role)) return false;
  // If it has an explicit accessibility identifier, keep it (it's structurally meaningful).
  if (node.accessibilityIdentifier || node.testId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Skeleton builder
// ---------------------------------------------------------------------------

/**
 * Build a canonical depth-bounded structural skeleton string.
 * Repeated sibling runs of the same role-token are collapsed to MAX_SIBLING_ROWS occurrences.
 */
function buildSkeleton(node: A11yNode, depth: number): string {
  if (depth > MAX_DEPTH) return "";

  const role = extractRole(node);
  if (isContentOnlyLeaf(node, role)) return "";

  const stableKey = extractStableKey(node, role);
  const token = `[${role}:${stableKey}]`;

  const rawChildren = Array.isArray(node.children) ? node.children : [];
  if (rawChildren.length === 0) return token;

  // Collapse repeated siblings: group consecutive same-role children, keep first MAX_SIBLING_ROWS.
  const collapsedChildren: A11yNode[] = [];
  let runRole = "";
  let runCount = 0;

  for (const child of rawChildren) {
    const childRole = extractRole(child);
    if (childRole === runRole) {
      runCount++;
      if (runCount <= MAX_SIBLING_ROWS) {
        collapsedChildren.push(child);
      }
      // else: skip — sibling collapse in effect
    } else {
      runRole = childRole;
      runCount = 1;
      collapsedChildren.push(child);
    }
  }

  const childSkeletons = collapsedChildren
    .map((child) => buildSkeleton(child, depth + 1))
    .filter((s) => s.length > 0)
    .join(",");

  return childSkeletons.length > 0 ? `${token}{${childSkeletons}}` : token;
}

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Public skeleton projection (additive extract — E3.5 / #58)
// ---------------------------------------------------------------------------

/**
 * Project an a11y snapshot string to its NORMALIZED structural skeleton — the SAME projection
 * `identify` hashes for the E2 state identity (volatile content suppressed, siblings collapsed,
 * depth-bounded). Returns the empty string for any input that `identify` treats as DEGRADED
 * (empty / oversized / unparseable / non-object / structurally empty).
 *
 * Additive extract (ADR-0005 §10): the existing private `buildSkeleton` is exposed for the E3.5
 * embedding pass to embed the NORMALIZED skeleton (not the raw redacted snapshot — load-bearing for
 * the recall-floor merge). `identify` delegates to this function, so the identity hash is
 * BYTE-FOR-BYTE UNCHANGED (covered by the existing #34 identity tests). The caller (#58 orchestrator)
 * passes the ALREADY-REDACTED snapshot — redaction stays the caller's responsibility (T1/T7).
 */
export function projectA11ySkeleton(snapshot: string): string {
  // Empty / whitespace ⇒ degraded ⇒ no skeleton (the caller falls back to a11y-only).
  if (!snapshot || snapshot.trim().length === 0) return "";
  // Oversized ⇒ degraded (DoS guard, T11) ⇒ no skeleton.
  if (snapshot.length > MAX_SNAPSHOT_BYTES) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return "";
  }
  // Must be a plain object (not array, null, primitive).
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";

  return buildSkeleton(parsed as A11yNode, 0);
}

// ---------------------------------------------------------------------------
// Strategy implementation
// ---------------------------------------------------------------------------

/**
 * A11ySignatureStrategy — default StateIdentityStrategy.
 * See module-level doc for the full algorithm.
 */
export class A11ySignatureStrategy implements StateIdentityStrategy {
  identify(input: StateIdentityInput): StateIdentity {
    const raw: string = input.a11ySnapshot;

    // --- Degraded path: empty / oversized ---
    if (!raw || raw.trim().length === 0) {
      return this._degraded(raw);
    }
    if (raw.length > MAX_SNAPSHOT_BYTES) {
      return this._degraded(raw.slice(0, MAX_SNAPSHOT_BYTES));
    }

    // --- Project skeleton (shared with the E3.5 embedding pass) + hash ---
    // Delegates to `projectA11ySkeleton`: parse → object-check → build skeleton. An empty result
    // (parse failure / non-object / structurally empty) → degraded. Byte-for-byte unchanged.
    const skeleton = projectA11ySkeleton(raw);
    if (!skeleton) {
      return this._degraded(raw);
    }

    const hash = sha256Hex(skeleton);
    return makeStateIdentity(hash);
  }

  /** Degraded path: stable id keyed to the raw content so distinct bad inputs differ. */
  private _degraded(raw: string): StateIdentity {
    const hash = sha256Hex(raw);
    return makeStateIdentity(`degraded:${hash}`);
  }
}
