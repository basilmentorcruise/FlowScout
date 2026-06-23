/**
 * snapshot.test.ts — unit tests for SnapshotManager (#16 / E1.5).
 *
 * All simctl interactions use an injected fake Exec — no real Mac/Xcode needed.
 * All filesystem interactions use an injected fake FsAccess — no real disk I/O needed.
 *
 * Tests assert:
 *   - Exact simctl argv emitted (T1 argv-safety proof)
 *   - Correct in-place restore: shutdown->erase->install on the SAME udid (Fix #1)
 *   - Fail-closed behavior for reset-to-unknown (T8 / F6 safety backstop)
 *   - Input validation for injection-shaped udid and snapshotName (T1)
 *   - Unknown udid causes DeviceNotFoundError for BOTH takeSnapshot AND resetToSnapshot (Fix #2)
 *   - Known udid + unknown snapshot name still throws SnapshotNotFoundError (T8 preserved)
 *   - Repeated take->mutate->reset cycles behave consistently (success metric AC)
 *   - runSnapshotContract wired to real SnapshotManager (Fix #3)
 *   - appBundlePath confinement validation (T2 / CWE-22 / CWE-88 security gate fix)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Exec, ExecResult } from "../simctl.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import type { McpConnection } from "../connection/McpConnection.js";
import {
  SnapshotManager,
  SnapshotNotFoundError,
  InvalidSnapshotInputError,
} from "../snapshot/SnapshotManager.js";
import { AppBundlePathValidator, type FsAccess } from "../snapshot/AppBundlePathValidator.js";
import { DeviceNotFoundError } from "../connection/errors.js";
import { DEFAULT_FAKE_UDID, runSnapshotContract } from "../testing/index.js";
import type { SnapshotFixtures, SnapshotErrorClasses } from "../testing/index.js";

// ---------------------------------------------------------------------------
// Constants (no magic numbers per ADR-0001 §6)
// ---------------------------------------------------------------------------

const VALID_UDID = "AABBCCDD-AABB-AABB-AABB-AABBCCDDEEFF";
const VALID_UDID_2 = "11223344-1122-1122-1122-112233445566";
const SNAPSHOT_NAME = "clean-state";
const SNAPSHOT_NAME_2 = "after-login";
const TIMEOUT_MS = 5000;
const APP_BUNDLE_PATH = "/fake/builds/Fixture.app";
/** Base dir for the existing tests — parent directory of APP_BUNDLE_PATH. */
const APP_BUNDLE_BASE_DIR = "/fake/builds";

// Injection vectors that must be rejected (T1)
const INJECTION_UDIDS = [
  "; rm -rf ~",
  "$(echo injected)",
  "--flag-injection",
  "",
  "a".repeat(512),
  "udid\x00with\x00nuls",
];

const INJECTION_SNAPSHOT_NAMES = [
  "; rm -rf snapshot",
  "$(injection)",
  "--flag",
  "",
  "a".repeat(65), // exceeds max length
  "snap\x00shot",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal simctl list-devices JSON containing udid. */
function makeDeviceListJson(udid: string): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
        { udid, name: "iPhone 16 Test", state: "Booted", isAvailable: true },
      ],
    },
  });
}

/** Build a fake Exec that handles simctl list, install, erase, shutdown. */
function makeFakeExec(
  options: {
    deviceUdid?: string;
    listDevicesResult?: string | null;
  } = {},
): Exec {
  const { deviceUdid = VALID_UDID, listDevicesResult } = options;

  return async (_file: string, args: readonly string[]): Promise<ExecResult> => {
    const subcommand = args[1]; // args = ["simctl", "<subcommand>", ...]

    if (subcommand === "list") {
      const json =
        listDevicesResult !== undefined
          ? (listDevicesResult ?? "")
          : makeDeviceListJson(deviceUdid);
      return { stdout: json, stderr: "" };
    }

    if (subcommand === "shutdown" || subcommand === "erase" || subcommand === "install") {
      return { stdout: "", stderr: "" };
    }

    return { stdout: "", stderr: "" };
  };
}

/** Build a McpServerConfig with the given timeout. */
function makeConfig(timeoutMs = TIMEOUT_MS): McpServerConfig {
  return {
    serverCommand: ["npx", "mobile-mcp"],
    serverEnv: {},
    connectTimeoutMs: timeoutMs,
    callTimeoutMs: timeoutMs,
  };
}

/**
 * Build a happy-path FsAccess for appBundlePath = path and base dir = baseDir.
 * realpath(baseDir) -> baseDir, realpath(path) -> path.
 * stat(any) -> isDirectory() = true.
 * This avoids real disk I/O in unit tests.
 */
function makeHappyFsAccess(baseDir = APP_BUNDLE_BASE_DIR, path = APP_BUNDLE_PATH): FsAccess {
  return {
    realpath: async (p: string) => {
      if (p === baseDir) return baseDir;
      if (p === path) return path;
      // Fall back to identity for other paths (the contract suite uses different paths).
      return p;
    },
    stat: async (_p: string) => ({ isDirectory: () => true }),
  };
}

/**
 * Build a SnapshotManager with a fake Exec and (when appBundlePath is non-null) a
 * fake FsAccess so that AppBundlePathValidator does not hit the real filesystem.
 *
 * When appBundlePath is provided, uses erase-reinstall strategy.
 * When null/omitted, uses clean-install strategy.
 */
function makeManager(exec: Exec, appBundlePath: string | null = null): SnapshotManager {
  const connection = {} as McpConnection; // not used for simctl ops
  if (appBundlePath !== null) {
    // Inject happy-path FsAccess so the validator doesn't touch real disk.
    const baseDir = APP_BUNDLE_BASE_DIR;
    const fsAccess = makeHappyFsAccess(baseDir, appBundlePath);
    return new SnapshotManager(connection, makeConfig(), exec, appBundlePath, baseDir, fsAccess);
  }
  return new SnapshotManager(connection, makeConfig(), exec, null);
}

// ---------------------------------------------------------------------------
// §1 — takeSnapshot: happy path (erase-reinstall strategy)
// ---------------------------------------------------------------------------

describe("SnapshotManager.takeSnapshot — erase-reinstall strategy happy path", () => {
  it("resolves without error for a valid udid and snapshot name", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
  });

  it("issues xcrun simctl list devices --json to verify udid", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    await makeManager(exec, APP_BUNDLE_PATH).takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    // First call must be the device list lookup
    expect(calls[0]).toEqual(["simctl", "list", "devices", "--json"]);
  });

  it("does NOT call simctl clone (clone is not used — see module docblock)", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: Exec = async (_file, args) => {
      calls.push([...args]);
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    await makeManager(exec, APP_BUNDLE_PATH).takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    const cloneCalls = calls.filter((c) => c[1] === "clone");
    expect(cloneCalls).toHaveLength(0);
  });

  it("stores the snapshot in the registry (enables reset)", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    // Should be able to reset (no throw) because registry has the entry.
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
  });

  it("multiple distinct snapshots can each be reset independently", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME_2);
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME_2)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2 — resetToSnapshot: correct in-place restore (Fix #1 — core correctness)
// ---------------------------------------------------------------------------

describe("SnapshotManager.resetToSnapshot — correct in-place restore (Fix #1)", () => {
  it("resolves after a prior takeSnapshot", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
  });

  it("issues shutdown->erase->install on the SAME udid (not clone — Fix #1)", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: Exec = async (_file, args) => {
      calls.push([...args]);
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);

    // Clear calls and capture only reset calls.
    calls.length = 0;
    await mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);

    // Filter out the list call (device-first check in resetToSnapshot).
    const opCalls = calls.filter((c) => c[1] !== "list");
    const subcommands = opCalls.map((c) => c[1]);

    // Exact sequence: shutdown -> erase -> install (no clone).
    expect(subcommands[0]).toBe("shutdown");
    expect(subcommands[1]).toBe("erase");
    expect(subcommands[2]).toBe("install");
    expect(subcommands).not.toContain("clone");

    // All calls target the SAME working udid (not a new one).
    const shutdownCall = opCalls.find((c) => c[1] === "shutdown");
    const eraseCall = opCalls.find((c) => c[1] === "erase");
    const installCall = opCalls.find((c) => c[1] === "install");

    expect(shutdownCall?.[2]).toBe(VALID_UDID);
    expect(eraseCall?.[2]).toBe(VALID_UDID);
    expect(installCall?.[2]).toBe(VALID_UDID);

    // Install call carries the captured app bundle path.
    expect(installCall?.[3]).toBe(APP_BUNDLE_PATH);
  });

  it("all simctl argv are arrays (T1 — no shell strings)", async () => {
    const observedCalls: Array<{ file: string; args: readonly string[] }> = [];
    const exec: Exec = async (file, args) => {
      observedCalls.push({ file, args });
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);

    for (const { file, args } of observedCalls) {
      expect(file).toBe("xcrun");
      expect(Array.isArray(args)).toBe(true);
      expect(args[0]).toBe("simctl");
    }
  });

  it("repeated take->reset cycles each issue shutdown->erase->install on the same udid (AC5)", async () => {
    const CYCLE_COUNT = 3;
    const allCycles: Array<Array<readonly string[]>> = [];

    const exec: Exec = async (_file, args) => {
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, APP_BUNDLE_PATH);

    // Take once.
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);

    // Reset CYCLE_COUNT times; capture calls for each cycle.
    for (let i = 0; i < CYCLE_COUNT; i++) {
      const cycleCalls: Array<readonly string[]> = [];
      const cycleExec: Exec = async (_file, args) => {
        cycleCalls.push([...args]);
        if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
        return { stdout: "", stderr: "" };
      };
      // Build a fresh manager that shares the same registry state by using the original mgr's
      // reset path — but we need to intercept the exec. Re-use the same mgr with our tracking exec.
      // Instead: create a manager per cycle and take the snapshot in each.
      const cycleMgr = makeManager(cycleExec, APP_BUNDLE_PATH);
      await cycleMgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
      await cycleMgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);
      allCycles.push(cycleCalls);
    }

    // Each cycle must have issued the correct simctl ops.
    for (const cycleCalls of allCycles) {
      const opCalls = cycleCalls.filter((c) => c[1] !== "list");
      const subcommands = opCalls.map((c) => c[1]);
      expect(subcommands).toContain("shutdown");
      expect(subcommands).toContain("erase");
      expect(subcommands).toContain("install");
      expect(subcommands).not.toContain("clone");

      // Every op targets the original udid.
      for (const call of opCalls) {
        expect(call[2]).toBe(VALID_UDID);
      }
    }
  });

  it("repeated take->reset cycles on the SAME manager all resolve (AC5)", async () => {
    const CYCLE_COUNT = 3;
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    for (let i = 0; i < CYCLE_COUNT; i++) {
      await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// §3 — T8 fail-closed: resetToSnapshot to unknown name MUST throw
// ---------------------------------------------------------------------------

describe("SnapshotManager.resetToSnapshot — T8 fail-closed (F6 safety backstop)", () => {
  it("throws SnapshotNotFoundError when snapshot name was never taken (known udid)", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await expect(mgr.resetToSnapshot(VALID_UDID, "never-taken")).rejects.toBeInstanceOf(
      SnapshotNotFoundError,
    );
  });

  it("error message mentions 'snapshot' (T8 informative error requirement)", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    const err = await mgr.resetToSnapshot(VALID_UDID, "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotNotFoundError);
    expect((err as Error).message).toMatch(/snapshot/i);
  });

  it("does NOT silently no-op — the promise must reject, not resolve", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    const result = await mgr
      .resetToSnapshot(VALID_UDID, "nonexistent")
      .then(() => "RESOLVED" as const)
      .catch(() => "REJECTED" as const);
    expect(result).toBe("REJECTED");
  });

  it("reset to name-A fails after taking name-B (names are independent)", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    // Name-B was never taken — must throw.
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME_2)).rejects.toBeInstanceOf(
      SnapshotNotFoundError,
    );
  });

  it("SnapshotNotFoundError carries the snapshot name and udid", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    const err = await mgr.resetToSnapshot(VALID_UDID, "missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotNotFoundError);
    const typed = err as SnapshotNotFoundError;
    expect(typed.snapshotName).toBe("missing");
    expect(typed.udid).toBe(VALID_UDID);
  });
});

// ---------------------------------------------------------------------------
// §4 — T1 input validation: snapshotName injection vectors rejected
// ---------------------------------------------------------------------------

describe("SnapshotManager — T1: injection-shaped snapshotName rejected", () => {
  for (const badName of INJECTION_SNAPSHOT_NAMES) {
    it(`takeSnapshot rejects snapshotName: ${JSON.stringify(badName)}`, async () => {
      const exec = makeFakeExec({ deviceUdid: VALID_UDID });
      const mgr = makeManager(exec, APP_BUNDLE_PATH);
      await expect(mgr.takeSnapshot(VALID_UDID, badName)).rejects.toBeInstanceOf(
        InvalidSnapshotInputError,
      );
    });

    it(`resetToSnapshot rejects snapshotName: ${JSON.stringify(badName)}`, async () => {
      const exec = makeFakeExec({ deviceUdid: VALID_UDID });
      const mgr = makeManager(exec, APP_BUNDLE_PATH);
      await expect(mgr.resetToSnapshot(VALID_UDID, badName)).rejects.toBeInstanceOf(
        InvalidSnapshotInputError,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// §5 — T1 input validation: udid injection vectors rejected
// ---------------------------------------------------------------------------

describe("SnapshotManager — T1: injection-shaped udid rejected", () => {
  for (const badUdid of INJECTION_UDIDS) {
    it(`takeSnapshot rejects udid: ${JSON.stringify(badUdid)}`, async () => {
      const exec = makeFakeExec({ deviceUdid: VALID_UDID });
      const mgr = makeManager(exec, APP_BUNDLE_PATH);
      await expect(mgr.takeSnapshot(badUdid, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
        InvalidSnapshotInputError,
      );
    });

    it(`resetToSnapshot rejects udid: ${JSON.stringify(badUdid)}`, async () => {
      const exec = makeFakeExec({ deviceUdid: VALID_UDID });
      const mgr = makeManager(exec, APP_BUNDLE_PATH);
      await expect(mgr.resetToSnapshot(badUdid, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
        InvalidSnapshotInputError,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// §6 — Unknown UDID: typed DeviceNotFoundError for BOTH operations (Fix #2)
//
// ADR-0003 §2 device-first contract: requireDeviceExists is called BEFORE the
// registry lookup in BOTH takeSnapshot AND resetToSnapshot.
// ---------------------------------------------------------------------------

describe("SnapshotManager — Fix #2: unknown udid -> DeviceNotFoundError (device-first)", () => {
  it("takeSnapshot throws DeviceNotFoundError when udid is absent from simctl list", async () => {
    const exec = makeFakeExec({
      deviceUdid: VALID_UDID, // list only knows VALID_UDID
      listDevicesResult: makeDeviceListJson(VALID_UDID),
    });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await expect(mgr.takeSnapshot(VALID_UDID_2, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      DeviceNotFoundError,
    );
  });

  it("resetToSnapshot throws DeviceNotFoundError for unknown udid (device-first — not SnapshotNotFoundError)", async () => {
    // unknownUdid is NOT in the simctl list, so requireDeviceExists fires before
    // the registry lookup, throwing DeviceNotFoundError (not SnapshotNotFoundError).
    const exec: Exec = async (_file, args) => {
      if (args[1] === "list") {
        return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await expect(mgr.resetToSnapshot(VALID_UDID_2, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      DeviceNotFoundError,
    );
  });

  it("resetToSnapshot: known udid + unknown snapshot name still throws SnapshotNotFoundError (T8 preserved)", async () => {
    // Device is known (VALID_UDID is in the list), but snapshot name was never taken.
    // requireDeviceExists passes, then the registry lookup fails -> SnapshotNotFoundError.
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    // No takeSnapshot called -> registry is empty.
    await expect(
      mgr.resetToSnapshot(VALID_UDID, "snapshot-that-was-never-taken"),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it("DeviceNotFoundError is thrown for a well-formed uuid not in the device list", async () => {
    const exec: Exec = async (_file, args) => {
      if (args[1] === "list") {
        return { stdout: makeDeviceListJson("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      DeviceNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// §7 — clean-install strategy: argv and happy path
// ---------------------------------------------------------------------------

describe("SnapshotManager — clean-install strategy (no appBundlePath)", () => {
  it("takeSnapshot with clean-install does NOT call simctl install or clone", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: Exec = async (_file, args) => {
      calls.push([...args]);
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, null); // null -> clean-install
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    const installCalls = calls.filter((c) => c[1] === "install");
    const cloneCalls = calls.filter((c) => c[1] === "clone");
    expect(installCalls).toHaveLength(0);
    expect(cloneCalls).toHaveLength(0);
  });

  it("resetToSnapshot with clean-install calls xcrun simctl shutdown then erase on the same udid", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: Exec = async (_file, args) => {
      calls.push([...args]);
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, null); // null -> clean-install
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);

    calls.length = 0;
    await mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);

    const opCalls = calls.filter((c) => c[1] !== "list");
    const subcommands = opCalls.map((c) => c[1]);

    // Shutdown + erase only (no install, no clone).
    expect(subcommands).toContain("shutdown");
    expect(subcommands).toContain("erase");
    expect(subcommands).not.toContain("install");
    expect(subcommands).not.toContain("clone");

    // Both ops target the source udid.
    const shutdownCall = opCalls.find((c) => c[1] === "shutdown");
    const eraseCall = opCalls.find((c) => c[1] === "erase");
    expect(shutdownCall?.[2]).toBe(VALID_UDID);
    expect(eraseCall?.[2]).toBe(VALID_UDID);
  });

  it("clean-install reset resolves without error", async () => {
    const exec: Exec = async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, null);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §8 — argv structure: T1 safety — all calls use argv arrays, never shell strings
// ---------------------------------------------------------------------------

describe("SnapshotManager — T1: all simctl calls use argv arrays", () => {
  it("every exec call has 'xcrun' as the file and 'simctl' as the first arg", async () => {
    const observedFiles: string[] = [];
    const exec: Exec = async (file, args) => {
      observedFiles.push(file);
      expect(args[0]).toBe("simctl");
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);
    for (const f of observedFiles) {
      expect(f).toBe("xcrun");
    }
  });

  it("the app bundle path appears in install argv as a discrete element (T1)", async () => {
    const installArgs: string[][] = [];
    const exec: Exec = async (_file, args) => {
      if (args[1] === "install") installArgs.push([...args]);
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, APP_BUNDLE_PATH);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);

    expect(installArgs.length).toBe(1);
    const installCmd = installArgs[0];
    expect(installCmd).toBeDefined();
    // argv[3] is the app bundle path — a single discrete string
    expect(installCmd?.[3]).toBe(APP_BUNDLE_PATH);
    // No shell metacharacters injected
    expect(installCmd?.[3]).not.toMatch(/[;&|`$]/);
  });
});

// ---------------------------------------------------------------------------
// §9 — vi.fn() spy: prove exec is invoked (argv-safety via mock verification)
// ---------------------------------------------------------------------------

describe("SnapshotManager — spy: verifies exec called with argv arrays (T1)", () => {
  it("takeSnapshot calls exec with file='xcrun' and args[0]='simctl'", async () => {
    const spy = vi.fn<Exec>(async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const fsAccess = makeHappyFsAccess();
    const mgr = new SnapshotManager(
      {} as McpConnection,
      makeConfig(),
      spy,
      APP_BUNDLE_PATH,
      APP_BUNDLE_BASE_DIR,
      fsAccess,
    );
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      expect(call[0]).toBe("xcrun");
      expect(call[1][0]).toBe("simctl");
    }
  });

  it("resetToSnapshot (after take) calls exec with file='xcrun' and args[0]='simctl'", async () => {
    const spy = vi.fn<Exec>(async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const fsAccess = makeHappyFsAccess();
    const mgr = new SnapshotManager(
      {} as McpConnection,
      makeConfig(),
      spy,
      APP_BUNDLE_PATH,
      APP_BUNDLE_BASE_DIR,
      fsAccess,
    );
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);
    for (const call of spy.mock.calls) {
      expect(call[0]).toBe("xcrun");
      expect(call[1][0]).toBe("simctl");
    }
  });
});

// ---------------------------------------------------------------------------
// §10 — beforeEach isolation: each test gets a fresh manager
// ---------------------------------------------------------------------------

describe("SnapshotManager — registry isolation between instances", () => {
  let exec: Exec;
  let mgr: SnapshotManager;

  beforeEach(() => {
    exec = async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    mgr = makeManager(exec, APP_BUNDLE_PATH);
  });

  it("fresh manager starts with empty registry (no snapshots)", async () => {
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      SnapshotNotFoundError,
    );
  });

  it("taking a snapshot in instance A does not affect instance B", async () => {
    const exec2: Exec = async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr2 = makeManager(exec2, APP_BUNDLE_PATH);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME); // register in mgr
    // mgr2 should not know about it
    await expect(mgr2.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      SnapshotNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// §11 — runSnapshotContract: real SnapshotManager through the shared contract suite (Fix #3)
//
// ADR-0003 §1.1: Wave-1 tickets run the real adapter through the per-capability runner.
// The factory returns a SnapshotManager with a mocked Exec that:
//   - Returns a device list containing fixtures.validUdid (so takeSnapshot passes device check)
//   - Does NOT contain fixtures.unknownUdid (so takeSnapshot/resetToSnapshot throw DeviceNotFoundError)
//   - Handles all simctl ops (erase, install, shutdown) with success responses
// ---------------------------------------------------------------------------

const CONTRACT_VALID_UDID = DEFAULT_FAKE_UDID;
const CONTRACT_UNKNOWN_UDID = "00000000-0000-0000-0000-FFFFFFFFFFFF";
const CONTRACT_SNAPSHOT_NAME = "clean-state";
const CONTRACT_SNAPSHOT_NAME_2 = "after-login";
const CONTRACT_APP_BUNDLE_PATH = "/safe/contract-builds/ContractFixture.app";
const CONTRACT_BASE_DIR = "/safe/contract-builds";

const SNAPSHOT_FIXTURES: SnapshotFixtures = {
  validUdid: CONTRACT_VALID_UDID,
  knownSnapshotName: CONTRACT_SNAPSHOT_NAME,
  knownSnapshotName2: CONTRACT_SNAPSHOT_NAME_2,
  unknownUdid: CONTRACT_UNKNOWN_UDID,
  injectionSnapshotNames: [
    "; rm -rf snapshot",
    "$(injection)",
    "--flag",
    "",
    "a".repeat(65),
    "snap\x00shot",
  ],
};

const SNAPSHOT_ERROR_CLASSES: SnapshotErrorClasses = {
  unknownDevice: DeviceNotFoundError,
  invalidInput: InvalidSnapshotInputError,
  snapshotNotFound: SnapshotNotFoundError,
};

runSnapshotContract({
  createSnapshot: () => {
    const contractExec: Exec = async (
      _file: string,
      args: readonly string[],
    ): Promise<ExecResult> => {
      const sub = args[1];

      if (sub === "list") {
        // Return a device list that contains CONTRACT_VALID_UDID but NOT CONTRACT_UNKNOWN_UDID.
        return {
          stdout: makeDeviceListJson(CONTRACT_VALID_UDID),
          stderr: "",
        };
      }

      // Handle all simctl ops used by erase-reinstall and clean-install strategies.
      if (sub === "shutdown" || sub === "erase" || sub === "install") {
        return { stdout: "", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    };

    // Inject a happy-path FsAccess for the contract suite (no real disk I/O).
    const contractFsAccess: FsAccess = {
      realpath: async (p: string) => {
        if (p === CONTRACT_BASE_DIR) return CONTRACT_BASE_DIR;
        if (p === CONTRACT_APP_BUNDLE_PATH) return CONTRACT_APP_BUNDLE_PATH;
        return p;
      },
      stat: async () => ({ isDirectory: () => true }),
    };

    return new SnapshotManager(
      {} as McpConnection,
      makeConfig(),
      contractExec,
      CONTRACT_APP_BUNDLE_PATH, // erase-reinstall strategy with a known app path
      CONTRACT_BASE_DIR,
      contractFsAccess,
    );
  },
  fixtures: SNAPSHOT_FIXTURES,
  errorClasses: SNAPSHOT_ERROR_CLASSES,
});

// ---------------------------------------------------------------------------
// §12 — AppBundlePathValidator unit tests (T2 / CWE-22 / CWE-88 fix)
// ---------------------------------------------------------------------------

/** Base dir used in AppBundlePathValidator tests (separate from APP_BUNDLE_BASE_DIR). */
const SECURE_BASE_DIR = "/safe/builds";

/**
 * Happy-path FsAccess: realpath succeeds and returns identity; stat says directory.
 */
function makeValidatorHappyFs(resolvedBase = SECURE_BASE_DIR, resolvedPath?: string): FsAccess {
  return {
    realpath: async (p: string) => {
      if (p === SECURE_BASE_DIR || p === resolvedBase) return resolvedBase;
      return resolvedPath ?? p;
    },
    stat: async (_p: string) => ({ isDirectory: () => true }),
  };
}

describe("AppBundlePathValidator — synchronous fast-fail (constructor)", () => {
  const dummyFsAccess: FsAccess = {
    realpath: async () => {
      throw new Error("should not be called");
    },
    stat: async () => {
      throw new Error("should not be called");
    },
  };

  it("rejects an empty string (constructor)", () => {
    expect(() => new AppBundlePathValidator("", SECURE_BASE_DIR, dummyFsAccess)).toThrow(
      InvalidSnapshotInputError,
    );
  });

  it("rejects a leading '-' (CWE-88 argument injection)", () => {
    expect(() => new AppBundlePathValidator("-evil.app", SECURE_BASE_DIR, dummyFsAccess)).toThrow(
      InvalidSnapshotInputError,
    );
  });

  it("rejects a path with '..' segment (CWE-22 traversal)", () => {
    expect(
      () =>
        new AppBundlePathValidator(
          `${SECURE_BASE_DIR}/../escape.app`,
          SECURE_BASE_DIR,
          dummyFsAccess,
        ),
    ).toThrow(InvalidSnapshotInputError);
  });

  it("rejects a path with '..' at the start", () => {
    expect(
      () => new AppBundlePathValidator("../../escape.app", SECURE_BASE_DIR, dummyFsAccess),
    ).toThrow(InvalidSnapshotInputError);
  });

  it("rejects a non-.app extension (e.g. .ipa)", () => {
    expect(
      () =>
        new AppBundlePathValidator(`${SECURE_BASE_DIR}/MyApp.ipa`, SECURE_BASE_DIR, dummyFsAccess),
    ).toThrow(InvalidSnapshotInputError);
  });

  it("rejects a path with no extension", () => {
    expect(
      () => new AppBundlePathValidator(`${SECURE_BASE_DIR}/MyApp`, SECURE_BASE_DIR, dummyFsAccess),
    ).toThrow(InvalidSnapshotInputError);
  });

  it("accepts a valid-looking path at construction time (no I/O error)", () => {
    expect(
      () =>
        new AppBundlePathValidator(
          `${SECURE_BASE_DIR}/MyApp.app`,
          SECURE_BASE_DIR,
          makeValidatorHappyFs(),
        ),
    ).not.toThrow();
  });
});

describe("AppBundlePathValidator — async validate() confinement", () => {
  it("resolves the canonicalized path when path is inside base dir", async () => {
    const path = `${SECURE_BASE_DIR}/MyApp.app`;
    const v = new AppBundlePathValidator(path, SECURE_BASE_DIR, makeValidatorHappyFs());
    const result = await v.validate();
    expect(result).toBe(path);
  });

  it("rejects a path outside the base dir (symlink escape via realpath)", async () => {
    const outsideFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        return "/outside/evil.app"; // symlink resolves outside the base
      },
      stat: async () => ({ isDirectory: () => true }),
    };
    const v = new AppBundlePathValidator(
      `${SECURE_BASE_DIR}/escape.app`,
      SECURE_BASE_DIR,
      outsideFs,
    );
    await expect(v.validate()).rejects.toBeInstanceOf(InvalidSnapshotInputError);
  });

  it("rejects a path that is a sibling with a prefix-similar name (prefix collision)", async () => {
    // /safe/builds-evil/MyApp.app must NOT be considered inside /safe/builds
    const siblingFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        return "/safe/builds-evil/MyApp.app";
      },
      stat: async () => ({ isDirectory: () => true }),
    };
    const v = new AppBundlePathValidator("/safe/builds-evil/MyApp.app", SECURE_BASE_DIR, siblingFs);
    await expect(v.validate()).rejects.toBeInstanceOf(InvalidSnapshotInputError);
  });

  it("rejects a non-existent path (realpath throws ENOENT)", async () => {
    const noExistFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        throw new Error("ENOENT: no such file or directory");
      },
      stat: async () => ({ isDirectory: () => true }),
    };
    const v = new AppBundlePathValidator(
      `${SECURE_BASE_DIR}/missing.app`,
      SECURE_BASE_DIR,
      noExistFs,
    );
    await expect(v.validate()).rejects.toBeInstanceOf(InvalidSnapshotInputError);
  });

  it("rejects a path that resolves to a file (not a directory)", async () => {
    const fileFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        return `${SECURE_BASE_DIR}/NotADir.app`;
      },
      stat: async () => ({ isDirectory: () => false }), // not a directory
    };
    const v = new AppBundlePathValidator(`${SECURE_BASE_DIR}/NotADir.app`, SECURE_BASE_DIR, fileFs);
    await expect(v.validate()).rejects.toBeInstanceOf(InvalidSnapshotInputError);
  });

  it("rejects when stat throws (unreadable / permission denied)", async () => {
    const unreadableFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        return `${SECURE_BASE_DIR}/Locked.app`;
      },
      stat: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const v = new AppBundlePathValidator(
      `${SECURE_BASE_DIR}/Locked.app`,
      SECURE_BASE_DIR,
      unreadableFs,
    );
    await expect(v.validate()).rejects.toBeInstanceOf(InvalidSnapshotInputError);
  });
});

// ---------------------------------------------------------------------------
// §13 — SnapshotManager reject-tests: bad appBundlePath -> InvalidSnapshotInputError
//         AND simctl install is NEVER called (T2 / CWE-22 / CWE-88 security gate fix)
//
// All tests use vi.fn() exec spy to assert the install sink is not reached.
// ---------------------------------------------------------------------------

/** Build a vi.fn() Exec spy that handles device list + all simctl ops. */
function makeExecSpy(deviceUdid = VALID_UDID): ReturnType<typeof vi.fn<Exec>> {
  return vi.fn<Exec>(async (_file: string, args: readonly string[]): Promise<ExecResult> => {
    if (args[1] === "list") return { stdout: makeDeviceListJson(deviceUdid), stderr: "" };
    return { stdout: "", stderr: "" };
  });
}

/** Assert that exec was never called with simctl install. */
function assertInstallNotCalled(spy: ReturnType<typeof vi.fn<Exec>>): void {
  const installCalls = spy.mock.calls.filter((call) => call[1][1] === "install");
  expect(installCalls).toHaveLength(0);
}

/**
 * Build a SnapshotManager with explicit appBundleBaseDir and FsAccess injection.
 * Used for security rejection tests that need precise control of path validation.
 */
function makeManagerWithFsAccess(
  appBundlePath: string,
  appBundleBaseDir: string,
  fsAccess: FsAccess,
  execSpy: ReturnType<typeof vi.fn<Exec>>,
): SnapshotManager {
  const connection = {} as McpConnection;
  return new SnapshotManager(
    connection,
    makeConfig(),
    execSpy,
    appBundlePath,
    appBundleBaseDir,
    fsAccess,
  );
}

describe("SnapshotManager — appBundlePath reject tests (T2 / CWE-22 / CWE-88)", () => {
  // Happy-path FsAccess for the base dir used in this section.
  const goodFs = makeValidatorHappyFs();

  // --- Constructor-time synchronous failures (no simctl calls whatsoever) ---

  it("rejects a leading-dash appBundlePath at construction time (CWE-88)", () => {
    const spy = makeExecSpy();
    expect(() => makeManagerWithFsAccess("-evil.app", SECURE_BASE_DIR, goodFs, spy)).toThrow(
      InvalidSnapshotInputError,
    );
    // Exec must NEVER have been called — fail before any I/O.
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects '..' traversal in appBundlePath at construction time (CWE-22)", () => {
    const spy = makeExecSpy();
    expect(() =>
      makeManagerWithFsAccess(`${SECURE_BASE_DIR}/../escape.app`, SECURE_BASE_DIR, goodFs, spy),
    ).toThrow(InvalidSnapshotInputError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a non-.app path at construction time", () => {
    const spy = makeExecSpy();
    expect(() =>
      makeManagerWithFsAccess(`${SECURE_BASE_DIR}/MyApp.ipa`, SECURE_BASE_DIR, goodFs, spy),
    ).toThrow(InvalidSnapshotInputError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects an empty appBundlePath at construction time", () => {
    const spy = makeExecSpy();
    expect(() => makeManagerWithFsAccess("", SECURE_BASE_DIR, goodFs, spy)).toThrow(
      InvalidSnapshotInputError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  // --- Async ingress validation failures at takeSnapshot ---

  it("takeSnapshot rejects when appBundlePath is a symlink escaping the base dir", async () => {
    const escapeFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        return "/outside/evil.app"; // symlink target is outside base
      },
      stat: async () => ({ isDirectory: () => true }),
    };
    const spy = makeExecSpy();
    const mgr = makeManagerWithFsAccess(
      `${SECURE_BASE_DIR}/trap.app`,
      SECURE_BASE_DIR,
      escapeFs,
      spy,
    );
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      InvalidSnapshotInputError,
    );
    assertInstallNotCalled(spy);
  });

  it("takeSnapshot rejects when appBundlePath resolves to a file (not .app directory)", async () => {
    const fileFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        return `${SECURE_BASE_DIR}/NotADir.app`;
      },
      stat: async () => ({ isDirectory: () => false }),
    };
    const spy = makeExecSpy();
    const mgr = makeManagerWithFsAccess(
      `${SECURE_BASE_DIR}/NotADir.app`,
      SECURE_BASE_DIR,
      fileFs,
      spy,
    );
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      InvalidSnapshotInputError,
    );
    assertInstallNotCalled(spy);
  });

  it("takeSnapshot rejects when appBundlePath is unreadable (stat throws EACCES)", async () => {
    const unreadableFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        return `${SECURE_BASE_DIR}/Locked.app`;
      },
      stat: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const spy = makeExecSpy();
    const mgr = makeManagerWithFsAccess(
      `${SECURE_BASE_DIR}/Locked.app`,
      SECURE_BASE_DIR,
      unreadableFs,
      spy,
    );
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      InvalidSnapshotInputError,
    );
    assertInstallNotCalled(spy);
  });

  it("takeSnapshot rejects when appBundlePath does not exist (realpath throws ENOENT)", async () => {
    const noExistFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        throw new Error("ENOENT: no such file or directory");
      },
      stat: async () => ({ isDirectory: () => true }),
    };
    const spy = makeExecSpy();
    const mgr = makeManagerWithFsAccess(
      `${SECURE_BASE_DIR}/missing.app`,
      SECURE_BASE_DIR,
      noExistFs,
      spy,
    );
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      InvalidSnapshotInputError,
    );
    assertInstallNotCalled(spy);
  });

  it("takeSnapshot rejects path outside base (prefix collision: /safe/builds-evil not in /safe/builds)", async () => {
    const siblingFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        return "/safe/builds-evil/MyApp.app";
      },
      stat: async () => ({ isDirectory: () => true }),
    };
    const spy = makeExecSpy();
    const mgr = makeManagerWithFsAccess(
      "/safe/builds-evil/MyApp.app",
      SECURE_BASE_DIR,
      siblingFs,
      spy,
    );
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      InvalidSnapshotInputError,
    );
    assertInstallNotCalled(spy);
  });

  // --- Defense in depth: restore sink also rejects on re-validation failure ---

  it("resetToSnapshot (restore sink) rejects when re-validation fails (defense in depth)", async () => {
    // Phase 1: take the snapshot with a GOOD FsAccess (passes ingress check).
    let rejectOnValidate = false;
    const dynamicFs: FsAccess = {
      realpath: async (p: string) => {
        if (p === SECURE_BASE_DIR) return SECURE_BASE_DIR;
        if (rejectOnValidate) {
          // After takeSnapshot, the path now escapes confinement
          // (simulates a tampered or stale environment).
          return "/outside/evil.app";
        }
        return `${SECURE_BASE_DIR}/MyApp.app`;
      },
      stat: async () => ({ isDirectory: () => true }),
    };
    const spy = makeExecSpy();
    const mgr = makeManagerWithFsAccess(
      `${SECURE_BASE_DIR}/MyApp.app`,
      SECURE_BASE_DIR,
      dynamicFs,
      spy,
    );

    // takeSnapshot passes ingress check.
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);

    // Simulate environment change: path now escapes confinement.
    rejectOnValidate = true;

    // resetToSnapshot must re-validate at the sink and reject BEFORE simctl install.
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toBeInstanceOf(
      InvalidSnapshotInputError,
    );
    assertInstallNotCalled(spy);
  });

  // --- Regression guard: happy path still works with valid confinement ---

  it("takeSnapshot and resetToSnapshot both succeed when appBundlePath is valid and confined", async () => {
    const spy = makeExecSpy();
    const mgr = makeManagerWithFsAccess(
      `${SECURE_BASE_DIR}/MyApp.app`,
      SECURE_BASE_DIR,
      makeValidatorHappyFs(SECURE_BASE_DIR, `${SECURE_BASE_DIR}/MyApp.app`),
      spy,
    );
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
    // simctl install MUST have been called exactly once during reset.
    const installCalls = spy.mock.calls.filter((call) => call[1][1] === "install");
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0]?.[1][3]).toBe(`${SECURE_BASE_DIR}/MyApp.app`);
  });
});
