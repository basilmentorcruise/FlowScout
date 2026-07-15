/**
 * Typed vault errors (#101, ADR-0011 D1 — fail closed, NFR3).
 *
 * Messages are STRUCTURAL ONLY (entry identity like `appId/label` at most) — they must
 * never interpolate a key, plaintext, nonce, or ciphertext (threat model M9/T7).
 */

/** Thrown when `FLOWSCOUT_VAULT_KEY` is missing/empty — the vault never operates keyless (M2). */
export class VaultKeyMissingError extends Error {
  constructor(message = "vault key is not configured (FLOWSCOUT_VAULT_KEY) — failing closed") {
    super(message);
    this.name = "VaultKeyMissingError";
  }
}

/**
 * Thrown on wrong key, tampered ciphertext/tag/AAD, malformed store bytes, or an
 * unsupported format version — the vault fails closed, never returns garbage (M4).
 */
export class VaultIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultIntegrityError";
  }
}
