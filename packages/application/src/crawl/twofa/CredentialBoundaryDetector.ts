/**
 * CredentialBoundaryDetector — detects credential/2FA surfaces in the crawl (#37 / E2.7).
 *
 * Pure structural detector: inspects the (already-redacted) a11y snapshot to determine
 * if the current screen is a credential/2FA surface. No values are read out — detection
 * is based on field roles, secure-entry traits, OTP-input patterns, and label heuristics.
 *
 * Security invariants (T8):
 *   - Works on the REDACTED snapshot (credentials already masked by CredentialRedactor).
 *   - Emits NO credential values — only promptType + a redacted message.
 *   - Detection is structural (field roles / traits) — does NOT parse field values.
 *   - On detection: engine stops before `decide()` so no credential surface reaches the LLM.
 *
 * Port-only: no adapter/SDK imports (T10/NFR1).
 */
import type { A11ySnapshot } from "@flowscout/domain";

// ── Detection result ──────────────────────────────────────────────────────────

/** The type of credential surface detected. */
export type CredentialPromptType = "2fa-otp" | "password" | "username";

/** Result when a credential surface is detected. */
export interface CredentialBoundaryResult {
  readonly isCredentialSurface: true;
  readonly promptType: CredentialPromptType;
}

/** Result when no credential surface is detected. */
export interface NoBoundaryResult {
  readonly isCredentialSurface: false;
}

export type DetectionResult = CredentialBoundaryResult | NoBoundaryResult;

// ── Structural detection patterns (named constants, no magic literals) ─────────

/** Role values that indicate a secure (password/credential) text entry field. */
const SECURE_ENTRY_ROLES = new Set(["secureTextField", "passwordField"]);

/** Label patterns (lowercase) that indicate a password field. */
const PASSWORD_LABEL_PATTERNS = ["password", "passcode", "passphrase", "secret"];

/** Label patterns (lowercase) that indicate a 2FA/OTP field. */
const OTP_LABEL_PATTERNS = [
  "otp",
  "one-time",
  "one time",
  "verification code",
  "verification",
  "auth code",
  "authentication code",
  "2fa",
  "two-factor",
  "two factor",
  "passcode",
  "sms code",
  "pin",
];

/** Label patterns (lowercase) that indicate a username field. */
const USERNAME_LABEL_PATTERNS = ["username", "email", "phone number", "mobile", "login", "sign in"];

// Minimum number of secure/credential-looking fields to consider a surface a credential surface.
// A single "username" field alone is not necessarily a credential surface — we require either
// a secure-entry field, an OTP field, or username+password combination.
const MIN_SECURE_FIELDS_FOR_DETECTION = 1;

// ── CredentialBoundaryDetector ────────────────────────────────────────────────

/**
 * CredentialBoundaryDetector — pure structural credential/2FA surface detector.
 *
 * Injected via CrawlCollaborators; called AFTER redaction and BEFORE decide().
 * If detection fires, the loop emits CredentialPromptEvent and enters blocked-on-2fa.
 */
export class CredentialBoundaryDetector {
  /**
   * Detects if the given (redacted) snapshot is a credential/2FA surface.
   *
   * Returns a NoBoundaryResult (isCredentialSurface: false) when the screen is NOT a
   * credential surface. Returns a CredentialBoundaryResult (isCredentialSurface: true)
   * with a promptType classification when it IS.
   *
   * Detection priority:
   *   1. Any secure-entry role (secureTextField, passwordField) → "password"
   *   2. OTP-pattern label field → "2fa-otp"
   *   3. Password-pattern label → "password"
   *   4. Username-pattern label → "username" (only if also has another credential indicator)
   */
  detect(snapshot: A11ySnapshot): DetectionResult {
    if (!snapshot || snapshot.trim().length === 0) {
      return { isCredentialSurface: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(snapshot);
    } catch {
      // Non-JSON snapshot — check text patterns as fallback
      return this.detectFromText(snapshot);
    }

    const findings = this.collectFindings(parsed);
    return this.classify(findings);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private detectFromText(raw: string): DetectionResult {
    const lower = raw.toLowerCase();
    if (OTP_LABEL_PATTERNS.some((p) => lower.includes(p))) {
      return { isCredentialSurface: true, promptType: "2fa-otp" };
    }
    if (PASSWORD_LABEL_PATTERNS.some((p) => lower.includes(p))) {
      return { isCredentialSurface: true, promptType: "password" };
    }
    return { isCredentialSurface: false };
  }

  private collectFindings(node: unknown): FieldFindings {
    const findings: FieldFindings = {
      hasSecureEntry: false,
      hasOtpField: false,
      hasPasswordField: false,
      hasUsernameField: false,
      secureFieldCount: 0,
    };
    this.walkNode(node, findings);
    return findings;
  }

  private walkNode(node: unknown, findings: FieldFindings): void {
    if (node === null || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const item of node) {
        this.walkNode(item, findings);
      }
      return;
    }

    const obj = node as Record<string, unknown>;
    this.inspectNode(obj, findings);

    if (Array.isArray(obj["children"])) {
      for (const child of obj["children"] as unknown[]) {
        this.walkNode(child, findings);
      }
    }
  }

  /** Inspects a single a11y node for credential/2FA indicators. */
  private inspectNode(obj: Record<string, unknown>, findings: FieldFindings): void {
    this.checkSecureRole(obj, findings);
    this.checkLabelPatterns(obj, findings);
  }

  private checkSecureRole(obj: Record<string, unknown>, findings: FieldFindings): void {
    const role = obj["role"];
    const type = obj["type"];
    const hasRole =
      (typeof role === "string" && SECURE_ENTRY_ROLES.has(role)) ||
      (typeof type === "string" && SECURE_ENTRY_ROLES.has(type));
    const hasTrait = obj["secureTextEntry"] === true || obj["isSecureTextEntry"] === true;
    if (hasRole || hasTrait) {
      findings.hasSecureEntry = true;
      findings.secureFieldCount++;
    }
  }

  private checkLabelPatterns(obj: Record<string, unknown>, findings: FieldFindings): void {
    const labelFields = ["label", "placeholder", "accessibilityLabel", "name", "id", "hint"];
    for (const field of labelFields) {
      // eslint-disable-next-line security/detect-object-injection -- field is from a fixed array
      const fieldVal = obj[field];
      if (typeof fieldVal !== "string") continue;
      this.classifyLabelValue(fieldVal.toLowerCase(), findings);
    }
  }

  private classifyLabelValue(lower: string, findings: FieldFindings): void {
    if (OTP_LABEL_PATTERNS.some((p) => lower.includes(p))) {
      findings.hasOtpField = true;
      findings.secureFieldCount++;
    } else if (PASSWORD_LABEL_PATTERNS.some((p) => lower.includes(p))) {
      findings.hasPasswordField = true;
      findings.secureFieldCount++;
    } else if (USERNAME_LABEL_PATTERNS.some((p) => lower.includes(p))) {
      findings.hasUsernameField = true;
    }
  }

  private classify(findings: FieldFindings): DetectionResult {
    if (findings.secureFieldCount < MIN_SECURE_FIELDS_FOR_DETECTION) {
      return { isCredentialSurface: false };
    }

    // Priority: secureEntry (iOS secure field role/trait) → password FIRST.
    // Then OTP-label (when not a secure-entry field), then password-label.
    // Rationale: if a field has secureTextEntry:true, it is a password field even if
    // its label happens to match an OTP pattern (e.g. "PIN Entry").
    if (findings.hasSecureEntry) {
      return { isCredentialSurface: true, promptType: "password" };
    }
    if (findings.hasOtpField) {
      return { isCredentialSurface: true, promptType: "2fa-otp" };
    }
    if (findings.hasPasswordField) {
      return { isCredentialSurface: true, promptType: "password" };
    }

    return { isCredentialSurface: false };
  }
}

/** Internal accumulator for field findings during tree walk. */
interface FieldFindings {
  hasSecureEntry: boolean;
  hasOtpField: boolean;
  hasPasswordField: boolean;
  hasUsernameField: boolean;
  secureFieldCount: number;
}
