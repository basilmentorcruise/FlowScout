/**
 * CredentialBoundaryDetector unit tests — covers T8 2FA boundary detection.
 */
import { describe, it, expect } from "vitest";
import { CredentialBoundaryDetector } from "../CredentialBoundaryDetector.js";
import type { A11ySnapshot } from "@flowscout/domain";

const detector = new CredentialBoundaryDetector();

describe("CredentialBoundaryDetector — non-credential screens", () => {
  it("returns isCredentialSurface: false for a normal navigation screen", () => {
    const snapshot = JSON.stringify({
      role: "application",
      label: "Home",
      children: [
        { role: "button", label: "Go to Detail" },
        { role: "button", label: "Settings" },
      ],
    }) as A11ySnapshot;

    const result = detector.detect(snapshot);
    expect(result.isCredentialSurface).toBe(false);
  });

  it("returns isCredentialSurface: false for empty snapshot", () => {
    const result = detector.detect("" as A11ySnapshot);
    expect(result.isCredentialSurface).toBe(false);
  });

  it("returns isCredentialSurface: false for a search screen", () => {
    const snapshot = JSON.stringify({
      role: "application",
      children: [{ role: "textField", label: "Search", value: "" }],
    }) as A11ySnapshot;

    const result = detector.detect(snapshot);
    expect(result.isCredentialSurface).toBe(false);
  });
});

describe("CredentialBoundaryDetector — password screens", () => {
  it("detects a secureTextField as a password surface", () => {
    const snapshot = JSON.stringify({
      role: "application",
      label: "Login",
      children: [
        { role: "secureTextField", label: "Enter your password", value: "[REDACTED]" },
        { role: "button", label: "Sign In" },
      ],
    }) as A11ySnapshot;

    const result = detector.detect(snapshot);
    expect(result.isCredentialSurface).toBe(true);
    if (result.isCredentialSurface) {
      expect(result.promptType).toBe("password");
    }
  });

  it("detects a node with secureTextEntry: true as a password surface", () => {
    const snapshot = JSON.stringify({
      role: "textField",
      label: "PIN Entry",
      secureTextEntry: true,
      value: "[REDACTED]",
    }) as A11ySnapshot;

    const result = detector.detect(snapshot);
    expect(result.isCredentialSurface).toBe(true);
    if (result.isCredentialSurface) {
      expect(result.promptType).toBe("password");
    }
  });

  it("detects a text field with 'password' label as a password surface", () => {
    const snapshot = JSON.stringify({
      role: "textField",
      label: "password",
      value: "[REDACTED]",
    }) as A11ySnapshot;

    const result = detector.detect(snapshot);
    expect(result.isCredentialSurface).toBe(true);
    if (result.isCredentialSurface) {
      expect(result.promptType).toBe("password");
    }
  });
});

describe("CredentialBoundaryDetector — 2FA/OTP screens", () => {
  it("detects an OTP field as a 2fa-otp surface", () => {
    const snapshot = JSON.stringify({
      role: "application",
      label: "Verification",
      children: [
        { role: "textField", label: "Enter OTP", value: "[REDACTED]" },
        { role: "button", label: "Verify" },
      ],
    }) as A11ySnapshot;

    const result = detector.detect(snapshot);
    expect(result.isCredentialSurface).toBe(true);
    if (result.isCredentialSurface) {
      expect(result.promptType).toBe("2fa-otp");
    }
  });

  it("detects a 'verification code' field as 2fa-otp", () => {
    const snapshot = JSON.stringify({
      role: "textField",
      label: "Verification Code",
      placeholder: "Enter 6-digit code",
    }) as A11ySnapshot;

    const result = detector.detect(snapshot);
    expect(result.isCredentialSurface).toBe(true);
    if (result.isCredentialSurface) {
      expect(result.promptType).toBe("2fa-otp");
    }
  });

  it("detects a 'two-factor' screen as 2fa-otp", () => {
    const snapshot = JSON.stringify({
      role: "application",
      label: "Two-Factor Authentication",
      children: [{ role: "textField", label: "two-factor code", value: "" }],
    }) as A11ySnapshot;

    const result = detector.detect(snapshot);
    expect(result.isCredentialSurface).toBe(true);
    if (result.isCredentialSurface) {
      expect(result.promptType).toBe("2fa-otp");
    }
  });
});

describe("CredentialBoundaryDetector — non-JSON fallback", () => {
  it("detects OTP pattern in raw text", () => {
    const snapshot = "Screen: Enter your one-time code here" as A11ySnapshot;
    const result = detector.detect(snapshot);
    expect(result.isCredentialSurface).toBe(true);
    if (result.isCredentialSurface) {
      expect(result.promptType).toBe("2fa-otp");
    }
  });

  it("detects password pattern in raw text", () => {
    const snapshot = "Enter password to continue" as A11ySnapshot;
    const result = detector.detect(snapshot);
    expect(result.isCredentialSurface).toBe(true);
  });
});
