/**
 * Opaque keyset-pagination cursor over (startedAt, id) — ADR-0008 §4, M83.4 / T4.
 *
 * The token is base64url of a tiny JSON record. Decode is DEFENSIVE:
 *   - length-bounded up front (rejects oversized input early),
 *   - plain bounded `JSON.parse` (no eval / Function / reviver),
 *   - shape + field types validated AFTER parse,
 *   - ANY failure ⇒ `null` (callers treat it as the first page) — never a throw.
 * Decoded values flow ONLY into bound `?` parameters (M83.1 / T3), never into
 * SQL text.
 */

/** Defensive upper bound on accepted cursor tokens (T4 — reject oversized input early). */
const MAX_CURSOR_LENGTH = 512;

/** The two keyset scalars a cursor encodes (the last row of the previous page). */
export interface RunPageCursor {
  readonly startedAt: string;
  readonly id: string;
}

/** Encode the keyset position of the last row on a page into an opaque token. */
export function encodeRunPageCursor(position: RunPageCursor): string {
  const token = JSON.stringify({ s: position.startedAt, i: position.id });
  return Buffer.from(token, "utf8").toString("base64url");
}

/**
 * Defensively decode an opaque cursor token.
 * Malformed / oversized / wrongly-typed input ⇒ `null` (first page), never a throw.
 */
export function decodeRunPageCursor(raw: string | null | undefined): RunPageCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) {
    return null;
  }
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const startedAt = record["s"];
    const id = record["i"];
    if (typeof startedAt !== "string" || typeof id !== "string") {
      return null;
    }
    return { startedAt, id };
  } catch {
    return null;
  }
}
