/**
 * FakeMobileDriver — in-memory implementation of MobileDriverPort + SimulatorLifecycle.
 * Used in unit tests to drive the crawl engine deterministically without a real simulator.
 * This is the central test double for the F1 isolation pattern (ADR-0001 §2.6).
 */
import type {
  MobileDriverPort,
  SimulatorLifecycle,
  DeviceInfo,
  TapTarget,
  SwipeDirection,
  A11ySnapshot,
  ScreenshotBytes,
} from "@flowscout/domain";

const FAKE_DEVICE: DeviceInfo = {
  udid: "fake-udid-0001",
  name: "Fake iPhone 16",
  platform: "ios",
  osVersion: "18.0",
  state: "booted",
};

const FAKE_SNAPSHOT: A11ySnapshot =
  '{"role":"application","children":[{"role":"button","label":"OK"}]}' as A11ySnapshot;

export class FakeMobileDriver implements MobileDriverPort {
  readonly taps: Array<{ udid: string; target: TapTarget }> = [];
  readonly typedTexts: Array<{ udid: string; text: string }> = [];
  readonly swipes: Array<{ udid: string; direction: SwipeDirection; distance?: number }> = [];

  /** Override to control what snapshot is returned. */
  snapshotOverride: A11ySnapshot | null = null;

  async listDevices(): Promise<readonly DeviceInfo[]> {
    return [FAKE_DEVICE];
  }

  async snapshotAccessibilityTree(_udid: string): Promise<A11ySnapshot> {
    return this.snapshotOverride ?? FAKE_SNAPSHOT;
  }

  async screenshot(_udid: string): Promise<ScreenshotBytes> {
    return Buffer.from("fake-png-bytes");
  }

  async tap(udid: string, target: TapTarget): Promise<void> {
    this.taps.push({ udid, target });
  }

  async typeText(udid: string, text: string): Promise<void> {
    this.typedTexts.push({ udid, text });
  }

  async swipe(udid: string, direction: SwipeDirection, distance?: number): Promise<void> {
    this.swipes.push({ udid, direction, distance });
  }
}

export class FakeSimulatorLifecycle implements SimulatorLifecycle {
  readonly booted: string[] = [];
  readonly installed: Array<{ udid: string; path: string }> = [];
  readonly launched: Array<{ udid: string; bundleId: string }> = [];
  readonly snapshots: Map<string, string> = new Map();
  readonly resets: Array<{ udid: string; snapshotName: string }> = [];
  readonly shutdowns: string[] = [];

  async bootSimulator(udid: string): Promise<void> {
    this.booted.push(udid);
  }

  async installApp(udid: string, appBundlePath: string): Promise<void> {
    this.installed.push({ udid, path: appBundlePath });
  }

  async launchApp(udid: string, bundleId: string): Promise<void> {
    this.launched.push({ udid, bundleId });
  }

  async takeSnapshot(udid: string, snapshotName: string): Promise<void> {
    this.snapshots.set(`${udid}:${snapshotName}`, new Date().toISOString());
  }

  async resetToSnapshot(udid: string, snapshotName: string): Promise<void> {
    this.resets.push({ udid, snapshotName });
  }

  async shutdownSimulator(udid: string): Promise<void> {
    this.shutdowns.push(udid);
  }
}
