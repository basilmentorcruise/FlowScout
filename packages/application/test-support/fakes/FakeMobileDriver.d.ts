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
export declare class FakeMobileDriver implements MobileDriverPort {
  readonly taps: Array<{
    udid: string;
    target: TapTarget;
  }>;
  readonly typedTexts: Array<{
    udid: string;
    text: string;
  }>;
  readonly swipes: Array<{
    udid: string;
    direction: SwipeDirection;
    distance?: number;
  }>;
  /** Override to control what snapshot is returned. */
  snapshotOverride: A11ySnapshot | null;
  listDevices(): Promise<readonly DeviceInfo[]>;
  snapshotAccessibilityTree(_udid: string): Promise<A11ySnapshot>;
  screenshot(_udid: string): Promise<ScreenshotBytes>;
  tap(udid: string, target: TapTarget): Promise<void>;
  typeText(udid: string, text: string): Promise<void>;
  swipe(udid: string, direction: SwipeDirection, distance?: number): Promise<void>;
}
export declare class FakeSimulatorLifecycle implements SimulatorLifecycle {
  readonly booted: string[];
  readonly installed: Array<{
    udid: string;
    path: string;
  }>;
  readonly launched: Array<{
    udid: string;
    bundleId: string;
  }>;
  readonly snapshots: Map<string, string>;
  readonly resets: Array<{
    udid: string;
    snapshotName: string;
  }>;
  readonly shutdowns: string[];
  bootSimulator(udid: string): Promise<void>;
  installApp(udid: string, appBundlePath: string): Promise<void>;
  launchApp(udid: string, bundleId: string): Promise<void>;
  takeSnapshot(udid: string, snapshotName: string): Promise<void>;
  resetToSnapshot(udid: string, snapshotName: string): Promise<void>;
  shutdownSimulator(udid: string): Promise<void>;
}
//# sourceMappingURL=FakeMobileDriver.d.ts.map
