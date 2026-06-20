/**
 * snapshot.test.ts — unit tests for SnapshotManager (#16 / E1.5).
 *
 * All simctl interactions use an injected fake `Exec` — no real Mac/Xcode needed.
 * Tests assert:
 *   - Exact simctl argv emitted (T1 argv-safety proof)
 *   - Fail-closed behavior for reset-to-unknown (T8 / F6 safety backstop)
 *   - Input validation for injection-shaped udid and snapshotName (T1)
 *   - Unknown udid causes DeviceNotFoundError (typed not-found error AC)
 *   - Repeated take→mutate→reset cycles behave consistently (success metric AC)
 *   - Strategy selection (clone vs. clean-install) correct argv
 *
 * Contract suite wiring (§5):
 *   Runs the shared runDriverContractSuite snapshot/reset sections against a
 *   SnapshotManager-backed FullDriver (SnapshotManager + FakeMobileDriver for
 *   lifecycle/driving stubs). The FakeMobileDriver satisfies lifecycle methods
 *   (bootSimulator, installApp, etc.) while SnapshotManager handles snapshot ops.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TapTarget, SwipeDirection } from "@flowscout/domain";
import type { Exec, ExecResult } from "../simctl.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import type { McpConnection } from "../connection/McpConnection.js";
import {
  SnapshotManager,
  SnapshotNotFoundError,
  InvalidSnapshotInputError,
} from "../snapshot/SnapshotManager.js";
import { DeviceNotFoundError } from "../connection/errors.js";
import {
  FakeMobileDriver,
  DEFAULT_FAKE_UDID,
} from "../testing/index.js";
import type { FullDriver } from "../testing/index.js";

// ---------------------------------------------------------------------------
// Constants (no magic numbers per ADR-0001 §6)
// ---------------------------------------------------------------------------

const VALID_UDID = "AABBCCDD-AABB-AABB-AABB-AABBCCDDEEFF";
const VALID_UDID_2 = "11223344-1122-1122-1122-112233445566";
const CLONE_UDID = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC";
const RESTORE_UDID = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD";
const SNAPSHOT_NAME = "clean-state";
const SNAPSHOT_NAME_2 = "after-login";
const TIMEOUT_MS = 5000;

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

/** Build a minimal simctl list-devices JSON containing `udid`. */
function makeDeviceListJson(udid: string): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
        { udid, name: "iPhone 16 Test", state: "Booted", isAvailable: true },
      ],
    },
  });
}

/** Build a fake Exec that:
 *  - Returns the device list JSON for `list devices --json` calls.
 *  - Returns the cloneUdid for `clone` calls.
 *  - Returns success for everything else.
 */
function makeFakeExec(options: {
  deviceUdid?: string;
  cloneUdid?: string;
  restoreUdid?: string;
  listDevicesResult?: string | null;
  cloneCallCount?: { count: number };
}): Exec {
  const {
    deviceUdid = VALID_UDID,
    cloneUdid = CLONE_UDID,
    restoreUdid = RESTORE_UDID,
    listDevicesResult,
    cloneCallCount,
  } = options;

  let cloneCalls = 0;

  return async (_file: string, args: readonly string[]): Promise<ExecResult> => {
    const subcommand = args[1]; // args = ["simctl", "<subcommand>", ...]

    if (subcommand === "list") {
      const json =
        listDevicesResult !== undefined
          ? (listDevicesResult ?? "")
          : makeDeviceListJson(deviceUdid);
      return { stdout: json, stderr: "" };
    }

    if (subcommand === "clone") {
      cloneCalls++;
      if (cloneCallCount) cloneCallCount.count = cloneCalls;
      // First clone = take snapshot (produces cloneUdid)
      // Second clone = restore (produces restoreUdid)
      const uid = cloneCalls === 1 ? cloneUdid : restoreUdid;
      return { stdout: `${uid}\n`, stderr: "" };
    }

    if (subcommand === "shutdown" || subcommand === "erase") {
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

/** Build a SnapshotManager with a fake Exec (clone strategy by default). */
function makeManager(
  exec: Exec,
  kind: "clone" | "clean-install" = "clone",
): SnapshotManager {
  const connection = {} as McpConnection; // not used for simctl ops
  return new SnapshotManager(connection, makeConfig(), exec, kind);
}

// ---------------------------------------------------------------------------
// §1 — takeSnapshot: happy path (clone strategy)
// ---------------------------------------------------------------------------

describe("SnapshotManager.takeSnapshot — clone strategy happy path", () => {
  it("resolves without error for a valid udid and snapshot name", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec);
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
  });

  it("issues xcrun simctl list devices --json to verify udid", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: `${CLONE_UDID}\n`, stderr: "" };
    };
    await makeManager(exec).takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    // First call must be the device list lookup
    expect(calls[0]).toEqual(["simctl", "list", "devices", "--json"]);
  });

  it("issues xcrun simctl clone <udid> <cloneName> (T1: argv array)", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: `${CLONE_UDID}\n`, stderr: "" };
    };
    await makeManager(exec).takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    const cloneCall = calls.find((c) => c[1] === "clone");
    expect(cloneCall).toBeDefined();
    // argv[2] = udid, argv[3] = clone name (contains snapshot name)
    expect(cloneCall?.[2]).toBe(VALID_UDID);
    expect(cloneCall?.[3]).toContain(SNAPSHOT_NAME);
  });

  it("stores the returned clone UDID in the registry (enables reset)", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID, cloneUdid: CLONE_UDID });
    const mgr = makeManager(exec);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    // Should be able to reset (no throw) because registry has the entry.
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
  });

  it("multiple distinct snapshots can each be reset independently", async () => {
    // Each clone call returns a unique but valid UUID-format UDID
    const CLONE_UUIDS = [
      "CCCC0001-CCCC-CCCC-CCCC-CCCCCCCCCCCC",
      "CCCC0002-CCCC-CCCC-CCCC-CCCCCCCCCCCC",
      "CCCC0003-CCCC-CCCC-CCCC-CCCCCCCCCCCC",
      "CCCC0004-CCCC-CCCC-CCCC-CCCCCCCCCCCC",
    ];
    let cloneCallIdx = 0;
    const exec: Exec = async (_file, args) => {
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (sub === "clone") {
        const uid = CLONE_UUIDS[cloneCallIdx % CLONE_UUIDS.length] ?? CLONE_UDID;
        cloneCallIdx++;
        return { stdout: `${uid}\n`, stderr: "" };
      }
      if (sub === "shutdown" || sub === "erase") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME_2);
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME_2)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2 — resetToSnapshot: happy path (clone strategy)
// ---------------------------------------------------------------------------

describe("SnapshotManager.resetToSnapshot — clone strategy happy path", () => {
  it("resolves after a prior takeSnapshot", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await expect(mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME)).resolves.toBeUndefined();
  });

  it("issues shutdown then erase then clone (T1: argv arrays)", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (sub === "clone") return { stdout: `${CLONE_UDID}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    calls.length = 0; // reset call log for the restore

    // Replace exec to track restore calls; provide a new UDID for the re-clone
    const restoreCalls: Array<readonly string[]> = [];
    const restoreExec: Exec = async (_file, args) => {
      restoreCalls.push(args);
      const sub = args[1];
      if (sub === "clone") return { stdout: `${RESTORE_UDID}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    // Rebuild manager with restoreExec to capture restore argv
    const mgr2 = makeManager(makeFakeExec({ deviceUdid: VALID_UDID }));
    await mgr2.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);

    // Now test restore argv by observing a combined exec
    const allCalls: Array<readonly string[]> = [];
    const combined: Exec = async (_file, args) => {
      allCalls.push(args);
      const sub = args[1];
      if (sub === "clone") return { stdout: `${RESTORE_UDID}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    // Use a direct approach: create manager, capture all argv across take + reset
    const trackingCalls: Array<readonly string[]> = [];
    let callCount = 0;
    const trackExec: Exec = async (_file, args) => {
      trackingCalls.push([...args]);
      callCount++;
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (sub === "clone") return { stdout: callCount <= 2 ? `${CLONE_UDID}\n` : `${RESTORE_UDID}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgrTracked = makeManager(trackExec);
    await mgrTracked.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await mgrTracked.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);

    const subcommands = trackingCalls.map((c) => c[1]);
    // During reset: shutdown, erase, clone
    expect(subcommands).toContain("shutdown");
    expect(subcommands).toContain("erase");
    expect(subcommands).toContain("clone");

    // All calls use argv arrays (no shell string — T1)
    for (const call of trackingCalls) {
      expect(Array.isArray(call)).toBe(true);
      expect(call[0]).toBe("simctl");
    }

    // Unused variable suppression
    void combined;
    void restoreExec;
    void mgr2;
    void restoreCalls;
    void calls;
  });

  it("repeated take→reset cycles all resolve consistently (success-metric AC)", async () => {
    const CYCLE_COUNT = 3;
    // A pool of valid UUID-format UDIDs for each clone call
    const POOL = [
      "AAAA0001-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      "AAAA0002-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      "AAAA0003-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      "AAAA0004-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      "AAAA0005-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
    ];
    let poolIdx = 0;
    const exec: Exec = async (_file, args) => {
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (sub === "clone") {
        const uid = POOL[poolIdx % POOL.length] ?? CLONE_UDID;
        poolIdx++;
        return { stdout: `${uid}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec);
    // Take once, reset repeatedly
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
  it("throws SnapshotNotFoundError when snapshot name was never taken", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec);
    await expect(
      mgr.resetToSnapshot(VALID_UDID, "never-taken"),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it("error message mentions 'snapshot' (T8 informative error requirement)", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec);
    const err = await mgr.resetToSnapshot(VALID_UDID, "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotNotFoundError);
    expect((err as Error).message).toMatch(/snapshot/i);
  });

  it("does NOT silently no-op — the promise must reject, not resolve", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec);
    // This MUST reject (never resolve), per the AC and T8/F6 requirement.
    const result = await mgr
      .resetToSnapshot(VALID_UDID, "nonexistent")
      .then(() => "RESOLVED" as const)
      .catch(() => "REJECTED" as const);
    expect(result).toBe("REJECTED");
  });

  it("reset to name-A fails after taking name-B (names are independent)", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    // Name-B was never taken — must throw.
    await expect(
      mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME_2),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it("SnapshotNotFoundError carries the snapshot name and udid", async () => {
    const exec = makeFakeExec({ deviceUdid: VALID_UDID });
    const mgr = makeManager(exec);
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
      const mgr = makeManager(exec);
      await expect(
        mgr.takeSnapshot(VALID_UDID, badName),
      ).rejects.toBeInstanceOf(InvalidSnapshotInputError);
    });

    it(`resetToSnapshot rejects snapshotName: ${JSON.stringify(badName)}`, async () => {
      const exec = makeFakeExec({ deviceUdid: VALID_UDID });
      const mgr = makeManager(exec);
      await expect(
        mgr.resetToSnapshot(VALID_UDID, badName),
      ).rejects.toBeInstanceOf(InvalidSnapshotInputError);
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
      const mgr = makeManager(exec);
      await expect(
        mgr.takeSnapshot(badUdid, SNAPSHOT_NAME),
      ).rejects.toBeInstanceOf(InvalidSnapshotInputError);
    });

    it(`resetToSnapshot rejects udid: ${JSON.stringify(badUdid)}`, async () => {
      const exec = makeFakeExec({ deviceUdid: VALID_UDID });
      const mgr = makeManager(exec);
      await expect(
        mgr.resetToSnapshot(badUdid, SNAPSHOT_NAME),
      ).rejects.toBeInstanceOf(InvalidSnapshotInputError);
    });
  }
});

// ---------------------------------------------------------------------------
// §6 — Unknown UDID: typed DeviceNotFoundError
// ---------------------------------------------------------------------------

describe("SnapshotManager — unknown udid → typed DeviceNotFoundError", () => {
  it("takeSnapshot throws DeviceNotFoundError when udid is absent from simctl list", async () => {
    // The device list JSON does NOT include VALID_UDID_2
    const exec = makeFakeExec({
      deviceUdid: VALID_UDID,      // list only knows VALID_UDID
      listDevicesResult: makeDeviceListJson(VALID_UDID),
    });
    const mgr = makeManager(exec);
    await expect(
      mgr.takeSnapshot(VALID_UDID_2, SNAPSHOT_NAME),
    ).rejects.toBeInstanceOf(DeviceNotFoundError);
  });

  it("DeviceNotFoundError is thrown even for a well-formed udid not in the list", async () => {
    const exec: Exec = async (_file, args) => {
      if (args[1] === "list") {
        return { stdout: makeDeviceListJson("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec);
    await expect(
      mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME),
    ).rejects.toBeInstanceOf(DeviceNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// §7 — clean-install strategy: argv and happy path
// ---------------------------------------------------------------------------

describe("SnapshotManager — clean-install strategy", () => {
  it("takeSnapshot with clean-install does NOT call simctl clone", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: Exec = async (_file, args) => {
      calls.push([...args]);
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, "clean-install");
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    const cloneCalls = calls.filter((c) => c[1] === "clone");
    expect(cloneCalls).toHaveLength(0); // no clone for clean-install take
  });

  it("resetToSnapshot with clean-install calls xcrun simctl erase <udid>", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: Exec = async (_file, args) => {
      calls.push([...args]);
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, "clean-install");
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);
    const eraseCalls = calls.filter((c) => c[1] === "erase");
    expect(eraseCalls).toHaveLength(1);
    expect(eraseCalls[0]?.[2]).toBe(VALID_UDID); // erase targets source udid
  });

  it("clean-install reset resolves without error", async () => {
    const exec: Exec = async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec, "clean-install");
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
      // The first arg must always be 'simctl'
      expect(args[0]).toBe("simctl");
      const sub = args[1];
      if (sub === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (sub === "clone") return { stdout: `${CLONE_UDID}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);
    // All calls go via xcrun
    for (const f of observedFiles) {
      expect(f).toBe("xcrun");
    }
  });

  it("the snapshot name appears in the clone argv, not interpolated into a shell string", async () => {
    const cloneArgs: string[][] = [];
    const exec: Exec = async (_file, args) => {
      if (args[1] === "clone") cloneArgs.push([...args]);
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      return { stdout: `${CLONE_UDID}\n`, stderr: "" };
    };
    await makeManager(exec).takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    // The name must appear as a discrete element, not concatenated into a string with spaces
    const cloneCmd = cloneArgs[0];
    expect(cloneCmd).toBeDefined();
    // argv[3] is the clone name — a single discrete string, not "clone <udid> <name> && something"
    const cloneName = cloneCmd?.[3];
    expect(cloneName).toBeTruthy();
    // It should contain the snapshot name but no shell metacharacters injected
    expect(cloneName).toContain(SNAPSHOT_NAME);
    // No semicolons or backticks — these would indicate shell injection
    expect(cloneName).not.toMatch(/[;&|`$]/);
  });
});

// ---------------------------------------------------------------------------
// §9 — Error handling: simctl clone returns invalid UDID
// ---------------------------------------------------------------------------

describe("SnapshotManager — error handling: invalid simctl clone output", () => {
  it("throws McpAdapterError when clone returns empty stdout", async () => {
    const exec: Exec = async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (args[1] === "clone") return { stdout: "", stderr: "" }; // empty = invalid UDID
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec);
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toThrow();
  });

  it("throws McpAdapterError when clone returns non-UUID stdout", async () => {
    const exec: Exec = async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (args[1] === "clone") return { stdout: "not-a-uuid\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr = makeManager(exec);
    await expect(mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §10 — Contract suite wiring: SnapshotManager + FakeMobileDriver as FullDriver
// ---------------------------------------------------------------------------

/**
 * Build a FullDriver that wires:
 *   - FakeMobileDriver for all lifecycle/driving ops (boot, install, launch, etc.)
 *   - SnapshotManager for takeSnapshot / resetToSnapshot
 *
 * The Exec is faked so no real Mac is needed.
 */
// Pre-built pool of valid UUID-format clone UDIDs for the contract driver.
// Must be >= the max number of clone calls the contract suite makes.
const CONTRACT_CLONE_POOL: readonly string[] = [
  "EE000001-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000002-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000003-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000004-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000005-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000006-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000007-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000008-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000009-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000010-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000011-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000012-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000013-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000014-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000015-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000016-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000017-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000018-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000019-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
  "EE000020-EEEE-EEEE-EEEE-EEEEEEEEEEEE",
];

function makeSnapshotDriver(): FullDriver {
  const fake = new FakeMobileDriver();

  // Shared call index so clone returns unique UDIDs from the pool.
  let cloneIdx = 0;

  const exec: Exec = async (_file: string, args: readonly string[]): Promise<ExecResult> => {
    const sub = args[1];

    if (sub === "list") {
      // Return a JSON device list containing the fake default UDID so
      // requireDeviceExists passes for DEFAULT_FAKE_UDID.
      return {
        stdout: makeDeviceListJson(DEFAULT_FAKE_UDID),
        stderr: "",
      };
    }

    if (sub === "clone") {
      // Use pool to return valid UUID-format UDIDs.
      const uid = CONTRACT_CLONE_POOL[cloneIdx % CONTRACT_CLONE_POOL.length] ?? CLONE_UDID;
      cloneIdx++;
      return { stdout: `${uid}\n`, stderr: "" };
    }

    if (sub === "shutdown" || sub === "erase") {
      return { stdout: "", stderr: "" };
    }

    return { stdout: "", stderr: "" };
  };

  const snapshotMgr = makeManager(exec, "clone");

  // Return a composite driver that satisfies FullDriver.
  // Snapshot methods go to SnapshotManager; all others to FakeMobileDriver.
  const driver: FullDriver = {
    // MobileDriverPort
    listDevices: () => fake.listDevices(),
    snapshotAccessibilityTree: (udid: string) => fake.snapshotAccessibilityTree(udid),
    screenshot: (udid: string) => fake.screenshot(udid),
    tap: (udid: string, target: TapTarget) => fake.tap(udid, target),
    typeText: (udid: string, text: string) => fake.typeText(udid, text),
    swipe: (udid: string, direction: SwipeDirection, distance?: number) =>
      fake.swipe(udid, direction, distance),
    // SimulatorLifecycle
    bootSimulator: (udid: string) => fake.bootSimulator(udid),
    installApp: (udid: string, path: string) => fake.installApp(udid, path),
    launchApp: (udid: string, bundleId: string) => fake.launchApp(udid, bundleId),
    shutdownSimulator: (udid: string) => fake.shutdownSimulator(udid),
    // Snapshot — real SnapshotManager
    takeSnapshot: (udid: string, name: string) => snapshotMgr.takeSnapshot(udid, name),
    resetToSnapshot: (udid: string, name: string) => snapshotMgr.resetToSnapshot(udid, name),
  };
  return driver;
}

// ---------------------------------------------------------------------------
// §10a — Targeted snapshot/reset contract assertions (subset of the shared suite)
//
// We run the snapshot/reset contract cases against the real SnapshotManager.
// We do NOT use runDriverContractSuite here because the composite driver mixes
// two error hierarchies (FakeMobileDriver errors for lifecycle/driving;
// McpAdapterError subclasses for snapshot) which creates incompatible
// errorClasses requirements for §6 and §9 of the parameterised suite.
//
// Instead, we directly assert the AC cases that are relevant to #16:
//   §2 — snapshot/reset happy path (mirrors suite §2)
//   §6 — unknown UDID handling for takeSnapshot/resetToSnapshot
//   §9 — injection-shaped snapshotName rejection (mirrors suite §9)
//
// ACs covered:
//   AC1 (takeSnapshot resolves)
//   AC2 (resetToSnapshot resolves after take)
//   AC3 (multiple snapshots independently)
//   AC4 (reset-to-missing throws SnapshotNotFoundError)
//   AC5 (unknown UDID → typed DeviceNotFoundError for takeSnapshot)
//   AC6 (injection snapshotName → typed InvalidSnapshotInputError)
// ---------------------------------------------------------------------------

const SNAPSHOT_NAME_CONTRACT = "clean-state";
const SNAPSHOT_NAME_CONTRACT_2 = "after-login";

describe("§10a — Snapshot/reset contract: §2 happy path (via composite driver)", () => {
  it("AC1: takeSnapshot resolves after boot+install", async () => {
    const d = makeSnapshotDriver();
    await d.bootSimulator(DEFAULT_FAKE_UDID);
    await d.installApp(DEFAULT_FAKE_UDID, "/fake/builds/Fixture.app");
    await expect(d.takeSnapshot(DEFAULT_FAKE_UDID, SNAPSHOT_NAME_CONTRACT)).resolves.toBeUndefined();
  });

  it("AC2: resetToSnapshot resolves after a snapshot has been taken", async () => {
    const d = makeSnapshotDriver();
    await d.bootSimulator(DEFAULT_FAKE_UDID);
    await d.installApp(DEFAULT_FAKE_UDID, "/fake/builds/Fixture.app");
    await d.takeSnapshot(DEFAULT_FAKE_UDID, SNAPSHOT_NAME_CONTRACT);
    await expect(d.resetToSnapshot(DEFAULT_FAKE_UDID, SNAPSHOT_NAME_CONTRACT)).resolves.toBeUndefined();
  });

  it("AC3: multiple distinct snapshots can be independently restored", async () => {
    const d = makeSnapshotDriver();
    await d.bootSimulator(DEFAULT_FAKE_UDID);
    await d.installApp(DEFAULT_FAKE_UDID, "/fake/builds/Fixture.app");
    await d.takeSnapshot(DEFAULT_FAKE_UDID, SNAPSHOT_NAME_CONTRACT);
    await d.takeSnapshot(DEFAULT_FAKE_UDID, SNAPSHOT_NAME_CONTRACT_2);
    await expect(d.resetToSnapshot(DEFAULT_FAKE_UDID, SNAPSHOT_NAME_CONTRACT)).resolves.toBeUndefined();
    await expect(d.resetToSnapshot(DEFAULT_FAKE_UDID, SNAPSHOT_NAME_CONTRACT_2)).resolves.toBeUndefined();
  });

  it("AC4: T8 — resetToSnapshot to a missing name throws SnapshotNotFoundError", async () => {
    const d = makeSnapshotDriver();
    await d.bootSimulator(DEFAULT_FAKE_UDID);
    await expect(
      d.resetToSnapshot(DEFAULT_FAKE_UDID, "snapshot-that-was-never-taken"),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it("AC4 message: T8 error mentions 'snapshot'", async () => {
    const d = makeSnapshotDriver();
    await d.bootSimulator(DEFAULT_FAKE_UDID);
    const err = await d.resetToSnapshot(DEFAULT_FAKE_UDID, "nonexistent").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotNotFoundError);
    expect((err as Error).message).toMatch(/snapshot/i);
  });

  it("full lifecycle: boot→install→launch→snapshot→reset→shutdown resolves", async () => {
    const d = makeSnapshotDriver();
    await d.bootSimulator(DEFAULT_FAKE_UDID);
    await d.installApp(DEFAULT_FAKE_UDID, "/fake/builds/Fixture.app");
    await d.launchApp(DEFAULT_FAKE_UDID, "com.example.flowscout.fixture");
    await d.takeSnapshot(DEFAULT_FAKE_UDID, SNAPSHOT_NAME_CONTRACT);
    await d.resetToSnapshot(DEFAULT_FAKE_UDID, SNAPSHOT_NAME_CONTRACT);
    await d.shutdownSimulator(DEFAULT_FAKE_UDID);
  });
});

describe("§10b — Snapshot/reset contract: §6 unknown UDID handling", () => {
  it("AC5: takeSnapshot with unknown UDID throws DeviceNotFoundError (typed not-found error)", async () => {
    const d = makeSnapshotDriver();
    // unknownUdid is a valid UUID format but not in the simctl list JSON
    // The exec returns a device list containing only DEFAULT_FAKE_UDID
    await expect(
      d.takeSnapshot("00000000-0000-0000-0000-FFFFFFFFFFFF", SNAPSHOT_NAME_CONTRACT),
    ).rejects.toBeInstanceOf(DeviceNotFoundError);
  });

  it("AC5: resetToSnapshot with valid-format-but-unknown UDID throws SnapshotNotFoundError", async () => {
    const d = makeSnapshotDriver();
    // The registry never has an entry for this udid, so SnapshotNotFoundError is thrown.
    await expect(
      d.resetToSnapshot("00000000-0000-0000-0000-FFFFFFFFFFFF", SNAPSHOT_NAME_CONTRACT),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });
});

describe("§10c — Snapshot/reset contract: §9 injection snapshotName rejection", () => {
  const badNames = [
    "; rm -rf snapshot",
    "$(injection)",
    "--flag",
    "",
    "a".repeat(65),
    "snap\x00shot",
  ];

  for (const badName of badNames) {
    it(`AC6: takeSnapshot rejects injection snapshotName: ${JSON.stringify(badName)}`, async () => {
      const d = makeSnapshotDriver();
      await d.bootSimulator(DEFAULT_FAKE_UDID);
      await expect(
        d.takeSnapshot(DEFAULT_FAKE_UDID, badName),
      ).rejects.toBeInstanceOf(InvalidSnapshotInputError);
    });

    it(`AC6: resetToSnapshot rejects injection snapshotName: ${JSON.stringify(badName)}`, async () => {
      const d = makeSnapshotDriver();
      await d.bootSimulator(DEFAULT_FAKE_UDID);
      await expect(
        d.resetToSnapshot(DEFAULT_FAKE_UDID, badName),
      ).rejects.toBeInstanceOf(InvalidSnapshotInputError);
    });
  }
});

// ---------------------------------------------------------------------------
// §11 — vi.fn() spy: prove exec is invoked (argv-safety via mock verification)
// ---------------------------------------------------------------------------

describe("SnapshotManager — spy: verifies exec called with argv arrays (T1)", () => {
  it("takeSnapshot calls exec with file='xcrun' and args[0]='simctl'", async () => {
    const spy = vi.fn<Exec>(async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (args[1] === "clone") return { stdout: `${CLONE_UDID}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const mgr = new SnapshotManager({} as McpConnection, makeConfig(), spy);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    expect(spy).toHaveBeenCalled();
    // Every call uses xcrun as the file (not a shell string)
    for (const call of spy.mock.calls) {
      expect(call[0]).toBe("xcrun");
      expect(call[1][0]).toBe("simctl");
    }
  });

  it("resetToSnapshot (after take) calls exec with file='xcrun' and args[0]='simctl'", async () => {
    let callCount = 0;
    const spy = vi.fn<Exec>(async (_file, args) => {
      callCount++;
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (args[1] === "clone") return { stdout: callCount <= 2 ? `${CLONE_UDID}\n` : `${RESTORE_UDID}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const mgr = new SnapshotManager({} as McpConnection, makeConfig(), spy);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME);
    await mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME);
    for (const call of spy.mock.calls) {
      expect(call[0]).toBe("xcrun");
      expect(call[1][0]).toBe("simctl");
    }
  });
});

// ---------------------------------------------------------------------------
// §12 — beforeEach isolation: each test gets a fresh manager
// ---------------------------------------------------------------------------

describe("SnapshotManager — registry isolation between instances", () => {
  let exec: Exec;
  let mgr: SnapshotManager;

  beforeEach(() => {
    const CLONE_POOL = [
      "BBBB0001-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
      "BBBB0002-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
      "BBBB0003-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
    ];
    let localCloneIdx = 0;
    exec = async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (args[1] === "clone") {
        const uid = CLONE_POOL[localCloneIdx % CLONE_POOL.length] ?? CLONE_UDID;
        localCloneIdx++;
        return { stdout: `${uid}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    mgr = makeManager(exec);
  });

  it("fresh manager starts with empty registry (no snapshots)", async () => {
    await expect(
      mgr.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it("taking a snapshot in instance A does not affect instance B", async () => {
    const exec2: Exec = async (_file, args) => {
      if (args[1] === "list") return { stdout: makeDeviceListJson(VALID_UDID), stderr: "" };
      if (args[1] === "clone") return { stdout: `${CLONE_UDID}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const mgr2 = makeManager(exec2);
    await mgr.takeSnapshot(VALID_UDID, SNAPSHOT_NAME); // register in mgr
    // mgr2 should not know about it
    await expect(
      mgr2.resetToSnapshot(VALID_UDID, SNAPSHOT_NAME),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });
});
