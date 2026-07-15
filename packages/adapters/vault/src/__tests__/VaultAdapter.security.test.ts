/**
 * VaultAdapter adversarial suite — threat-model evidence for #101 (M1–M10).
 *
 * Attacks the PERSISTED bytes directly: wrong key, tampered ciphertext/tag,
 * cross-entry blob swap (AAD), plaintext-on-disk scan, delete-removes-ciphertext,
 * permissions, and re-store nonce freshness.
 *
 * All secret-shaped fixtures are runtime-constructed (M11 — gitleaks-clean).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PlaintextCredential } from "@flowscout/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultIntegrityError } from "../errors.js";
import { VaultAdapter } from "../VaultAdapter.js";
import { buildAad, deriveKey, seal } from "../VaultCrypto.js";
import { freshCredential as buildCredential, freshSecret } from "./fixtures.js";

const PERMISSION_MASK = 0o777;

let tempRoot: string;
let vaultPath: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "flowscout-vault-sec-"));
  vaultPath = join(tempRoot, "vault.json");
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/** Security-suite credentials always carry a non-null otpSeed (max secret surface). */
function freshCredential(): PlaintextCredential {
  return buildCredential({ otpSeed: freshSecret("totp-seed") });
}

function adapterWith(masterSecret: string): VaultAdapter {
  return new VaultAdapter({ vaultPath, keySource: () => masterSecret });
}

interface RawEntry {
  appId: string;
  label: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function readRawEntries(): RawEntry[] {
  return (JSON.parse(readFileSync(vaultPath, "utf8")) as { entries: RawEntry[] }).entries;
}

function rawEntry(appId: string, label = "default"): RawEntry {
  const entry = readRawEntries().find(
    (candidate) => candidate.appId === appId && candidate.label === label,
  );
  if (entry === undefined) {
    throw new Error(`test setup: expected a raw vault entry for ${appId}/${label}`);
  }
  return entry;
}

function writeRawEntries(entries: RawEntry[]): void {
  const raw = JSON.parse(readFileSync(vaultPath, "utf8")) as Record<string, unknown>;
  raw["entries"] = entries;
  writeFileSync(vaultPath, JSON.stringify(raw));
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("AC7 — wrong key fails closed", () => {
  it("rejects retrieve under a different master secret with a secret-free VaultIntegrityError", async () => {
    const credential = freshCredential();
    await adapterWith(freshSecret("master-a")).store("com.example.app", "default", credential);
    const attacker = adapterWith(freshSecret("master-b"));
    const caught = await captureRejection(attacker.retrieve("com.example.app", "default"));
    expect(caught).toBeInstanceOf(VaultIntegrityError);
    const message = (caught as Error).message;
    expect(message).not.toContain(credential.username);
    expect(message).not.toContain(credential.password);
    expect(message).not.toContain(credential.otpSeed);
  });
});

describe("AC8 — tampered persisted bytes are rejected", () => {
  function flipBase64Byte(value: string): string {
    const bytes = Buffer.from(value, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    return bytes.toString("base64");
  }

  it("rejects a flipped ciphertext byte", async () => {
    const master = freshSecret("master");
    await adapterWith(master).store("com.example.app", "default", freshCredential());
    const entry = rawEntry("com.example.app");
    writeRawEntries([{ ...entry, ciphertext: flipBase64Byte(entry.ciphertext) }]);
    await expect(adapterWith(master).retrieve("com.example.app", "default")).rejects.toThrow(
      VaultIntegrityError,
    );
  });

  it("rejects a flipped auth-tag byte", async () => {
    const master = freshSecret("master");
    await adapterWith(master).store("com.example.app", "default", freshCredential());
    const entry = rawEntry("com.example.app");
    writeRawEntries([{ ...entry, authTag: flipBase64Byte(entry.authTag) }]);
    await expect(adapterWith(master).retrieve("com.example.app", "default")).rejects.toThrow(
      VaultIntegrityError,
    );
  });
});

describe("M5 — cross-entry blob swap is defeated by AAD binding", () => {
  it("rejects app A's blob transplanted under app B's entry (and vice versa)", async () => {
    const master = freshSecret("master");
    const adapter = adapterWith(master);
    await adapter.store("com.app.a", "default", freshCredential());
    await adapter.store("com.app.b", "default", freshCredential());
    const entryA = rawEntry("com.app.a");
    const entryB = rawEntry("com.app.b");
    // Swap the full sealed blobs between the two identities — valid key, valid
    // tag, wrong identity: GCM must fail because AAD binds appId+label+version.
    writeRawEntries([
      { ...entryA, iv: entryB.iv, authTag: entryB.authTag, ciphertext: entryB.ciphertext },
      { ...entryB, iv: entryA.iv, authTag: entryA.authTag, ciphertext: entryA.ciphertext },
    ]);
    const reader = adapterWith(master);
    await expect(reader.retrieve("com.app.a", "default")).rejects.toThrow(VaultIntegrityError);
    await expect(reader.retrieve("com.app.b", "default")).rejects.toThrow(VaultIntegrityError);
  });
});

describe("M1 — re-store draws a fresh nonce", () => {
  it("re-storing the SAME credential produces a different nonce and ciphertext", async () => {
    const master = freshSecret("master");
    const adapter = adapterWith(master);
    const credential = freshCredential();
    await adapter.store("com.example.app", "default", credential);
    const before = rawEntry("com.example.app");
    await adapter.store("com.example.app", "default", credential);
    const after = rawEntry("com.example.app");
    expect(after.iv).not.toBe(before.iv);
    expect(after.ciphertext).not.toBe(before.ciphertext);
    expect(readRawEntries()).toHaveLength(1);
  });
});

describe("AC1/M6 — no plaintext anywhere in the persisted bytes", () => {
  it("never writes username/password/otpSeed markers to disk in any byte encoding", async () => {
    const credential = freshCredential();
    await adapterWith(freshSecret("master")).store("com.example.app", "default", credential);
    const rawBytes = readFileSync(vaultPath);
    const markers = [credential.username, credential.password, credential.otpSeed ?? ""];
    for (const encoding of ["utf8", "latin1"] as const) {
      const text = rawBytes.toString(encoding);
      for (const marker of markers) {
        expect(text).not.toContain(marker);
      }
    }
    // Also scan for base64-embedded plaintext (a plaintext blob "encrypted" by
    // base64-encoding alone would slip past a pure substring scan).
    const asText = rawBytes.toString("utf8");
    for (const marker of markers) {
      expect(asText).not.toContain(Buffer.from(marker, "utf8").toString("base64"));
    }
  });

  it("leaves no temp file (plaintext or otherwise) after store", async () => {
    await adapterWith(freshSecret("master")).store("com.example.app", "default", freshCredential());
    expect(() => statSync(`${vaultPath}.tmp`)).toThrow();
  });
});

describe("M8 — delete removes the ciphertext from the persisted store", () => {
  it("erases the entry's ciphertext bytes from disk, not just the index", async () => {
    const master = freshSecret("master");
    const adapter = adapterWith(master);
    await adapter.store("com.example.app", "default", freshCredential());
    await adapter.store("com.example.app", "backup", freshCredential());
    const target = rawEntry("com.example.app", "default");
    await adapter.delete("com.example.app", "default");
    const rawAfter = readFileSync(vaultPath, "utf8");
    expect(rawAfter).not.toContain(target.ciphertext);
    expect(rawAfter).not.toContain(target.iv);
    await expect(adapter.retrieve("com.example.app", "default")).resolves.toBeNull();
  });
});

describe("M7 — permissions on everything the adapter creates", () => {
  it("creates the vault file 0600 and its directory 0700", async () => {
    const nestedPath = join(tempRoot, "nested", "vault.json");
    const adapter = new VaultAdapter({
      vaultPath: nestedPath,
      keySource: () => freshSecret("master"),
    });
    await adapter.store("com.example.app", "default", freshCredential());
    expect(statSync(nestedPath).mode & PERMISSION_MASK).toBe(0o600);
    expect(statSync(dirname(nestedPath)).mode & PERMISSION_MASK).toBe(0o700);
  });
});

describe("fail closed on malformed stores", () => {
  it("rejects an unknown vault format version on every read path", async () => {
    const master = freshSecret("master");
    await adapterWith(master).store("com.example.app", "default", freshCredential());
    const raw = JSON.parse(readFileSync(vaultPath, "utf8")) as Record<string, unknown>;
    raw["version"] = 2;
    writeFileSync(vaultPath, JSON.stringify(raw));
    const adapter = adapterWith(master);
    await expect(adapter.retrieve("com.example.app", "default")).rejects.toThrow(
      VaultIntegrityError,
    );
    await expect(adapter.listLabels("com.example.app")).rejects.toThrow(VaultIntegrityError);
  });

  it("rejects a forged ciphertext with a typed error carrying identity only (M9)", async () => {
    const master = freshSecret("master");
    const adapter = adapterWith(master);
    await adapter.store("com.example.app", "default", freshCredential());
    const entry = rawEntry("com.example.app");
    writeRawEntries([{ ...entry, ciphertext: randomBytes(32).toString("base64") }]);
    const caught = await captureRejection(adapter.retrieve("com.example.app", "default"));
    expect(caught).toBeInstanceOf(VaultIntegrityError);
    expect((caught as Error).message).toContain("com.example.app/default");
  });
});

describe("fail closed on validly-encrypted non-credential payloads", () => {
  /** Forge an entry with the REAL key (worst case: attacker knows the master secret). */
  function forgeEntry(master: string, payload: Buffer): void {
    const raw = JSON.parse(readFileSync(vaultPath, "utf8")) as {
      kdf: { salt: string };
    };
    const key = deriveKey(master, Buffer.from(raw.kdf.salt, "base64"));
    const blob = seal(key, buildAad("com.example.app", "default"), payload);
    const entry = rawEntry("com.example.app");
    writeRawEntries([
      {
        ...entry,
        iv: blob.iv.toString("base64"),
        authTag: blob.authTag.toString("base64"),
        ciphertext: blob.ciphertext.toString("base64"),
      },
    ]);
    key.fill(0);
  }

  it("rejects a payload that is not JSON (never returns partial plaintext)", async () => {
    const master = freshSecret("master");
    const adapter = adapterWith(master);
    await adapter.store("com.example.app", "default", freshCredential());
    forgeEntry(master, Buffer.from(`garbage-${randomBytes(6).toString("hex")}`, "utf8"));
    await expect(adapter.retrieve("com.example.app", "default")).rejects.toThrow(
      VaultIntegrityError,
    );
  });

  it("rejects a JSON payload that is not a credential shape", async () => {
    const master = freshSecret("master");
    const adapter = adapterWith(master);
    await adapter.store("com.example.app", "default", freshCredential());
    forgeEntry(master, Buffer.from(JSON.stringify({ unexpected: true }), "utf8"));
    const caught = await captureRejection(adapter.retrieve("com.example.app", "default"));
    expect(caught).toBeInstanceOf(VaultIntegrityError);
    expect((caught as Error).message).toContain("unexpected shape");
  });
});
