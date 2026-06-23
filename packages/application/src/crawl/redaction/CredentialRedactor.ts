/**
 * CredentialRedactor — single redaction boundary for the crawl engine (#37 / E2.7).
 *
 * Applied at the snapshot source, BEFORE any sink (state graph, events, cache, LLM prompt).
 * This is the TB-A (redaction boundary) from the E2 threat model (T3/T7/T8).
 *
 * Security invariants:
 *   - ONE entry point: `redact(raw: A11ySnapshot)` — applied immediately after
 *     `driver.snapshotAccessibilityTree()` before any downstream processing.
 *   - `redactText(raw: string)` — applied to typeText payloads before edge/event recording.
 *   - Named pattern constants (no magic literals).
 *
 * Port-only: no adapter/SDK imports (T10/NFR1).
 */
import type { A11ySnapshot } from "@flowscout/domain";

// ── Redaction pattern constants (named, no magic literals) ────────────────────

/** Marks a redacted credential/OTP value in the output (T7: metadata only). */
export const REDACTED_MARKER = "[REDACTED]";

/**
 * OTP-shaped token pattern: 4–8 consecutive digits (typical OTP / PIN length).
 * Matches common OTP formats without being so broad as to redact unrelated numbers.
 */
const OTP_DIGIT_PATTERN = /\b\d{4,8}\b/g;

/**
 * JSON field names whose values should always be redacted in snapshot text.
 * Covers common accessibility field names used for credential inputs.
 */
const SECURE_FIELD_NAMES = new Set([
  "password",
  "passcode",
  "otp",
  "pin",
  "secret",
  "credential",
  "token",
  "authcode",
  "verificationcode",
  "onetimecode",
]);

/**
 * Accessibility role / trait values that identify secure-entry fields.
 */
const SECURE_ROLES = new Set(["secureTextField", "passwordField"]);

// ── CredentialRedactor ────────────────────────────────────────────────────────

/**
 * CredentialRedactor — the single redaction chokepoint.
 *
 * Instantiated once per crawl run and injected via CrawlCollaborators.
 * Pure: no I/O, no randomness, deterministic output. Unit-testable in isolation.
 */
export class CredentialRedactor {
  /**
   * Redacts credential/OTP/PII content from an a11y snapshot.
   *
   * Strategy:
   *   1. Parse as JSON (best-effort; if non-JSON, apply text-level redaction).
   *   2. Walk the node tree; for secure nodes, redact value fields.
   *   3. Re-serialise to JSON.
   */
  redact(raw: A11ySnapshot): A11ySnapshot {
    if (!raw || raw.trim().length === 0) {
      return raw;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      const redacted = this.redactNode(parsed);
      return JSON.stringify(redacted) as A11ySnapshot;
    } catch {
      // Non-JSON snapshot: apply text-level OTP masking to the raw string
      return this.redactRawText(raw) as A11ySnapshot;
    }
  }

  /**
   * Redacts credential/OTP text from a plain string (e.g. typeText actionPayload value).
   *
   * The application calls this on the `text` field of a typeText payload before recording
   * it into the edge `actionPayload` or `ActionTakenEvent`. The real text is still sent
   * to the driver — only the recorded form is redacted (T7/T8).
   */
  redactText(raw: string): string {
    if (!raw) return raw;

    // If the entire string is OTP-shaped → fully redact
    if (/^\d{4,8}$/.test(raw.trim()) || /^\d{3,4}[- ]\d{3,4}$/.test(raw.trim())) {
      return REDACTED_MARKER;
    }

    // Mask embedded OTP sequences
    return raw.replace(OTP_DIGIT_PATTERN, REDACTED_MARKER);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private redactNode(node: unknown): unknown {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item: unknown) => this.redactNode(item));

    const obj = node as Record<string, unknown>;
    const isSecure = this.isSecureNode(obj);
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.redactField(key, value, isSecure);
    }

    return result;
  }

  private redactField(key: string, value: unknown, isSecure: boolean): unknown {
    if (key === "children" && Array.isArray(value)) {
      return value.map((child: unknown) => this.redactNode(child));
    }
    if (isSecure && this.isValueField(key)) {
      return typeof value === "string" && value.length > 0 ? REDACTED_MARKER : value;
    }
    if (key === "value" && typeof value === "string") {
      return this.maskOtpValue(value);
    }
    return value;
  }

  /** Determines if a node is a secure-entry field based on structural attributes. */
  private isSecureNode(obj: Record<string, unknown>): boolean {
    return (
      this.hasSecureRole(obj) ||
      obj["secureTextEntry"] === true ||
      obj["isSecureTextEntry"] === true ||
      this.hasSecureLabel(obj)
    );
  }

  private hasSecureRole(obj: Record<string, unknown>): boolean {
    const role = obj["role"];
    const type = obj["type"];
    return (
      (typeof role === "string" && SECURE_ROLES.has(role)) ||
      (typeof type === "string" && SECURE_ROLES.has(type))
    );
  }

  private hasSecureLabel(obj: Record<string, unknown>): boolean {
    const labelFields = ["label", "placeholder", "accessibilityLabel", "name", "id"];
    for (const field of labelFields) {
      // eslint-disable-next-line security/detect-object-injection -- field is from a fixed array
      const fieldVal = obj[field];
      if (typeof fieldVal === "string") {
        const lower = fieldVal.toLowerCase();
        for (const secureName of SECURE_FIELD_NAMES) {
          if (lower.includes(secureName.toLowerCase())) return true;
        }
      }
    }
    return false;
  }

  /** Returns true if this key is a value-bearing field that should be redacted on secure nodes. */
  private isValueField(key: string): boolean {
    return key === "value" || key === "text" || key === "currentValue";
  }

  /** Masks OTP-shaped digit sequences in a value string. */
  private maskOtpValue(value: string): string {
    if (/^\d{4,8}$/.test(value.trim())) {
      return REDACTED_MARKER;
    }
    return value;
  }

  /** Text-level redaction fallback for non-JSON snapshots. */
  private redactRawText(raw: string): string {
    return raw.replace(OTP_DIGIT_PATTERN, REDACTED_MARKER);
  }
}
