const FAKE_DEVICE = {
  udid: "fake-udid-0001",
  name: "Fake iPhone 16",
  platform: "ios",
  osVersion: "18.0",
  state: "booted",
};
const FAKE_SNAPSHOT = '{"role":"application","children":[{"role":"button","label":"OK"}]}';
export class FakeMobileDriver {
  taps = [];
  typedTexts = [];
  swipes = [];
  /** Override to control what snapshot is returned. */
  snapshotOverride = null;
  async listDevices() {
    return [FAKE_DEVICE];
  }
  async snapshotAccessibilityTree(_udid) {
    return this.snapshotOverride ?? FAKE_SNAPSHOT;
  }
  async screenshot(_udid) {
    return Buffer.from("fake-png-bytes");
  }
  async tap(udid, target) {
    this.taps.push({ udid, target });
  }
  async typeText(udid, text) {
    this.typedTexts.push({ udid, text });
  }
  async swipe(udid, direction, distance) {
    this.swipes.push({ udid, direction, distance });
  }
}
export class FakeSimulatorLifecycle {
  booted = [];
  installed = [];
  launched = [];
  snapshots = new Map();
  resets = [];
  shutdowns = [];
  async bootSimulator(udid) {
    this.booted.push(udid);
  }
  async installApp(udid, appBundlePath) {
    this.installed.push({ udid, path: appBundlePath });
  }
  async launchApp(udid, bundleId) {
    this.launched.push({ udid, bundleId });
  }
  async takeSnapshot(udid, snapshotName) {
    this.snapshots.set(`${udid}:${snapshotName}`, new Date().toISOString());
  }
  async resetToSnapshot(udid, snapshotName) {
    this.resets.push({ udid, snapshotName });
  }
  async shutdownSimulator(udid) {
    this.shutdowns.push(udid);
  }
}
//# sourceMappingURL=FakeMobileDriver.js.map
