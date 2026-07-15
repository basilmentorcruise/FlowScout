/**
 * Shared vault test fixtures — ALL secret-shaped values are runtime-constructed
 * via `randomBytes` (M11/T18: never hardcoded literals; gitleaks-clean).
 */
import { randomBytes } from "node:crypto";
import type { PlaintextCredential } from "@flowscout/domain";

/** Runtime-constructed secret-shaped string (never a committed literal). */
export function freshSecret(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

/** Runtime-constructed credential; `otpSeed` defaults to null (override to set). */
export function freshCredential(
  overrides: Partial<PlaintextCredential> = {},
): PlaintextCredential {
  return {
    username: `${freshSecret("user")}@example.test`,
    password: freshSecret("pw"),
    otpSeed: null,
    ...overrides,
  };
}
