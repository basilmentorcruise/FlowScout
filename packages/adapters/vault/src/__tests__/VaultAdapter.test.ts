/**
 * VaultAdapter tests — the #101 acceptance criteria (store/retrieve/list/delete,
 * per-app scoping, otpSeed round-trip, keyless fail-closed).
 *
 * All credential/key fixtures are runtime-constructed (M11 — never hardcoded literals).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaintextCredential } from "@flowscout/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultKeyMissingError } from "../errors.js";
import { VaultAdapter } from "../VaultAdapter.js";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "flowscout-vault-adapter-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function freshSecret(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

function freshCredential(overrides: Partial<PlaintextCredential> = {}): PlaintextCredential {
  return {
    username: `${freshSecret("user")}@example.test`,
    password: freshSecret("pw"),
    otpSeed: null,
    ...overrides,
  };
}

function makeAdapter(masterSecret: string | null = freshSecret("master")): VaultAdapter {
  return new VaultAdapter({
    vaultPath: join(tempRoot, "vault.json"),
    keySource: () => masterSecret,
  });
}

describe("store + retrieve (AC1/AC2)", () => {
  it("round-trips the exact username and password", async () => {
    const adapter = makeAdapter();
    const credential = freshCredential();
    await adapter.store("com.example.app", "default", credential);
    await expect(adapter.retrieve("com.example.app", "default")).resolves.toEqual(credential);
  });

  it("round-trips a non-null otpSeed encrypted like the password (AC9/M10)", async () => {
    const adapter = makeAdapter();
    const credential = freshCredential({ otpSeed: freshSecret("totp-seed") });
    await adapter.store("com.example.app", "default", credential);
    const retrieved = await adapter.retrieve("com.example.app", "default");
    expect(retrieved?.otpSeed).toBe(credential.otpSeed);
  });

  it("overwrites an existing appId+label entry fully (M10/T12)", async () => {
    const adapter = makeAdapter();
    const first = freshCredential();
    const second = freshCredential({ otpSeed: freshSecret("totp-seed") });
    await adapter.store("com.example.app", "default", first);
    await adapter.store("com.example.app", "default", second);
    await expect(adapter.retrieve("com.example.app", "default")).resolves.toEqual(second);
    await expect(adapter.listLabels("com.example.app")).resolves.toEqual(["default"]);
  });
});

describe("retrieve misses (AC3)", () => {
  it("returns null when no vault file exists yet", async () => {
    await expect(makeAdapter().retrieve("com.example.app", "default")).resolves.toBeNull();
  });

  it("returns null for an unknown label — not an error, not a partial credential", async () => {
    const adapter = makeAdapter();
    await adapter.store("com.example.app", "default", freshCredential());
    await expect(adapter.retrieve("com.example.app", "other")).resolves.toBeNull();
  });

  it("returns null for an unknown appId", async () => {
    const adapter = makeAdapter();
    await adapter.store("com.example.app", "default", freshCredential());
    await expect(adapter.retrieve("com.other.app", "default")).resolves.toBeNull();
  });
});

describe("per-app scoping (AC4)", () => {
  it("isolates two apps sharing the same label — each only sees its own entry", async () => {
    const adapter = makeAdapter();
    const credentialA = freshCredential();
    const credentialB = freshCredential();
    await adapter.store("com.app.a", "default", credentialA);
    await adapter.store("com.app.b", "default", credentialB);
    await expect(adapter.retrieve("com.app.a", "default")).resolves.toEqual(credentialA);
    await expect(adapter.retrieve("com.app.b", "default")).resolves.toEqual(credentialB);
    await expect(adapter.listLabels("com.app.a")).resolves.toEqual(["default"]);
  });
});

describe("listLabels (AC5)", () => {
  it("returns only that app's labels and no secret material", async () => {
    const adapter = makeAdapter();
    const credential = freshCredential({ otpSeed: freshSecret("totp-seed") });
    await adapter.store("com.example.app", "main account", credential);
    await adapter.store("com.example.app", "test account", freshCredential());
    await adapter.store("com.other.app", "other-label", freshCredential());
    const labels = await adapter.listLabels("com.example.app");
    expect(labels).toEqual(["main account", "test account"]);
    const serialized = JSON.stringify(labels);
    expect(serialized).not.toContain(credential.username);
    expect(serialized).not.toContain(credential.password);
    expect(serialized).not.toContain(credential.otpSeed);
  });

  it("returns an empty list when nothing is stored", async () => {
    await expect(makeAdapter().listLabels("com.example.app")).resolves.toEqual([]);
  });
});

describe("delete (AC6)", () => {
  it("makes a subsequent retrieve return null", async () => {
    const adapter = makeAdapter();
    await adapter.store("com.example.app", "default", freshCredential());
    await adapter.delete("com.example.app", "default");
    await expect(adapter.retrieve("com.example.app", "default")).resolves.toBeNull();
    await expect(adapter.listLabels("com.example.app")).resolves.toEqual([]);
  });

  it("is a no-op for a missing entry or missing vault", async () => {
    const adapter = makeAdapter();
    await expect(adapter.delete("com.example.app", "default")).resolves.toBeUndefined();
    await adapter.store("com.example.app", "default", freshCredential());
    await expect(adapter.delete("com.example.app", "other")).resolves.toBeUndefined();
    await expect(adapter.retrieve("com.example.app", "default")).resolves.not.toBeNull();
  });

  it("leaves other entries intact", async () => {
    const adapter = makeAdapter();
    const kept = freshCredential();
    await adapter.store("com.example.app", "keep", kept);
    await adapter.store("com.example.app", "drop", freshCredential());
    await adapter.delete("com.example.app", "drop");
    await expect(adapter.retrieve("com.example.app", "keep")).resolves.toEqual(kept);
  });
});

describe("missing key — fail closed (AC7/M2)", () => {
  it("rejects every operation with VaultKeyMissingError when the key source yields null", async () => {
    const adapter = makeAdapter(null);
    await expect(adapter.store("app", "l", freshCredential())).rejects.toThrow(
      VaultKeyMissingError,
    );
    await expect(adapter.retrieve("app", "l")).rejects.toThrow(VaultKeyMissingError);
    await expect(adapter.listLabels("app")).rejects.toThrow(VaultKeyMissingError);
    await expect(adapter.delete("app", "l")).rejects.toThrow(VaultKeyMissingError);
  });

  it("rejects as a promise rejection, never a synchronous throw (port good citizenship)", () => {
    const adapter = makeAdapter(null);
    const pending = adapter.retrieve("app", "l");
    expect(pending).toBeInstanceOf(Promise);
    return expect(pending).rejects.toThrow(VaultKeyMissingError);
  });

  it("picks up a key configured after construction (lazy VaultKeySource, D1)", async () => {
    let masterSecret: string | null = null;
    const adapter = new VaultAdapter({
      vaultPath: join(tempRoot, "vault.json"),
      keySource: () => masterSecret,
    });
    await expect(adapter.listLabels("app")).rejects.toThrow(VaultKeyMissingError);
    masterSecret = freshSecret("master");
    await expect(adapter.listLabels("app")).resolves.toEqual([]);
  });
});

describe("default construction (pre-#102 wire.ts compatibility)", () => {
  it("constructs from env config and still fails closed without FLOWSCOUT_VAULT_KEY", async () => {
    vi.stubEnv("FLOWSCOUT_VAULT_KEY", "");
    try {
      const adapter = new VaultAdapter();
      // Key check fires BEFORE any file access, so no vault file is touched.
      await expect(adapter.listLabels("com.example.app")).rejects.toThrow(VaultKeyMissingError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
