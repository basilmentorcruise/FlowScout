/**
 * VaultFileStore tests — load/validate + deterministic serialization + atomic 0600 write
 * (#101, ADR-0011 D2; threat model M6/M7).
 *
 * Fixtures are runtime-constructed (M11) — every "secret-shaped" value comes from randomBytes.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultIntegrityError } from "../errors.js";
import {
  AUTH_TAG_LENGTH_BYTES,
  NONCE_LENGTH_BYTES,
  SALT_LENGTH_BYTES,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
} from "../VaultCrypto.js";
import { VaultFileStore, type VaultFileModel } from "../VaultFileStore.js";

const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const PERMISSION_MASK = 0o777;

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "flowscout-vault-store-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function vaultPathIn(root: string): string {
  return join(root, "data", "vault.json");
}

function freshModel(entries: VaultFileModel["entries"] = []): VaultFileModel {
  return {
    version: 1,
    kdf: {
      algo: "scrypt",
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: randomBytes(SALT_LENGTH_BYTES).toString("base64"),
    },
    entries,
  };
}

function freshEntry(appId: string, label: string): VaultFileModel["entries"][number] {
  return {
    appId,
    label,
    iv: randomBytes(NONCE_LENGTH_BYTES).toString("base64"),
    authTag: randomBytes(AUTH_TAG_LENGTH_BYTES).toString("base64"),
    ciphertext: randomBytes(48).toString("base64"),
  };
}

describe("load", () => {
  it("returns null when the vault file does not exist", () => {
    const store = new VaultFileStore(vaultPathIn(tempRoot));
    expect(store.load()).toBeNull();
  });

  it("round-trips a saved model", () => {
    const store = new VaultFileStore(vaultPathIn(tempRoot));
    const model = freshModel([freshEntry("app-a", "default")]);
    store.save(model);
    expect(store.load()).toEqual(model);
  });

  it("fails closed on malformed JSON", () => {
    const path = vaultPathIn(tempRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not-json{{{");
    expect(() => new VaultFileStore(path).load()).toThrow(VaultIntegrityError);
  });
});

describe("load — fail-closed validation", () => {
  it("fails closed on an unknown format version", () => {
    const path = vaultPathIn(tempRoot);
    const store = new VaultFileStore(path);
    store.save(freshModel());
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw["version"] = 99;
    writeFileSync(path, JSON.stringify(raw));
    expect(() => store.load()).toThrow(VaultIntegrityError);
  });

  it("fails closed on unexpected KDF parameters (algo / n / r / p)", () => {
    const path = vaultPathIn(tempRoot);
    const store = new VaultFileStore(path);
    store.save(freshModel());
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      kdf: Record<string, unknown>;
    };
    raw.kdf["n"] = 2; // tampered-down cost — must not be honored
    writeFileSync(path, JSON.stringify(raw));
    expect(() => store.load()).toThrow(VaultIntegrityError);
  });

  it("fails closed on a wrong-length KDF salt", () => {
    const path = vaultPathIn(tempRoot);
    const store = new VaultFileStore(path);
    store.save(freshModel());
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      kdf: Record<string, unknown>;
    };
    raw.kdf["salt"] = randomBytes(4).toString("base64");
    writeFileSync(path, JSON.stringify(raw));
    expect(() => store.load()).toThrow(VaultIntegrityError);
  });

  it("fails closed on a structurally invalid entry", () => {
    const path = vaultPathIn(tempRoot);
    const store = new VaultFileStore(path);
    store.save(freshModel([freshEntry("app-a", "default")]));
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      entries: Record<string, unknown>[];
    };
    delete raw.entries[0]?.["ciphertext"];
    writeFileSync(path, JSON.stringify(raw));
    expect(() => store.load()).toThrow(VaultIntegrityError);
  });
});

describe("load — fail-closed validation (document structure)", () => {
  it("fails closed when the document is valid JSON but not an object", () => {
    const path = vaultPathIn(tempRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(["not", "an", "object"]));
    expect(() => new VaultFileStore(path).load()).toThrow(VaultIntegrityError);
  });

  it("fails closed on an entry whose iv is not strictly valid base64", () => {
    const path = vaultPathIn(tempRoot);
    const store = new VaultFileStore(path);
    store.save(freshModel([freshEntry("app-a", "default")]));
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      entries: Record<string, unknown>[];
    };
    if (raw.entries[0]) {
      raw.entries[0]["iv"] = "*** not base64 ***";
    }
    writeFileSync(path, JSON.stringify(raw));
    expect(() => store.load()).toThrow(VaultIntegrityError);
  });

  it("propagates a non-ENOENT filesystem error instead of masking it as a miss", () => {
    // Reading a directory as a file raises EISDIR — must surface, not return null.
    mkdirSync(join(tempRoot, "iamadir"), { recursive: true });
    expect(() => new VaultFileStore(join(tempRoot, "iamadir")).load()).toThrow();
  });

  it("fails closed when entries is not an array", () => {
    const path = vaultPathIn(tempRoot);
    const store = new VaultFileStore(path);
    store.save(freshModel());
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw["entries"] = "nope";
    writeFileSync(path, JSON.stringify(raw));
    expect(() => store.load()).toThrow(VaultIntegrityError);
  });
});

describe("save — M6 atomic write, M7 permissions", () => {
  it("creates the parent directory 0700 and the vault file 0600", () => {
    const path = vaultPathIn(tempRoot);
    new VaultFileStore(path).save(freshModel());
    expect(statSync(dirname(path)).mode & PERMISSION_MASK).toBe(OWNER_ONLY_DIR);
    expect(statSync(path).mode & PERMISSION_MASK).toBe(OWNER_ONLY_FILE);
  });

  it("never chmods a pre-existing directory", () => {
    const path = vaultPathIn(tempRoot);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    new VaultFileStore(path).save(freshModel());
    expect(statSync(dir).mode & PERMISSION_MASK).toBe(0o755);
    expect(statSync(path).mode & PERMISSION_MASK).toBe(OWNER_ONLY_FILE);
  });

  it("leaves no temp file behind after a successful write", () => {
    const path = vaultPathIn(tempRoot);
    new VaultFileStore(path).save(freshModel());
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("preserves the previous vault bytes if the write is interrupted before rename", () => {
    const path = vaultPathIn(tempRoot);
    const store = new VaultFileStore(path);
    store.save(freshModel([freshEntry("app-a", "default")]));
    const before = readFileSync(path, "utf8");
    // Simulate a crash window: a leftover tmp exists but rename never happened —
    // the real vault must still parse (rename is the atomic commit point).
    writeFileSync(`${path}.tmp`, "garbage-partial-write");
    expect(store.load()).not.toBeNull();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("fully replaces the previous content on overwrite (no merge artifacts)", () => {
    const path = vaultPathIn(tempRoot);
    const store = new VaultFileStore(path);
    const first = freshModel([freshEntry("app-a", "default"), freshEntry("app-b", "default")]);
    store.save(first);
    const second = freshModel([freshEntry("app-c", "default")]);
    store.save(second);
    expect(store.load()).toEqual(second);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("app-a");
    expect(raw).not.toContain("app-b");
  });
});

describe("deterministic serialization (ADR-0011 D2)", () => {
  it("produces byte-identical output for the same model saved twice", () => {
    const path = vaultPathIn(tempRoot);
    const store = new VaultFileStore(path);
    const model = freshModel([freshEntry("app-a", "default"), freshEntry("app-b", "main")]);
    store.save(model);
    const first = readFileSync(path);
    store.save(model);
    expect(readFileSync(path).equals(first)).toBe(true);
  });

  it("sorts entries by (appId, label) regardless of insertion order", () => {
    const path = vaultPathIn(tempRoot);
    const store = new VaultFileStore(path);
    const entryZ = freshEntry("z-app", "default");
    const entryA2 = freshEntry("a-app", "second");
    const entryA1 = freshEntry("a-app", "alpha");
    store.save(freshModel([entryZ, entryA2, entryA1]));
    const loaded = store.load();
    expect(loaded?.entries.map((entry) => `${entry.appId}/${entry.label}`)).toEqual([
      "a-app/alpha",
      "a-app/second",
      "z-app/default",
    ]);
  });
});
