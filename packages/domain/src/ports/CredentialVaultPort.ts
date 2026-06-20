/**
 * CredentialVaultPort — encrypted credential storage, scoped per app.
 * Plaintext exists only transiently in memory at use time.
 * Implemented in adapters/vault (AES-256-GCM, key from env/secret store only).
 */

/** A credential entry stored in the vault, scoped to one app. */
export interface AppCredential {
  readonly appId: string;
  readonly label: string; // e.g. "main account", "test account"
  readonly username: string;
  /** Encrypted ciphertext (never logged or emitted in events). */
  readonly encryptedPassword: string;
  /** Optional: encrypted OTP seed (TOTP) — null if no 2FA pre-seeded. */
  readonly encryptedOtpSeed: string | null;
}

/** Plaintext credential — exists only in memory, never persisted or logged. */
export interface PlaintextCredential {
  readonly username: string;
  readonly password: string;
  readonly otpSeed: string | null;
}

export interface CredentialVaultPort {
  /** Store (or overwrite) credentials for an app, encrypted at rest. */
  store(appId: string, label: string, credential: PlaintextCredential): Promise<void>;
  /** Retrieve and decrypt credentials for an app. Returns null if not found. */
  retrieve(appId: string, label: string): Promise<PlaintextCredential | null>;
  /** List stored labels for an app (no plaintext exposed). */
  listLabels(appId: string): Promise<readonly string[]>;
  /** Delete a credential entry. */
  delete(appId: string, label: string): Promise<void>;
}
