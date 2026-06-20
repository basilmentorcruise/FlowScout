export class FakeCredentialVault {
  // key: `${appId}:${label}`
  store = new Map();
  async store(appId, label, credential) {
    this.store.set(`${appId}:${label}`, credential);
  }
  async retrieve(appId, label) {
    return this.store.get(`${appId}:${label}`) ?? null;
  }
  async listLabels(appId) {
    const prefix = `${appId}:`;
    return [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }
  async delete(appId, label) {
    this.store.delete(`${appId}:${label}`);
  }
}
//# sourceMappingURL=FakeCredentialVault.js.map
