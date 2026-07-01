/**
 * Codec primitives — shared, prototype-pollution-safe decode helpers (ADR-0008 §5).
 *
 * Every codec `decode` rebuilds aggregates EXCLUSIVELY through these helpers:
 *   - fields are read by explicit allow-listed key (never copied by iterating
 *     attacker-influenceable payload keys onto a live object),
 *   - `__proto__` / `constructor` / `prototype` are rejected wherever a payload
 *     key IS iterated (M83.3 / T5),
 *   - no `eval`, no `new Function`, no `JSON.parse` reviver — plain bounded parse.
 *
 * Values are persisted RAW and inert (M83.8 / T7): these helpers validate types
 * only — they never escape, trim, or otherwise transform string content.
 */

/** Typed failure for a corrupt/unexpected payload (never a raw TypeError from deep access). */
export class PayloadCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadCodecError";
  }
}

/** Keys that must never be trusted from a payload when iterating (T5 / CWE-1321). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** True when a payload-supplied key is safe to use in an iteration-based rebuild. */
export function isSafePayloadKey(key: string): boolean {
  return !FORBIDDEN_KEYS.has(key);
}

/** Parse payload text into an untyped record — plain `JSON.parse`, no reviver (M83.3). */
export function parsePayload(payload: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new PayloadCodecError("payload is not valid JSON");
  }
  return asRecord(parsed, "payload root");
}

/** Narrow an unknown value to a plain (non-array) object record. */
export function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PayloadCodecError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Narrow an unknown value to an array. */
export function asArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PayloadCodecError(`${context} must be an array`);
  }
  return value;
}

/** Read a required string field (raw — no transform). */
export function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new PayloadCodecError(`field "${key}" must be a string`);
  }
  return value;
}

/** Read a string-or-null field. */
export function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new PayloadCodecError(`field "${key}" must be a string or null`);
  }
  return value;
}

/** Read a required finite-number field. */
export function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PayloadCodecError(`field "${key}" must be a finite number`);
  }
  return value;
}

/** Read a required boolean field. */
export function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new PayloadCodecError(`field "${key}" must be a boolean`);
  }
  return value;
}
