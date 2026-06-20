/**
 * FakeCredentialVault — in-memory fake for CredentialVaultPort.
 * Stores plaintext in memory for tests (not encrypted — test use only).
 */
import type { CredentialVaultPort, PlaintextCredential } from "@flowscout/domain";
export declare class FakeCredentialVault implements CredentialVaultPort {
  private store;
  store(appId: string, label: string, credential: PlaintextCredential): Promise<void>;
  retrieve(appId: string, label: string): Promise<PlaintextCredential | null>;
  listLabels(appId: string): Promise<readonly string[]>;
  delete(appId: string, label: string): Promise<void>;
}
//# sourceMappingURL=FakeCredentialVault.d.ts.map
