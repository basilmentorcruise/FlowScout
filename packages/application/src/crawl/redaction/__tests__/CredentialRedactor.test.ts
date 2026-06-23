/**
 * CredentialRedactor unit tests — covers T3/T7/T8 redaction boundary.
 *
 * Verifies:
 * - Secure-entry field values are redacted in a11y snapshots
 * - OTP-shaped text is redacted via redactText()
 * - Non-secure fields are preserved (no over-redaction)
 * - Non-JSON snapshots fall back to text-level masking
 * - Gate-checkable: known credential/OTP token ABSENT from redacted output
 */
import { describe, it, expect } from "vitest";
import { CredentialRedactor, REDACTED_MARKER } from "../CredentialRedactor.js";
import type { A11ySnapshot } from "@flowscout/domain";

const redactor = new CredentialRedactor();

// ── snapshot redaction ────────────────────────────────────────────────────────

describe("CredentialRedactor.redact — secure-entry field masking", () => {
  it("redacts value of a secureTextField node", () => {
    const snapshot = JSON.stringify({
      role: "application",
      children: [{ role: "secureTextField", label: "Enter password", value: "SUPER-SECRET-123" }],
    }) as A11ySnapshot;

    const result = redactor.redact(snapshot);
    expect(result).not.toContain("SUPER-SECRET-123");
    expect(result).toContain(REDACTED_MARKER);
  });

  it("redacts value of a node with secureTextEntry: true", () => {
    const snapshot = JSON.stringify({
      role: "application",
      children: [{ role: "textField", label: "PIN", secureTextEntry: true, value: "9876" }],
    }) as A11ySnapshot;

    const result = redactor.redact(snapshot);
    expect(result).not.toContain("9876");
    expect(result).toContain(REDACTED_MARKER);
  });

  it("redacts value of a node with label containing 'password'", () => {
    const snapshot = JSON.stringify({
      role: "application",
      children: [{ role: "textField", label: "password", value: "my-secret-pass" }],
    }) as A11ySnapshot;

    const result = redactor.redact(snapshot);
    expect(result).not.toContain("my-secret-pass");
    expect(result).toContain(REDACTED_MARKER);
  });

  it("redacts value of a node with label containing 'otp'", () => {
    const snapshot = JSON.stringify({
      role: "textField",
      label: "OTP Code",
      value: "123456",
    }) as A11ySnapshot;

    const result = redactor.redact(snapshot);
    expect(result).not.toContain("123456");
    expect(result).toContain(REDACTED_MARKER);
  });

  it("does NOT redact non-secure text fields", () => {
    const snapshot = JSON.stringify({
      role: "application",
      children: [
        { role: "button", label: "Submit", value: "Submit" },
        { role: "textField", label: "Search", value: "hello world" },
      ],
    }) as A11ySnapshot;

    const result = redactor.redact(snapshot);
    expect(result).toContain("Submit");
    expect(result).toContain("hello world");
    expect(result).not.toContain(REDACTED_MARKER);
  });

  it("preserves structural shape of the snapshot after redaction", () => {
    const snapshot = JSON.stringify({
      role: "application",
      label: "Login Screen",
      children: [
        { role: "secureTextField", label: "Password", value: "CRED-TOKEN-XYZ" },
        { role: "button", label: "Login", value: "" },
      ],
    }) as A11ySnapshot;

    const result = redactor.redact(snapshot);
    const parsed = JSON.parse(result) as Record<string, unknown>;

    // Structural fields preserved
    expect(parsed["role"]).toBe("application");
    expect(parsed["label"]).toBe("Login Screen");

    // Children preserved with redacted value
    const children = parsed["children"] as Array<Record<string, unknown>>;
    expect(children).toHaveLength(2);
    expect(children[0]?.["label"]).toBe("Password");
    expect(children[0]?.["value"]).toBe(REDACTED_MARKER);
    expect(children[1]?.["label"]).toBe("Login");
    // Empty value is not redacted (nothing to redact)
    expect(children[1]?.["value"]).toBe("");
  });

  it("handles empty snapshot without throwing", () => {
    expect(() => redactor.redact("" as A11ySnapshot)).not.toThrow();
  });

  it("handles non-JSON snapshot via text-level fallback", () => {
    const raw = "Screen: Password=1234 OTP=5678" as A11ySnapshot;
    const result = redactor.redact(raw);
    // OTP-shaped numbers should be masked
    expect(result).not.toContain("1234");
    expect(result).not.toContain("5678");
    expect(result).toContain(REDACTED_MARKER);
  });

  it("masks OTP-shaped value even in non-secure field (defense in depth)", () => {
    const snapshot = JSON.stringify({
      role: "staticText",
      label: "Verification",
      value: "123456",
    }) as A11ySnapshot;

    const result = redactor.redact(snapshot);
    expect(result).not.toContain("123456");
  });
});

// ── redactText ────────────────────────────────────────────────────────────────

describe("CredentialRedactor.redactText — typeText payload redaction", () => {
  it("fully redacts a 6-digit OTP string", () => {
    expect(redactor.redactText("123456")).toBe(REDACTED_MARKER);
  });

  it("fully redacts a 4-digit PIN", () => {
    expect(redactor.redactText("9871")).toBe(REDACTED_MARKER);
  });

  it("fully redacts a hyphenated OTP", () => {
    expect(redactor.redactText("1234-5678")).toBe(REDACTED_MARKER);
  });

  it("masks embedded OTP sequences in longer text", () => {
    const result = redactor.redactText("Your code is 123456 please enter it");
    expect(result).not.toContain("123456");
    expect(result).toContain(REDACTED_MARKER);
  });

  it("does NOT redact normal text without OTP patterns", () => {
    expect(redactor.redactText("hello world")).toBe("hello world");
    expect(redactor.redactText("tap the submit button")).toBe("tap the submit button");
  });

  it("handles empty string without throwing", () => {
    expect(redactor.redactText("")).toBe("");
  });

  it("handles undefined-like empty without throwing", () => {
    expect(() => redactor.redactText("")).not.toThrow();
  });
});

// ── Gate-checkable: synthetic credential ABSENT from all sinks ─────────────────

describe("CredentialRedactor — gate-checkable: credential token absent", () => {
  it("CREDENTIAL-TOKEN-FAKE-XYZ does not appear in redacted snapshot output", () => {
    const snapshot = JSON.stringify({
      role: "application",
      children: [
        {
          role: "secureTextField",
          label: "password",
          value: "CREDENTIAL-TOKEN-FAKE-XYZ",
        },
      ],
    }) as A11ySnapshot;

    const redacted = redactor.redact(snapshot);
    expect(redacted).not.toContain("CREDENTIAL-TOKEN-FAKE-XYZ");
  });

  it("FAKE-OTP-654321 does not appear in redacted typeText output", () => {
    const redacted = redactor.redactText("654321");
    expect(redacted).not.toContain("654321");
    expect(redacted).toBe(REDACTED_MARKER);
  });
});
