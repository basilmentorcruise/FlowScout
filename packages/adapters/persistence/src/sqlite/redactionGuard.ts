/**
 * Save-time redaction guard (M83.5 SHOULD — defense-in-depth, T1/NFR4).
 *
 * Redaction is enforced UPSTREAM (E2 `CredentialRedactor` at TB-A) — the graph this
 * store receives is already clean. This guard is a cheap last-line scan, NOT a second
 * redactor: before a graph write, every node's a11y snapshot is checked for a
 * secure-text field whose value is neither the upstream `[REDACTED]` marker nor
 * empty. A hit fails the save with a typed error (the transaction never commits),
 * so a future upstream regression cannot silently become cleartext-at-rest.
 *
 * The scan only READS parsed JSON (bounded depth, no key copying) — it never
 * transforms, logs, or echoes payload content (no new sink, T1).
 */
import type { StateNode } from "@flowscout/domain";

/** Upstream redaction marker (kept in sync with E2's CredentialRedactor by test). */
const REDACTED_MARKER = "[REDACTED]";

/** a11y role whose value is credential material by definition. */
const SECURE_FIELD_ROLE = "secureTextField";

/** Defensive recursion bound for pathological/adversarial a11y trees. */
const MAX_SCAN_DEPTH = 64;

/** Typed failure: an un-redacted secure-field value reached the store boundary. */
export class UnredactedSecretError extends Error {
  constructor(nodeId: string) {
    // Deliberately does NOT include the offending value (no new sink — T1).
    super(
      `refusing to persist state node "${nodeId}": a secure-text field carries an ` +
        `un-redacted value (upstream redaction regression — NFR4)`,
    );
    this.name = "UnredactedSecretError";
  }
}

function isUnredactedSecureField(record: Record<string, unknown>): boolean {
  if (record["role"] !== SECURE_FIELD_ROLE) return false;
  const value = record["value"];
  return typeof value === "string" && value.length > 0 && value !== REDACTED_MARKER;
}

function scan(value: unknown, depth: number): boolean {
  if (depth > MAX_SCAN_DEPTH || value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => scan(entry, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (isUnredactedSecureField(record)) return true;
  return Object.values(record).some((entry) => scan(entry, depth + 1));
}

/**
 * Throw `UnredactedSecretError` if any node's a11y snapshot contains a secure-text
 * field with a non-empty, non-`[REDACTED]` value. Non-JSON snapshots are skipped
 * (nothing structured to scan).
 */
export function assertNoUnredactedSecureField(nodes: Iterable<StateNode>): void {
  for (const node of nodes) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(node.a11ySnapshot);
    } catch {
      continue;
    }
    if (scan(parsed, 0)) {
      throw new UnredactedSecretError(node.id);
    }
  }
}
