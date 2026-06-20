/**
 * VaultAdapter — stub implementing CredentialVaultPort.
 * Uses AES-256-GCM (Node built-in `crypto`) for encryption at rest.
 * Master key sourced from env var FLOWSCOUT_VAULT_KEY only — never committed.
 *
 * TODO (E6): Implement full AES-256-GCM encrypt/decrypt, per-app scoping,
 *            TOTP seed storage, and integration with the persistence adapter.
 */
import type { CredentialVaultPort, PlaintextCredential } from "@flowscout/domain";
// TODO (E6): import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`VaultAdapter.${method} is not yet implemented — see TODO (E6) in VaultAdapter.ts`),
  );
}

export class VaultAdapter implements CredentialVaultPort {
  // TODO (E6): constructor should receive the resolved vault key (from env) — never a default.

  store(_appId: string, _label: string, _credential: PlaintextCredential): Promise<void> {
    return notImplemented("store");
  }

  retrieve(_appId: string, _label: string): Promise<PlaintextCredential | null> {
    return notImplemented("retrieve");
  }

  listLabels(_appId: string): Promise<readonly string[]> {
    return notImplemented("listLabels");
  }

  delete(_appId: string, _label: string): Promise<void> {
    return notImplemented("delete");
  }
}
