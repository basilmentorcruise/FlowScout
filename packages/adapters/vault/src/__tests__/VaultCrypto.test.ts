/**
 * VaultCrypto tests — scrypt KDF + AES-256-GCM seal/open with AAD (#101, ADR-0011 D1/D2).
 *
 * Security coverage: M1 (fresh nonce per encryption — uniqueness across 1000 seals),
 * M3 (32-byte derived key), M4 (tamper ⇒ throw, never garbage), M5 (AAD binding),
 * M11 (every secret fixture is runtime-constructed via randomBytes — never a literal).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VaultIntegrityError } from "../errors.js";
import {
  AUTH_TAG_LENGTH_BYTES,
  buildAad,
  deriveKey,
  generateSalt,
  KEY_LENGTH_BYTES,
  NONCE_LENGTH_BYTES,
  open,
  SALT_LENGTH_BYTES,
  seal,
} from "../VaultCrypto.js";

/** Runtime-constructed secret material (M11 — never hardcoded literals). */
function freshSecret(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString("hex")}`;
}

function freshKey(): Buffer {
  return deriveKey(freshSecret("master"), generateSalt());
}

describe("deriveKey (scrypt KDF)", () => {
  it("derives a 32-byte key (AES-256)", () => {
    const key = deriveKey(freshSecret("master"), generateSalt());
    expect(key.length).toBe(KEY_LENGTH_BYTES);
    expect(KEY_LENGTH_BYTES).toBe(32);
  });

  it("is deterministic for the same secret + salt", () => {
    const secret = freshSecret("master");
    const salt = generateSalt();
    expect(deriveKey(secret, salt).equals(deriveKey(secret, salt))).toBe(true);
  });

  it("differs for a different salt (per-vault salt matters)", () => {
    const secret = freshSecret("master");
    expect(deriveKey(secret, generateSalt()).equals(deriveKey(secret, generateSalt()))).toBe(false);
  });

  it("differs for a different master secret", () => {
    const salt = generateSalt();
    expect(
      deriveKey(freshSecret("master-a"), salt).equals(deriveKey(freshSecret("master-b"), salt)),
    ).toBe(false);
  });

  it("generateSalt returns 16 random bytes", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a.length).toBe(SALT_LENGTH_BYTES);
    expect(SALT_LENGTH_BYTES).toBe(16);
    expect(a.equals(b)).toBe(false);
  });
});

describe("seal/open round-trip", () => {
  it("round-trips plaintext under the same key + AAD", () => {
    const key = freshKey();
    const aad = buildAad("app.example", "default");
    const plaintext = Buffer.from(freshSecret("credential"), "utf8");
    const blob = seal(key, aad, plaintext);
    const opened = open(key, aad, blob, "app.example/default");
    expect(opened.equals(plaintext)).toBe(true);
  });

  it("produces a 12-byte nonce and 16-byte auth tag", () => {
    const blob = seal(freshKey(), buildAad("a", "l"), Buffer.from(freshSecret("pw"), "utf8"));
    expect(blob.iv.length).toBe(NONCE_LENGTH_BYTES);
    expect(NONCE_LENGTH_BYTES).toBe(12);
    expect(blob.authTag.length).toBe(AUTH_TAG_LENGTH_BYTES);
    expect(AUTH_TAG_LENGTH_BYTES).toBe(16);
  });

  it("ciphertext never contains the plaintext bytes", () => {
    const marker = freshSecret("marker");
    const blob = seal(freshKey(), buildAad("a", "l"), Buffer.from(marker, "utf8"));
    expect(blob.ciphertext.toString("utf8")).not.toContain(marker);
    expect(blob.ciphertext.toString("latin1")).not.toContain(marker);
  });
});

describe("M1 — fresh random nonce per encryption", () => {
  it("draws a unique nonce for every one of 1000 encryptions of the SAME plaintext", () => {
    const key = freshKey();
    const aad = buildAad("app.example", "default");
    const plaintext = Buffer.from(freshSecret("same-credential"), "utf8");
    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const blob = seal(key, aad, plaintext);
      nonces.add(blob.iv.toString("hex"));
      ciphertexts.add(blob.ciphertext.toString("hex"));
    }
    expect(nonces.size).toBe(1000);
    expect(ciphertexts.size).toBe(1000);
  });
});

describe("M4 — tamper detection (auth tag verified, failures throw)", () => {
  it("rejects a flipped ciphertext byte with VaultIntegrityError", () => {
    const key = freshKey();
    const aad = buildAad("a", "l");
    const blob = seal(key, aad, Buffer.from(freshSecret("pw"), "utf8"));
    const tampered = Buffer.from(blob.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => open(key, aad, { ...blob, ciphertext: tampered }, "a/l")).toThrow(
      VaultIntegrityError,
    );
  });

  it("rejects a flipped auth-tag byte with VaultIntegrityError", () => {
    const key = freshKey();
    const aad = buildAad("a", "l");
    const blob = seal(key, aad, Buffer.from(freshSecret("pw"), "utf8"));
    const tampered = Buffer.from(blob.authTag);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => open(key, aad, { ...blob, authTag: tampered }, "a/l")).toThrow(
      VaultIntegrityError,
    );
  });

  it("rejects a wrong key with VaultIntegrityError (fail closed, no garbage plaintext)", () => {
    const aad = buildAad("a", "l");
    const blob = seal(freshKey(), aad, Buffer.from(freshSecret("pw"), "utf8"));
    expect(() => open(freshKey(), aad, blob, "a/l")).toThrow(VaultIntegrityError);
  });

  it("rejects a wrong-length nonce or auth tag before decrypting", () => {
    const key = freshKey();
    const aad = buildAad("a", "l");
    const blob = seal(key, aad, Buffer.from(freshSecret("pw"), "utf8"));
    expect(() => open(key, aad, { ...blob, iv: randomBytes(8) }, "a/l")).toThrow(
      VaultIntegrityError,
    );
    expect(() => open(key, aad, { ...blob, authTag: randomBytes(8) }, "a/l")).toThrow(
      VaultIntegrityError,
    );
  });
});

describe("M5 — AAD binding (appId + label + version)", () => {
  it("rejects a blob opened under a different appId's AAD", () => {
    const key = freshKey();
    const blob = seal(key, buildAad("app-a", "default"), Buffer.from(freshSecret("pw"), "utf8"));
    expect(() => open(key, buildAad("app-b", "default"), blob, "app-b/default")).toThrow(
      VaultIntegrityError,
    );
  });

  it("rejects a blob opened under a different label's AAD", () => {
    const key = freshKey();
    const blob = seal(key, buildAad("app-a", "default"), Buffer.from(freshSecret("pw"), "utf8"));
    expect(() => open(key, buildAad("app-a", "other"), blob, "app-a/other")).toThrow(
      VaultIntegrityError,
    );
  });

  it("binds the format version into the AAD", () => {
    expect(buildAad("app-a", "default").toString("utf8")).toBe("app-a\ndefault\nv1");
  });
});

describe("M9 — structural, secret-free errors", () => {
  it("integrity errors carry entry identity only — never plaintext, key, or ciphertext", () => {
    const key = freshKey();
    const wrongKey = freshKey();
    const secret = freshSecret("super-secret");
    const aad = buildAad("app.example", "default");
    const blob = seal(key, aad, Buffer.from(secret, "utf8"));
    let caught: unknown;
    try {
      open(wrongKey, aad, blob, "app.example/default");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VaultIntegrityError);
    const message = (caught as Error).message;
    expect(message).toContain("app.example/default");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(key.toString("hex"));
    expect(message).not.toContain(blob.ciphertext.toString("hex"));
    expect(message).not.toContain(blob.ciphertext.toString("base64"));
  });
});
