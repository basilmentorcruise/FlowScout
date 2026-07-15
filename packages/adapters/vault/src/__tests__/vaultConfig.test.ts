/**
 * vaultConfig tests — env resolution + lazy VaultKeySource (#101, ADR-0011 D1; M2).
 * Key fixtures are runtime-constructed (M11).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VAULT_PATH,
  FLOWSCOUT_VAULT_KEY_ENV,
  FLOWSCOUT_VAULT_PATH_ENV,
  resolveVaultConfig,
} from "../vaultConfig.js";

describe("resolveVaultConfig", () => {
  it("defaults the vault path to ./.flowscout/vault.json (gitignored, never the run DB)", () => {
    const { vaultPath } = resolveVaultConfig({});
    expect(vaultPath).toBe(DEFAULT_VAULT_PATH);
    expect(DEFAULT_VAULT_PATH).toBe("./.flowscout/vault.json");
  });

  it("uses FLOWSCOUT_VAULT_PATH when set", () => {
    const { vaultPath } = resolveVaultConfig({
      [FLOWSCOUT_VAULT_PATH_ENV]: "/somewhere/else/vault.json",
    });
    expect(vaultPath).toBe("/somewhere/else/vault.json");
  });

  it("falls back to the default path for a whitespace-only FLOWSCOUT_VAULT_PATH", () => {
    const { vaultPath } = resolveVaultConfig({ [FLOWSCOUT_VAULT_PATH_ENV]: "   " });
    expect(vaultPath).toBe(DEFAULT_VAULT_PATH);
  });

  it("keySource returns the configured master secret (M2 — env only, no default)", () => {
    const secret = `master-${randomBytes(9).toString("hex")}`;
    const { keySource } = resolveVaultConfig({ [FLOWSCOUT_VAULT_KEY_ENV]: secret });
    expect(keySource()).toBe(secret);
  });

  it("keySource returns null (NOT a fallback key) when the env var is missing or empty", () => {
    expect(resolveVaultConfig({}).keySource()).toBeNull();
    expect(resolveVaultConfig({ [FLOWSCOUT_VAULT_KEY_ENV]: "" }).keySource()).toBeNull();
    expect(resolveVaultConfig({ [FLOWSCOUT_VAULT_KEY_ENV]: "   " }).keySource()).toBeNull();
  });

  it("keySource is lazy — a key set AFTER resolveVaultConfig is picked up (API boots keyless)", () => {
    const env: Record<string, string | undefined> = {};
    const { keySource } = resolveVaultConfig(env);
    expect(keySource()).toBeNull();
    const secret = `master-${randomBytes(9).toString("hex")}`;
    env[FLOWSCOUT_VAULT_KEY_ENV] = secret;
    expect(keySource()).toBe(secret);
  });
});
