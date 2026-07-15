/**
 * VaultAdapter — implements `CredentialVaultPort` over the encrypted vault file
 * (#101, ADR-0011 D1/D2). AES-256-GCM per-entry blobs, scrypt-derived key,
 * single JSON file store.
 *
 * Composition (SRP): crypto lives in `VaultCrypto`, the at-rest file in
 * `VaultFileStore`, env/config resolution in `vaultConfig` — this class only
 * orchestrates. DI: it receives `{ vaultPath, keySource }` and NEVER reads
 * `process.env` itself (M2; wiring happens in #102's composition root).
 *
 * Security invariants owned here:
 *   - Fail closed (M2): every operation first demands a master secret from the
 *     lazy `VaultKeySource`; `null` ⇒ `VaultKeyMissingError` (no default key, ever).
 *   - Whole-entry encryption (D2): the GCM blob covers `{username, password,
 *     otpSeed}` — the username is encrypted too (PII); `listLabels` never decrypts.
 *   - M9 (T7): plaintext + derived key live in narrow scopes and are best-effort
 *     `fill(0)`-ed after use (JS strings handed to callers cannot be zeroized —
 *     accepted ADR-0011 §3 bound); no plaintext/key cache is ever held; errors
 *     carry entry identity only.
 *   - M10 (T12): `store` on an existing appId+label fully replaces the entry —
 *     under a fresh nonce (M1, enforced in `VaultCrypto.seal`).
 */
import type { CredentialVaultPort, PlaintextCredential } from "@flowscout/domain";
import { VaultIntegrityError, VaultKeyMissingError } from "./errors.js";
import {
  buildAad,
  deriveKey,
  generateSalt,
  open,
  seal,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  VAULT_FORMAT_VERSION,
} from "./VaultCrypto.js";
import { VaultFileStore, type VaultEntryRecord, type VaultFileModel } from "./VaultFileStore.js";
import { resolveVaultConfig, type VaultKeySource } from "./vaultConfig.js";

export interface VaultAdapterOptions {
  /** Config-owned vault file location (never derived from appId/label — M7). */
  readonly vaultPath: string;
  /** Lazy master-secret source (M2 — env-only upstream, null = not configured). */
  readonly keySource: VaultKeySource;
}

/**
 * Bridge sync work into the async port contract: a sync throw becomes a REJECTED
 * promise — callers of a Promise-typed method never see a synchronous exception
 * (same discipline as the persistence adapter's promiseBridge).
 */
function asPromise<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function isCredentialShape(value: unknown): value is PlaintextCredential {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["username"] === "string" &&
    typeof candidate["password"] === "string" &&
    (candidate["otpSeed"] === null || typeof candidate["otpSeed"] === "string")
  );
}

export class VaultAdapter implements CredentialVaultPort {
  private readonly fileStore: VaultFileStore;
  private readonly keySource: VaultKeySource;

  /**
   * DI-first: pass `{ vaultPath, keySource }` (the #102 composition root calls
   * `resolveVaultConfig(process.env)` and injects it). The default argument exists
   * ONLY so the pre-#102 `wire.ts` call site (`new VaultAdapter()`) keeps compiling
   * without a wire.ts edit (out of #101's Touches); it delegates to `vaultConfig` —
   * the adapter itself never reads `process.env`, and the key stays lazy +
   * fail-closed (M2: no default KEY exists either way).
   */
  constructor(options: VaultAdapterOptions = resolveVaultConfig(process.env)) {
    this.fileStore = new VaultFileStore(options.vaultPath);
    this.keySource = options.keySource;
  }

  store(appId: string, label: string, credential: PlaintextCredential): Promise<void> {
    return asPromise(() => {
      const masterSecret = this.requireMasterSecret();
      const model = this.fileStore.load() ?? newEmptyModel();
      const key = deriveKey(masterSecret, Buffer.from(model.kdf.salt, "base64"));
      const plaintext = Buffer.from(
        JSON.stringify({
          username: credential.username,
          password: credential.password,
          otpSeed: credential.otpSeed,
        }),
        "utf8",
      );
      try {
        const blob = seal(key, buildAad(appId, label), plaintext); // fresh nonce (M1)
        const entry: VaultEntryRecord = {
          appId,
          label,
          iv: blob.iv.toString("base64"),
          authTag: blob.authTag.toString("base64"),
          ciphertext: blob.ciphertext.toString("base64"),
        };
        // Full overwrite for an existing appId+label (M10) — single entry per key.
        const entries = [
          ...model.entries.filter((existing) => !matches(existing, appId, label)),
          entry,
        ];
        this.fileStore.save({ ...model, entries });
      } finally {
        key.fill(0); // best-effort zeroization (M9)
        plaintext.fill(0);
      }
    });
  }

  retrieve(appId: string, label: string): Promise<PlaintextCredential | null> {
    return asPromise(() => {
      const masterSecret = this.requireMasterSecret();
      const model = this.fileStore.load();
      const entry = model?.entries.find((candidate) => matches(candidate, appId, label));
      if (model === null || entry === undefined) {
        return null; // miss is null, not an error (AC3)
      }
      const key = deriveKey(masterSecret, Buffer.from(model.kdf.salt, "base64"));
      let plaintext: Buffer | undefined;
      try {
        plaintext = open(
          key,
          buildAad(appId, label),
          {
            iv: Buffer.from(entry.iv, "base64"),
            authTag: Buffer.from(entry.authTag, "base64"),
            ciphertext: Buffer.from(entry.ciphertext, "base64"),
          },
          `${appId}/${label}`,
        );
        return parseCredential(plaintext, `${appId}/${label}`);
      } finally {
        key.fill(0); // best-effort zeroization (M9); no plaintext cache is kept
        plaintext?.fill(0);
      }
    });
  }

  listLabels(appId: string): Promise<readonly string[]> {
    return asPromise(() => {
      this.requireMasterSecret(); // every vault operation fails closed keyless (ADR-0011 D1)
      const model = this.fileStore.load();
      if (model === null) {
        return [];
      }
      // Header-only read — labels are plaintext lookup keys; nothing is decrypted.
      return model.entries.filter((entry) => entry.appId === appId).map((entry) => entry.label);
    });
  }

  delete(appId: string, label: string): Promise<void> {
    return asPromise(() => {
      this.requireMasterSecret();
      const model = this.fileStore.load();
      if (model === null) {
        return;
      }
      const remaining = model.entries.filter((entry) => !matches(entry, appId, label));
      if (remaining.length === model.entries.length) {
        return; // idempotent no-op
      }
      // Re-write WITHOUT the entry — the ciphertext leaves the persisted store (M8).
      this.fileStore.save({ ...model, entries: remaining });
    });
  }

  /** Fail closed (M2): no key ⇒ typed, secret-free error; never a default. */
  private requireMasterSecret(): string {
    const masterSecret = this.keySource();
    if (masterSecret === null) {
      throw new VaultKeyMissingError();
    }
    return masterSecret;
  }
}

function matches(entry: VaultEntryRecord, appId: string, label: string): boolean {
  return entry.appId === appId && entry.label === label;
}

/** First-use vault: fresh per-vault KDF salt in the header (ADR-0011 D1). */
function newEmptyModel(): VaultFileModel {
  return {
    version: VAULT_FORMAT_VERSION,
    kdf: {
      algo: "scrypt",
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: generateSalt().toString("base64"),
    },
    entries: [],
  };
}

/** Parse the decrypted blob; a wrong shape fails closed with identity only (M9). */
function parseCredential(plaintext: Buffer, entryIdentity: string): PlaintextCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new VaultIntegrityError(
      `vault entry ${entryIdentity} decrypted to a malformed payload — failing closed`,
    );
  }
  if (!isCredentialShape(parsed)) {
    throw new VaultIntegrityError(
      `vault entry ${entryIdentity} decrypted to an unexpected shape — failing closed`,
    );
  }
  return { username: parsed.username, password: parsed.password, otpSeed: parsed.otpSeed };
}
