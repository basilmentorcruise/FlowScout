/**
 * FakeCredentialVault — in-memory fake for CredentialVaultPort.
 * Stores plaintext in memory for tests (not encrypted — test use only).
 */
import type { CredentialVaultPort, PlaintextCredential } from "@flowscout/domain";

export class FakeCredentialVault implements CredentialVaultPort {
  // key: `${appId}:${label}`
  private store = new Map<string, PlaintextCredential>();

  async store(appId: string, label: string, credential: PlaintextCredential): Promise<void> {
    this.store.set(`${appId}:${label}`, credential);
  }

  async retrieve(appId: string, label: string): Promise<PlaintextCredential | null> {
    return this.store.get(`${appId}:${label}`) ?? null;
  }

  async listLabels(appId: string): Promise<readonly string[]> {
    const prefix = `${appId}:`;
    return [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  async delete(appId: string, label: string): Promise<void> {
    this.store.delete(`${appId}:${label}`);
  }
}
