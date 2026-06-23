/**
 * lifecycle.contract.test.ts — #14 (E1.3) simulator lifecycle contract tests.
 *
 * Strategy (ADR-0003 §1.1 / AC8 fix):
 *   AC8 requires the shared contract suite to run against the REAL
 *   SimulatorLifecycleManager using `runLifecycleContract` (ADR-0003 per-capability
 *   section runner). The previous approach ran it against FakeMobileDriver, which
 *   did NOT satisfy the "real adapter" requirement.
 *
 *   The real SimulatorLifecycleManager is constructed with:
 *   - A mocked Exec (makeSimctlExec) that returns canned simctl output so no
 *     real simulator is required. CONTRACT_UNKNOWN_UDID is listed as an unknown
 *     device so the §6(lifecycle) unknown-UDID sections receive DeviceNotFoundError.
 *   - A real temp .app directory (created synchronously at module level) so that
 *     the manager's T2 filesystem path canonicalization succeeds on the happy path
 *     without a real .app bundle on disk.
 *
 *   All default injection UDIDs, bundleIds, and appPaths exercise the real
 *   validateUdid / validateBundleId / validateAppPathFormat guards and produce
 *   LifecycleInputError as required by §7, §8, and §10 contract sections.
 *
 *   The dedicated unit tests below (§1–§6) are KEPT — they cover edge cases and
 *   error scenarios complementary to the contract runner.
 *
 * Tool-vs-simctl mapping (ALL lifecycle methods use simctl fallback — no MCP tool):
 *   listDevices       → simctl: xcrun simctl list devices --json
 *   bootSimulator     → simctl: xcrun simctl boot <udid>
 *   installApp        → simctl: xcrun simctl install <udid> <canonical-path>
 *   launchApp         → simctl: xcrun simctl launch <udid> <bundleId>
 *   shutdownSimulator → simctl: xcrun simctl shutdown <udid>
 *
 * Rationale (ADR-0002 §4/OQ2): device lifecycle is a host concern; no mobile-mcp
 * tool covers boot/install/launch/shutdown. simctl is the correct and stable layer.
 *
 * Security conformance (threat model E1):
 *   T1 — injection UDIDs / bundleIds rejected before exec is called (validation first)
 *   T2 — installApp path traversal / outside-base dir rejected before exec call
 *   T3 — config-injected callTimeoutMs bounds every simctl call (no magic numbers)
 *   T5 — error messages name categories, not raw values (no injection payload echoing)
 *   T8 — shutdownSimulator idempotent: already-shutdown = success (no orphan)
 *
 * ACs covered:
 *   AC1 listDevices returns DeviceInfo[] with required shape
 *   AC2 bootSimulator(valid udid) -> resolves
 *   AC3 installApp(booted, valid .app path) -> resolves
 *   AC4 launchApp(installed, bundleId) -> resolves; wrong bundleId -> LaunchFailedError
 *   AC5 installApp(bad path) -> InstallFailedError
 *   AC6 unknown udid -> DeviceNotFoundError (all lifecycle methods)
 *   AC7 shutdownSimulator -> success; repeated calls -> idempotent (no hang, no orphan)
 *   AC8 runLifecycleContract passes against the REAL SimulatorLifecycleManager
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as fsPromises from "node:fs/promises";
import { runLifecycleContract } from "../testing/index.js";
import {
  SimulatorLifecycleManager,
  LifecycleInputError,
  InstallFailedError,
  LaunchFailedError,
} from "../lifecycle/SimulatorLifecycleManager.js";
import { DeviceNotFoundError } from "../connection/errors.js";
import type { McpConnection } from "../connection/McpConnection.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import type { Exec } from "../simctl.js";
import type { DeviceInfo } from "@flowscout/domain";

// ---------------------------------------------------------------------------
// Constants (no magic numbers per ADR-0001 §6)
// ---------------------------------------------------------------------------

const VALID_UDID = "AABBCCDD-1234-5678-9ABC-DEF012345678";
const VALID_BUNDLE_ID = "com.example.flowscout.test";
const UNKNOWN_UDID = "00000000-DEAD-BEEF-CAFE-FFFFFFFFFFFF";
const CALL_TIMEOUT_MS = 10_000;

// UDID used as the contract runner unknownUdid fixture (distinct from UNKNOWN_UDID
// to avoid accidental fixture collision with unit test constants).
const CONTRACT_UNKNOWN_UDID = "FFFFFFFF-0000-0000-0000-AABBCCDDEEFF";

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const TEST_CONFIG: McpServerConfig = {
  serverCommand: ["npx", "mobile-mcp"],
  serverEnv: { PATH: "/usr/bin" },
  connectTimeoutMs: 5_000,
  callTimeoutMs: CALL_TIMEOUT_MS,
};

/** Stub McpConnection — lifecycle never calls MCP tools (all simctl). */
const STUB_CONNECTION = {} as unknown as McpConnection;

// ---------------------------------------------------------------------------
// Fake Exec factory
// ---------------------------------------------------------------------------

const FAKE_SIMCTL_LIST_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
      {
        udid: VALID_UDID,
        name: "FlowScout Test iPhone",
        state: "Booted",
        isAvailable: true,
      },
    ],
  },
});

/** Build a fake Exec simulating xcrun simctl responses without touching the OS. */
function makeSimctlExec(opts?: {
  unknownUdids?: readonly string[];
  launchFails?: boolean;
  installFails?: boolean;
}): Exec {
  const unknownUdids = opts?.unknownUdids ?? [];
  const launchFails = opts?.launchFails ?? false;
  const installFails = opts?.installFails ?? false;

  return vi.fn().mockImplementation(async (_file: string, args: readonly string[]) => {
    const subcommand = args[1]; // args = ["simctl", subcommand, ...]
    const targetUdid = args[2];

    if (
      targetUdid !== undefined &&
      !["list"].includes(subcommand ?? "") &&
      unknownUdids.includes(targetUdid)
    ) {
      throw new Error(`Invalid device: ${targetUdid}`);
    }

    switch (subcommand) {
      case "list":
        return { stdout: FAKE_SIMCTL_LIST_JSON, stderr: "" };
      case "boot":
        return { stdout: "", stderr: "" };
      case "install":
        if (installFails) throw new Error("simctl install: unknown error");
        return { stdout: "", stderr: "" };
      case "launch":
        if (launchFails) throw new Error("The operation couldn't be completed");
        return { stdout: `${args[3] ?? "unknown"}: 12345`, stderr: "" };
      case "shutdown":
        return { stdout: "", stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  });
}

// ---------------------------------------------------------------------------
// Temp .app directory helper (T2: real filesystem path validation)
// ---------------------------------------------------------------------------

async function makeTempAppDir(): Promise<{
  appPath: string;
  baseDir: string;
  cleanup: () => Promise<void>;
}> {
  const baseDir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "flowscout-test-"));
  const appPath = nodePath.join(baseDir, "Fixture.app");
  await fsPromises.mkdir(appPath, { recursive: true });
  return {
    baseDir,
    appPath,
    cleanup: async () => {
      await fsPromises.rm(baseDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// AC8 — runLifecycleContract against the REAL SimulatorLifecycleManager (ADR-0003)
//
// The contract runner is invoked with a factory that constructs the REAL
// SimulatorLifecycleManager with:
//   - A mocked Exec that returns canned simctl output (no real xcrun / simulator).
//     CONTRACT_UNKNOWN_UDID is listed as an unknown device so the §6(lifecycle)
//     unknown-UDID sections receive DeviceNotFoundError as required.
//   - A real temp .app directory (CONTRACT_APP_PATH, created synchronously below)
//     so the manager's T2 filesystem path canonicalization succeeds on the happy
//     path without a real .app bundle present.
//
// The default injection vectors in the contract runner (DEFAULT_INJECTION_UDIDS,
// DEFAULT_INJECTION_BUNDLE_IDS, DEFAULT_INJECTION_APP_PATHS) exercise the real
// guards and all produce LifecycleInputError, satisfying §7, §8, and §10.
// ---------------------------------------------------------------------------

// Create the contract fixture .app dir synchronously so it is available before
// describe() blocks execute (describe() runs synchronously at module load time).
const CONTRACT_BASE_DIR: string = fs.mkdtempSync(nodePath.join(os.tmpdir(), "flowscout-contract-"));
const CONTRACT_APP_PATH: string = nodePath.join(CONTRACT_BASE_DIR, "Contract.app");
fs.mkdirSync(CONTRACT_APP_PATH, { recursive: true });

// Clean up the shared temp dir after all tests in this file finish.
afterAll(async () => {
  await fsPromises.rm(CONTRACT_BASE_DIR, { recursive: true, force: true });
});

runLifecycleContract({
  createLifecycle: () =>
    new SimulatorLifecycleManager(
      STUB_CONNECTION,
      TEST_CONFIG,
      // Mocked Exec: returns canned simctl output; CONTRACT_UNKNOWN_UDID triggers
      // "Invalid device: <udid>" which SimulatorLifecycleManager maps to DeviceNotFoundError.
      makeSimctlExec({ unknownUdids: [CONTRACT_UNKNOWN_UDID] }),
      CONTRACT_BASE_DIR,
    ),
  fixtures: {
    validUdid: VALID_UDID,
    validBundleId: VALID_BUNDLE_ID,
    installablePath: CONTRACT_APP_PATH,
    unknownUdid: CONTRACT_UNKNOWN_UDID,
    // injectionUdids, injectionBundleIds, injectionAppPaths: omitted to use the
    // runner's DEFAULT_INJECTION_* vectors, which exercise all T1/T2 patterns.
  },
  errorClasses: {
    unknownDevice: DeviceNotFoundError,
    invalidInput: LifecycleInputError,
  },
});

// ---------------------------------------------------------------------------
// §1 — listDevices unit tests (AC1)
// ---------------------------------------------------------------------------

describe("SimulatorLifecycleManager — listDevices (AC1)", () => {
  it("returns DeviceInfo[] with required shape (udid/name/platform/osVersion/state)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    const devices = await mgr.listDevices();
    expect(Array.isArray(devices)).toBe(true);
    expect(devices.length).toBe(1);
    const d = devices[0] as DeviceInfo;
    expect(typeof d.udid).toBe("string");
    expect(typeof d.name).toBe("string");
    expect(d.platform).toBe("ios");
    expect(typeof d.osVersion).toBe("string");
    expect(["booted", "shutdown", "unknown"]).toContain(d.state);
  });

  it("returns parsed device with correct field values from simctl JSON", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    const devices = await mgr.listDevices();
    const d = devices[0] as DeviceInfo;
    expect(d.udid).toBe(VALID_UDID);
    expect(d.name).toBe("FlowScout Test iPhone");
    expect(d.platform).toBe("ios");
    expect(d.osVersion).toBe("iOS 17.5");
    expect(d.state).toBe("booted");
  });

  it("returns empty array when simctl returns empty devices object", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ devices: {} }),
      stderr: "",
    });
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.listDevices()).resolves.toEqual([]);
  });

  it("returns empty array on malformed JSON output (defensive — no crash)", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "not-json!", stderr: "" });
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.listDevices()).resolves.toEqual([]);
  });

  it("calls xcrun simctl list devices --json (T1 — argv array, no shell string)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await mgr.listDevices();
    expect(exec).toHaveBeenCalledWith("xcrun", ["simctl", "list", "devices", "--json"]);
  });

  it("maps 'Booted' -> 'booted' and unknown states -> 'unknown'", async () => {
    const execBooted = makeSimctlExec();
    const mgrBooted = new SimulatorLifecycleManager(
      STUB_CONNECTION,
      TEST_CONFIG,
      execBooted,
      os.tmpdir(),
    );
    expect((await mgrBooted.listDevices())[0]?.state).toBe("booted");

    const execUnknown = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
            { udid: VALID_UDID, name: "X", state: "Creating" },
          ],
        },
      }),
      stderr: "",
    });
    const mgrUnknown = new SimulatorLifecycleManager(
      STUB_CONNECTION,
      TEST_CONFIG,
      execUnknown,
      os.tmpdir(),
    );
    expect((await mgrUnknown.listDevices())[0]?.state).toBe("unknown");
  });

  it("all returned devices have platform 'ios'", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    const devices = await mgr.listDevices();
    for (const d of devices) {
      expect(d.platform).toBe("ios");
    }
  });
});

// ---------------------------------------------------------------------------
// §2 — bootSimulator (AC2, AC6, T1)
// ---------------------------------------------------------------------------

describe("SimulatorLifecycleManager — bootSimulator (AC2/AC6/T1)", () => {
  it("AC2: resolves for a valid UDID", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.bootSimulator(VALID_UDID)).resolves.toBeUndefined();
  });

  it("calls xcrun simctl boot <udid> (T1 — argv array, no shell string)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await mgr.bootSimulator(VALID_UDID);
    expect(exec).toHaveBeenCalledWith("xcrun", ["simctl", "boot", VALID_UDID]);
  });

  it("AC6: throws DeviceNotFoundError for unknown UDID", async () => {
    const exec = makeSimctlExec({ unknownUdids: [UNKNOWN_UDID] });
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.bootSimulator(UNKNOWN_UDID)).rejects.toBeInstanceOf(DeviceNotFoundError);
  });

  it("T1: throws LifecycleInputError for injection-shaped UDID (all vectors)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    const injections = [
      "; rm -rf ~",
      "$(echo injected)",
      "--flag-injection",
      "",
      "a".repeat(512),
      "udid\x00nul",
    ];
    for (const bad of injections) {
      await expect(mgr.bootSimulator(bad)).rejects.toBeInstanceOf(LifecycleInputError);
    }
  });

  it("T1: does NOT call exec when UDID is invalid (validation before argv construction)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.bootSimulator("; rm -rf ~")).rejects.toBeInstanceOf(LifecycleInputError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("treats 'already booted' simctl error as success (idempotent)", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("Unable to boot device — already booted"));
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.bootSimulator(VALID_UDID)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §3 — installApp (AC3, AC5, AC6, T1, T2)
// ---------------------------------------------------------------------------

describe("SimulatorLifecycleManager — installApp (AC3/AC5/AC6/T1/T2)", () => {
  let tempDir: { appPath: string; baseDir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tempDir = await makeTempAppDir();
  });

  it("AC3: resolves for a valid .app directory within the allowlisted base dir", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, tempDir.baseDir);
    await expect(mgr.installApp(VALID_UDID, tempDir.appPath)).resolves.toBeUndefined();
    await tempDir.cleanup();
  });

  it("calls xcrun simctl install <udid> <canonical-path> (T1 — argv, no shell)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, tempDir.baseDir);
    await mgr.installApp(VALID_UDID, tempDir.appPath);
    expect(exec).toHaveBeenCalledWith(
      "xcrun",
      expect.arrayContaining(["simctl", "install", VALID_UDID]),
    );
    await tempDir.cleanup();
  });

  it("AC5/T2: throws InstallFailedError for a non-existent path", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, tempDir.baseDir);
    await expect(
      mgr.installApp(VALID_UDID, nodePath.join(tempDir.baseDir, "nonexistent.app")),
    ).rejects.toBeInstanceOf(InstallFailedError);
    await tempDir.cleanup();
  });

  it("T2: throws LifecycleInputError for path not ending with .app", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, tempDir.baseDir);
    await expect(
      mgr.installApp(VALID_UDID, nodePath.join(tempDir.baseDir, "Fixture.ipa")),
    ).rejects.toBeInstanceOf(LifecycleInputError);
    await tempDir.cleanup();
  });

  it("T2: throws LifecycleInputError for empty path", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, tempDir.baseDir);
    await expect(mgr.installApp(VALID_UDID, "")).rejects.toBeInstanceOf(LifecycleInputError);
    await tempDir.cleanup();
  });

  it("T2: throws LifecycleInputError for path outside the allowlisted base dir", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, tempDir.baseDir);
    // Create a .app dir OUTSIDE the base dir (confinement check, path traversal defence).
    const outsideBase = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "outside-"));
    const outsideApp = nodePath.join(outsideBase, "Evil.app");
    await fsPromises.mkdir(outsideApp, { recursive: true });
    await expect(mgr.installApp(VALID_UDID, outsideApp)).rejects.toBeInstanceOf(
      LifecycleInputError,
    );
    await fsPromises.rm(outsideBase, { recursive: true, force: true });
    await tempDir.cleanup();
  });

  it("T1: throws LifecycleInputError for invalid UDID (validated before path check)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, tempDir.baseDir);
    await expect(mgr.installApp("; rm -rf ~", tempDir.appPath)).rejects.toBeInstanceOf(
      LifecycleInputError,
    );
    await tempDir.cleanup();
  });

  it("T2: does NOT call exec when path validation fails (argv never built)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, tempDir.baseDir);
    await expect(mgr.installApp(VALID_UDID, "")).rejects.toBeInstanceOf(LifecycleInputError);
    expect(exec).not.toHaveBeenCalled();
    await tempDir.cleanup();
  });

  it("AC6: throws DeviceNotFoundError for unknown UDID (simctl error)", async () => {
    const exec = makeSimctlExec({ unknownUdids: [UNKNOWN_UDID] });
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, tempDir.baseDir);
    await expect(mgr.installApp(UNKNOWN_UDID, tempDir.appPath)).rejects.toBeInstanceOf(
      DeviceNotFoundError,
    );
    await tempDir.cleanup();
  });

  it("throws InstallFailedError when simctl install fails (distinct from LaunchFailedError)", async () => {
    const exec = makeSimctlExec({ installFails: true });
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, tempDir.baseDir);
    const err = await mgr.installApp(VALID_UDID, tempDir.appPath).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallFailedError);
    expect(err).not.toBeInstanceOf(LaunchFailedError);
    await tempDir.cleanup();
  });
});

// ---------------------------------------------------------------------------
// §4 — launchApp (AC4, AC6, T1)
// ---------------------------------------------------------------------------

describe("SimulatorLifecycleManager — launchApp (AC4/AC6/T1)", () => {
  it("AC4: resolves for valid UDID and bundleId", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.launchApp(VALID_UDID, VALID_BUNDLE_ID)).resolves.toBeUndefined();
  });

  it("calls xcrun simctl launch <udid> <bundleId> (T1 — argv, no shell)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await mgr.launchApp(VALID_UDID, VALID_BUNDLE_ID);
    expect(exec).toHaveBeenCalledWith("xcrun", ["simctl", "launch", VALID_UDID, VALID_BUNDLE_ID]);
  });

  it("AC6: throws DeviceNotFoundError for unknown UDID", async () => {
    const exec = makeSimctlExec({ unknownUdids: [UNKNOWN_UDID] });
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.launchApp(UNKNOWN_UDID, VALID_BUNDLE_ID)).rejects.toBeInstanceOf(
      DeviceNotFoundError,
    );
  });

  it("AC4: throws LaunchFailedError (distinct from InstallFailedError) on simctl failure", async () => {
    const exec = makeSimctlExec({ launchFails: true });
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    const err = await mgr.launchApp(VALID_UDID, VALID_BUNDLE_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchFailedError);
    expect(err).not.toBeInstanceOf(InstallFailedError);
  });

  it("T1: throws LifecycleInputError for injection-shaped bundleId (all vectors)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    const injections = [
      "; rm -rf ~",
      "bundle$(injection)",
      "--leading-dash",
      "",
      "a".repeat(512),
      "bundle\x00id",
    ];
    for (const bad of injections) {
      await expect(mgr.launchApp(VALID_UDID, bad)).rejects.toBeInstanceOf(LifecycleInputError);
    }
  });

  it("T1: does NOT call exec when bundleId is invalid (validation before argv)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.launchApp(VALID_UDID, "; rm -rf ~")).rejects.toBeInstanceOf(
      LifecycleInputError,
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it("T1: throws LifecycleInputError for injection-shaped UDID", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.launchApp("$(evil)", VALID_BUNDLE_ID)).rejects.toBeInstanceOf(
      LifecycleInputError,
    );
  });
});

// ---------------------------------------------------------------------------
// §5 — shutdownSimulator (AC7, AC6, T1, T8)
// ---------------------------------------------------------------------------

describe("SimulatorLifecycleManager — shutdownSimulator (AC7/AC6/T1/T8)", () => {
  it("AC7: resolves for a valid UDID", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.shutdownSimulator(VALID_UDID)).resolves.toBeUndefined();
  });

  it("calls xcrun simctl shutdown <udid> (T1 — argv, no shell)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await mgr.shutdownSimulator(VALID_UDID);
    expect(exec).toHaveBeenCalledWith("xcrun", ["simctl", "shutdown", VALID_UDID]);
  });

  it("AC6: throws DeviceNotFoundError for unknown UDID", async () => {
    const exec = makeSimctlExec({ unknownUdids: [UNKNOWN_UDID] });
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.shutdownSimulator(UNKNOWN_UDID)).rejects.toBeInstanceOf(DeviceNotFoundError);
  });

  it("AC7/T8: 'already shutdown / invalid state' -> success (idempotent, no orphan)", async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(new Error("Invalid state: The simulator is already in shutdown state"));
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.shutdownSimulator(VALID_UDID)).resolves.toBeUndefined();
  });

  it("AC7/T8: 'not booted' -> success (T8 no-orphan: sim is already not running)", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("Simulator is not booted"));
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.shutdownSimulator(VALID_UDID)).resolves.toBeUndefined();
  });

  it("T1: throws LifecycleInputError for injection-shaped UDID (all vectors)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    const injections = ["$(evil)", "-leading-dash", "", "; rm -rf ~", "a".repeat(512)];
    for (const bad of injections) {
      await expect(mgr.shutdownSimulator(bad)).rejects.toBeInstanceOf(LifecycleInputError);
    }
  });

  it("T1: does NOT call exec when UDID is invalid (validation first)", async () => {
    const exec = makeSimctlExec();
    const mgr = new SimulatorLifecycleManager(STUB_CONNECTION, TEST_CONFIG, exec, os.tmpdir());
    await expect(mgr.shutdownSimulator("")).rejects.toBeInstanceOf(LifecycleInputError);
    expect(exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §6 — Error type taxonomy (distinct typed errors per AC4)
// ---------------------------------------------------------------------------

describe("SimulatorLifecycleManager — error type taxonomy", () => {
  it("LifecycleInputError is distinct from InstallFailedError", () => {
    expect(new LifecycleInputError("f", "r")).not.toBeInstanceOf(InstallFailedError);
    expect(new InstallFailedError("r")).not.toBeInstanceOf(LifecycleInputError);
  });

  it("LaunchFailedError is distinct from InstallFailedError (AC4 requirement)", () => {
    expect(new LaunchFailedError("f")).not.toBeInstanceOf(InstallFailedError);
    expect(new InstallFailedError("r")).not.toBeInstanceOf(LaunchFailedError);
  });

  it("DeviceNotFoundError is distinct from LifecycleInputError", () => {
    expect(new DeviceNotFoundError("u")).not.toBeInstanceOf(LifecycleInputError);
    expect(new LifecycleInputError("f", "r")).not.toBeInstanceOf(DeviceNotFoundError);
  });

  it("LifecycleInputError message includes field name but NOT the raw value (T5 no-echo)", () => {
    const err = new LifecycleInputError("bundleId", "must match pattern");
    expect(err.message).toMatch(/bundleId/);
    expect(err.message).toMatch(/must match pattern/);
  });

  it("InstallFailedError message mentions 'installation' (informative)", () => {
    expect(new InstallFailedError("simctl error").message).toMatch(/installation/i);
  });

  it("LaunchFailedError message mentions 'launch' (informative)", () => {
    expect(new LaunchFailedError("simctl error").message).toMatch(/launch/i);
  });

  it("all capability-specific errors extend McpAdapterError (base class DRY per ADR-0002 §2.4)", async () => {
    const { McpAdapterError } = await import("../connection/errors.js");
    expect(new LifecycleInputError("f", "r")).toBeInstanceOf(McpAdapterError);
    expect(new InstallFailedError("r")).toBeInstanceOf(McpAdapterError);
    expect(new LaunchFailedError("r")).toBeInstanceOf(McpAdapterError);
    expect(new DeviceNotFoundError("u")).toBeInstanceOf(McpAdapterError);
  });
});
