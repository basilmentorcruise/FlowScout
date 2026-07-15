/**
 * vaultConfig — the ONLY place the vault adapter reads configuration/env (#101, ADR-0011 D1).
 *
 * The adapter class itself never touches `process.env` (DI): the composition root (#102)
 * calls `resolveVaultConfig(process.env)` and injects the result.
 *
 * Security:
 *   - M2 (T2): the master secret comes ONLY from `FLOWSCOUT_VAULT_KEY` — no literal,
 *     no default/fallback. Missing/empty ⇒ the key source yields `null` and every
 *     vault operation fails closed with `VaultKeyMissingError`.
 *   - Lazy `VaultKeySource` (D1): the env var is re-read on each call, so the API
 *     boots keyless (demo path) and picks the key up when configured.
 *   - M7 (T5): the vault path is config-owned (`FLOWSCOUT_VAULT_PATH`); the default
 *     `./.flowscout/vault.json` lives in the gitignored `.flowscout/` data dir and is
 *     a separate file from the E7 run DB (`FLOWSCOUT_DB_PATH`).
 */

/** Env var carrying the vault master secret (passphrase or high-entropy value). */
export const FLOWSCOUT_VAULT_KEY_ENV = "FLOWSCOUT_VAULT_KEY";

/** Env var naming the encrypted vault file (config-owned data location). */
export const FLOWSCOUT_VAULT_PATH_ENV = "FLOWSCOUT_VAULT_PATH";

/** Default vault location when `FLOWSCOUT_VAULT_PATH` is unset (ADR-0011 D2). */
export const DEFAULT_VAULT_PATH = "./.flowscout/vault.json";

/**
 * Lazy master-secret source: `null` means "not configured" (fail closed downstream).
 * NEVER returns a default value (M2).
 */
export type VaultKeySource = () => string | null;

export interface VaultConfig {
  readonly vaultPath: string;
  readonly keySource: VaultKeySource;
}

/** Resolve vault path + lazy key source from config/env (composition-root entry point). */
export function resolveVaultConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VaultConfig {
  const configuredPath = env[FLOWSCOUT_VAULT_PATH_ENV];
  const vaultPath =
    configuredPath !== undefined && configuredPath.trim().length > 0
      ? configuredPath
      : DEFAULT_VAULT_PATH;
  const keySource: VaultKeySource = () => {
    // Read lazily on every call (D1) — the API boots without a key configured.
    const secret = env[FLOWSCOUT_VAULT_KEY_ENV];
    return secret !== undefined && secret.trim().length > 0 ? secret : null;
  };
  return { vaultPath, keySource };
}
