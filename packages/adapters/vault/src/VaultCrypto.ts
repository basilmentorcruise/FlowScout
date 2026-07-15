/**
 * VaultCrypto — scrypt KDF + AES-256-GCM seal/open with AAD binding (#101, ADR-0011 D1/D2).
 *
 * `node:crypto` ONLY — zero new crypto dependencies (threat model M11/T18).
 *
 * Security invariants owned here:
 *   - M1 (T1): `seal` draws a FRESH `randomBytes(12)` nonce on EVERY call — never a
 *     constant, counter, or reused value. Nonce reuse under one GCM key is catastrophic.
 *   - M3 (T2): the AES-256 key is scrypt-derived to exactly 32 bytes from the env
 *     master secret + a per-vault random salt (stored in the vault header, not secret).
 *   - M4 (T3): `open` always calls `setAuthTag` and converts any authentication
 *     failure into a thrown `VaultIntegrityError` — never a returned value.
 *   - M5 (T3): AAD binds each blob to `appId + label + format version`, so a
 *     ciphertext copied between entries fails authentication.
 *   - M9 (T7): error messages carry entry identity only — no secret material.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { VaultIntegrityError } from "./errors.js";

/** scrypt cost parameters (ADR-0011 D1 — named constants, no magic values). */
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
/** AES-256 key length. */
export const KEY_LENGTH_BYTES = 32;
/** Per-vault KDF salt length (stored in the vault-file header; not secret). */
export const SALT_LENGTH_BYTES = 16;
/** GCM nonce (IV) length — 96 bits per NIST GCM discipline. */
export const NONCE_LENGTH_BYTES = 12;
/** GCM authentication-tag length. */
export const AUTH_TAG_LENGTH_BYTES = 16;
/** At-rest format version — also bound into the AAD (ADR-0011 D2). */
export const VAULT_FORMAT_VERSION = 1;

const CIPHER_ALGORITHM = "aes-256-gcm";

/** One encrypted entry payload: nonce + tag + ciphertext (all non-secret except nothing — all safe to persist). */
export interface SealedBlob {
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
}

/** Fresh random per-vault KDF salt (generated once per vault file, kept in its header). */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH_BYTES);
}

/**
 * Derive the AES-256 key from the env master secret via scrypt (M3).
 * Callers own the returned Buffer's lifetime and MUST `fill(0)` it after use (M9).
 */
export function deriveKey(masterSecret: string, salt: Buffer): Buffer {
  return scryptSync(masterSecret, salt, KEY_LENGTH_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

/** AAD binding an entry's ciphertext to its identity: `<appId>\n<label>\nv<version>` (M5). */
export function buildAad(appId: string, label: string): Buffer {
  return Buffer.from(`${appId}\n${label}\nv${String(VAULT_FORMAT_VERSION)}`, "utf8");
}

/**
 * Encrypt one entry blob. Draws a FRESH random 96-bit nonce on every call (M1) —
 * a re-store of the same entry always produces a new nonce + new ciphertext.
 */
export function seal(key: Buffer, aad: Buffer, plaintext: Buffer): SealedBlob {
  const iv = randomBytes(NONCE_LENGTH_BYTES); // M1 — never constant/counter/reused
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv, authTag, ciphertext };
}

/**
 * Decrypt one entry blob, verifying the GCM auth tag and the AAD identity binding.
 *
 * @param entryIdentity non-secret identity (`appId/label`) for the structural error message.
 * @throws VaultIntegrityError on wrong key, tampered ciphertext/tag, AAD mismatch,
 *   or malformed nonce/tag lengths — never returns partial/garbage plaintext (M4).
 */
export function open(key: Buffer, aad: Buffer, blob: SealedBlob, entryIdentity: string): Buffer {
  if (blob.iv.length !== NONCE_LENGTH_BYTES || blob.authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new VaultIntegrityError(
      `vault entry ${entryIdentity} has a malformed nonce or auth tag — failing closed`,
    );
  }
  const decipher = createDecipheriv(CIPHER_ALGORITHM, key, blob.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(blob.authTag); // M4 — tag ALWAYS verified
  try {
    return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
  } catch {
    // Structural rethrow only (M9): the underlying error is discarded, no plaintext
    // was produced, and the failure still THROWS (M4 — no catch-return-garbage).
    throw new VaultIntegrityError(
      `vault decrypt failed for ${entryIdentity} — wrong key or tampered data`,
    );
  }
}
