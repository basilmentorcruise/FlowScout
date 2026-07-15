/**
 * VaultFileStore — the single encrypted JSON vault file (#101, ADR-0011 D2).
 *
 * Owns load/parse/validate and the deterministic, atomic, owner-only write:
 *   - M6 (T4): only ciphertext+nonce+tag(+KDF header) are ever written; writes go to a
 *     `<path>.tmp` sibling created 0600, are fsync'd, then `rename()`d over the target —
 *     the rename is the atomic commit point, so a crash never leaves a torn vault.
 *   - M7 (T5): parent dir created 0700 (pre-existing dirs are never chmod'd — E7
 *     discipline), file 0600; the path is CONFIG-OWNED (`FLOWSCOUT_VAULT_PATH`) — no
 *     `appId`/`label` ever reaches a path segment, and it is a separate file from the
 *     E7 run DB (`FLOWSCOUT_DB_PATH`).
 *   - Deterministic serialization (D2): fixed key order + entries sorted by
 *     (`appId`, `label`) ⇒ byte-identical output for identical content.
 *   - Fail closed (M4/NFR3): malformed JSON, unknown `version`, unexpected KDF
 *     parameters, or invalid entry shapes throw `VaultIntegrityError`.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { VaultIntegrityError } from "./errors.js";
import {
  SALT_LENGTH_BYTES,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  VAULT_FORMAT_VERSION,
} from "./VaultCrypto.js";

/** Owner-only permissions for anything this module creates (M7/T5). */
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

/** KDF algorithm identifier recorded in the header (ADR-0011 D1). */
const KDF_ALGORITHM = "scrypt";

/** JSON indentation for the persisted vault (stable, human-diffable ciphertext file). */
const SERIALIZATION_INDENT = 2;

/** One persisted entry: plaintext lookup keys + base64 nonce/tag/ciphertext ONLY (M6). */
export interface VaultEntryRecord {
  readonly appId: string;
  readonly label: string;
  /** base64, 12 bytes. */
  readonly iv: string;
  /** base64, 16 bytes. */
  readonly authTag: string;
  /** base64 AES-256-GCM blob over the entry JSON (username included — PII). */
  readonly ciphertext: string;
}

/** The whole at-rest vault document (format v1, ADR-0011 D2). */
export interface VaultFileModel {
  readonly version: typeof VAULT_FORMAT_VERSION;
  readonly kdf: {
    readonly algo: typeof KDF_ALGORITHM;
    readonly n: number;
    readonly r: number;
    readonly p: number;
    /** base64, 16-byte per-vault salt (not secret). */
    readonly salt: string;
  };
  readonly entries: readonly VaultEntryRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBase64OfLength(value: unknown, expectedBytes?: number): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  // Strict round-trip: Buffer.from silently ignores invalid characters.
  if (decoded.toString("base64") !== value) {
    return false;
  }
  return expectedBytes === undefined ? decoded.length > 0 : decoded.length === expectedBytes;
}

function validateEntry(value: unknown): VaultEntryRecord {
  if (
    !isRecord(value) ||
    typeof value["appId"] !== "string" ||
    typeof value["label"] !== "string" ||
    !isBase64OfLength(value["iv"]) ||
    !isBase64OfLength(value["authTag"]) ||
    !isBase64OfLength(value["ciphertext"])
  ) {
    throw new VaultIntegrityError("vault file contains a structurally invalid entry");
  }
  return {
    appId: value["appId"],
    label: value["label"],
    iv: value["iv"],
    authTag: value["authTag"],
    ciphertext: value["ciphertext"],
  };
}

/**
 * Validate the parsed document against the v1 format. KDF parameters must EXACTLY
 * match the named constants — a tampered-down cost (or unknown algo/version) is
 * never honored (fail closed; a wrong param would only yield a wrong key anyway,
 * but rejecting early keeps the failure structural and DoS-safe).
 */
function validateModel(parsed: unknown): VaultFileModel {
  if (!isRecord(parsed)) {
    throw new VaultIntegrityError("vault file is not a JSON object — failing closed");
  }
  if (parsed["version"] !== VAULT_FORMAT_VERSION) {
    throw new VaultIntegrityError("vault file has an unsupported format version — failing closed");
  }
  const kdf = parsed["kdf"];
  if (
    !isRecord(kdf) ||
    kdf["algo"] !== KDF_ALGORITHM ||
    kdf["n"] !== SCRYPT_N ||
    kdf["r"] !== SCRYPT_R ||
    kdf["p"] !== SCRYPT_P ||
    !isBase64OfLength(kdf["salt"], SALT_LENGTH_BYTES)
  ) {
    throw new VaultIntegrityError("vault file has an invalid KDF header — failing closed");
  }
  const entries = parsed["entries"];
  if (!Array.isArray(entries)) {
    throw new VaultIntegrityError("vault file entries are not an array — failing closed");
  }
  return {
    version: VAULT_FORMAT_VERSION,
    kdf: {
      algo: KDF_ALGORITHM,
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: kdf["salt"],
    },
    entries: entries.map(validateEntry),
  };
}

/** Deterministic serialization: fixed key order + entries sorted by (appId, label). */
function serialize(model: VaultFileModel): string {
  const sortedEntries = [...model.entries].sort(
    (a, b) => a.appId.localeCompare(b.appId) || a.label.localeCompare(b.label),
  );
  const canonical: VaultFileModel = {
    version: model.version,
    kdf: {
      algo: model.kdf.algo,
      n: model.kdf.n,
      r: model.kdf.r,
      p: model.kdf.p,
      salt: model.kdf.salt,
    },
    entries: sortedEntries.map((entry) => ({
      appId: entry.appId,
      label: entry.label,
      iv: entry.iv,
      authTag: entry.authTag,
      ciphertext: entry.ciphertext,
    })),
  };
  return `${JSON.stringify(canonical, null, SERIALIZATION_INDENT)}\n`;
}

export class VaultFileStore {
  constructor(private readonly vaultPath: string) {}

  /**
   * Read + validate the vault document. Returns `null` when no vault exists yet
   * (first use); throws `VaultIntegrityError` on any malformed/unknown content.
   */
  load(): VaultFileModel | null {
    let raw: string;
    try {
      raw = readFileSync(this.vaultPath, "utf8");
    } catch (error: unknown) {
      if (isRecord(error) && error["code"] === "ENOENT") {
        return null;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VaultIntegrityError("vault file is not valid JSON — failing closed");
    }
    return validateModel(parsed);
  }

  /**
   * Atomically persist the vault document (M6): temp file in the same directory
   * created 0600 → write → fsync → rename over the target. The parent directory
   * is created 0700 only if missing — pre-existing directories keep their mode.
   */
  save(model: VaultFileModel): void {
    const directory = dirname(this.vaultPath);
    mkdirSync(directory, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    const tmpPath = `${this.vaultPath}.tmp`;
    const data = serialize(model);
    // Remove any stale tmp first so the creation mode (0600) always applies.
    rmSync(tmpPath, { force: true });
    const fd = openSync(tmpPath, "wx", OWNER_ONLY_FILE_MODE);
    try {
      writeSync(fd, data, null, "utf8");
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      rmSync(tmpPath, { force: true });
      throw error;
    }
    closeSync(fd);
    renameSync(tmpPath, this.vaultPath); // atomic commit point
  }
}
