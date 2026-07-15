export { VaultAdapter, type VaultAdapterOptions } from "./VaultAdapter.js";
export { VaultIntegrityError, VaultKeyMissingError } from "./errors.js";
export {
  DEFAULT_VAULT_PATH,
  FLOWSCOUT_VAULT_KEY_ENV,
  FLOWSCOUT_VAULT_PATH_ENV,
  resolveVaultConfig,
  type VaultConfig,
  type VaultKeySource,
} from "./vaultConfig.js";
