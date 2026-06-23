/**
 * simctl.test.ts — unit tests for simctl helpers (#26 hardening: kill child on timeout).
 *
 * ACs covered:
 *
 * AC1 — "Given a runSimctlWithTimeout call that times out, When the timeout fires,
 *         Then the injected exec is called with an AbortSignal and that signal is
 *         aborted (which kills the underlying child process)."
 *   → tests: "timeout aborts the AbortSignal passed to exec"
 *             "killed signal is aborted before the rejection propagates"
 *
 * AC2 — "Given a runSimctlWithTimeout call that completes within the timeout,
 *         When it resolves, Then the timeout timer is cleared (no timer leak)."
 *   → tests: "timer is cleared on success (clearTimeout called)"
 *             "resolves with the exec result on success"
 *
 * AC3 — "Given a runSimctlWithTimeout call whose exec rejects within the timeout,
 *         When exec rejects, Then the error is propagated and the timer is cleared."
 *   → tests: "timer is cleared on exec failure (clearTimeout called)"
 *             "original exec error is propagated when exec fails before timeout"
 *
 * AC4 — "Given a runSimctl call, When called, Then it calls exec with xcrun + simctl prefix."
 *   → tests: "runSimctl passes xcrun + simctl argv to exec"
 *
 * Strategy:
 *   - Inject a fake Exec to control resolution/rejection timing.
 *   - Use vi.spyOn(globalThis, 'clearTimeout') to assert timer cleanup.
 *   - Capture the AbortSignal passed to exec and assert it is aborted on timeout.
 *   - Use vi.useFakeTimers / vi.advanceTimersByTimeAsync to control setTimeout behavior.
 *   - Attach a .catch() to timeout promises BEFORE advancing timers to avoid
 *     "unhandled rejection" false positives from Vitest's async rejection detector.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSimctl, runSimctlWithTimeout } from "../simctl.js";
import type { Exec, ExecResult } from "../simctl.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 100;
const SUCCESS_RESULT: ExecResult = { stdout: "ok", stderr: "" };

// ---------------------------------------------------------------------------
// §1 — runSimctl: basic argv routing
// ---------------------------------------------------------------------------

describe("runSimctl — argv routing", () => {
  it("calls exec with 'xcrun' and ['simctl', ...args]", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const exec: Exec = async (file, args) => {
      calls.push({ file, args });
      return SUCCESS_RESULT;
    };

    await runSimctl(["list", "--json"], exec);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("xcrun");
    expect(calls[0]?.args).toEqual(["simctl", "list", "--json"]);
  });

  it("returns the exec result unchanged", async () => {
    const exec: Exec = async () => ({ stdout: "data", stderr: "warn" });
    const result = await runSimctl(["boot", "FAKE-UDID"], exec);
    expect(result.stdout).toBe("data");
    expect(result.stderr).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// §2 — runSimctlWithTimeout: happy-path (success within timeout)
// ---------------------------------------------------------------------------

describe("runSimctlWithTimeout — success path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the exec result when exec completes before the timeout", async () => {
    const exec: Exec = async () => SUCCESS_RESULT;
    const result = await runSimctlWithTimeout(["list"], exec, TIMEOUT_MS);
    expect(result).toEqual(SUCCESS_RESULT);
  });

  it("clears the timeout timer on success (no timer leak)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    const exec: Exec = async () => SUCCESS_RESULT;
    await runSimctlWithTimeout(["list"], exec, TIMEOUT_MS);

    // clearTimeout must have been called (timer cleanup on success path).
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("does NOT abort the exec signal on successful completion", async () => {
    let capturedSignal: AbortSignal | undefined;
    const exec: Exec = async (_file, _args, signal) => {
      capturedSignal = signal;
      return SUCCESS_RESULT;
    };

    await runSimctlWithTimeout(["list"], exec, TIMEOUT_MS);

    // Signal should exist but must NOT be aborted on the success path.
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §3 — runSimctlWithTimeout: exec failure before timeout
// ---------------------------------------------------------------------------

describe("runSimctlWithTimeout — exec error path (before timeout)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("propagates the exec error when exec rejects before the timeout fires", async () => {
    const execError = new Error("simctl exited with code 1");
    const exec: Exec = async () => {
      throw execError;
    };

    await expect(runSimctlWithTimeout(["boot", "FAKE"], exec, TIMEOUT_MS)).rejects.toBe(execError);
  });

  it("wraps non-Error exec rejections in an Error", async () => {
    const exec: Exec = async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "raw string error";
    };

    const err = await runSimctlWithTimeout(["list"], exec, TIMEOUT_MS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });

  it("clears the timeout timer when exec rejects before timeout (no timer leak)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    const exec: Exec = async () => {
      throw new Error("exec failure");
    };

    await runSimctlWithTimeout(["list"], exec, TIMEOUT_MS).catch(() => {
      /* expected */
    });

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// §4 — runSimctlWithTimeout: timeout fires → child killed via AbortSignal (AC1 — core fix)
// ---------------------------------------------------------------------------

describe("runSimctlWithTimeout — timeout fires → AbortSignal aborted (kill child)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the AbortSignal passed to exec when the timeout fires (kills the child)", async () => {
    let capturedSignal: AbortSignal | undefined;

    // Exec that never resolves — simulates a hung child process.
    const exec: Exec = (_file, _args, signal) => {
      capturedSignal = signal;
      return new Promise<ExecResult>(() => {
        /* intentionally never resolves */
      });
    };

    const timeoutPromise = runSimctlWithTimeout(["boot", "FAKE-UDID"], exec, TIMEOUT_MS);

    // Attach a rejection handler BEFORE advancing timers to avoid the "unhandled
    // rejection" warning that fires when the timeout rejects before we can catch it.
    const caught = timeoutPromise.catch((e: unknown) => e);

    // Advance fake clock past the timeout boundary — this triggers the rejection.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/i);

    // The signal passed to exec MUST be aborted — this is what kills the child.
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("passes an AbortSignal (not undefined) to exec on every call", async () => {
    let receivedSignal: AbortSignal | undefined | null = null;

    const exec: Exec = async (_file, _args, signal) => {
      receivedSignal = signal;
      return SUCCESS_RESULT;
    };

    await runSimctlWithTimeout(["list"], exec, TIMEOUT_MS);

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it("timeout error message names the subcommand and timeout value", async () => {
    const exec: Exec = () =>
      new Promise<ExecResult>(() => {
        /* never resolves */
      });

    const timeoutPromise = runSimctlWithTimeout(["shutdown"], exec, TIMEOUT_MS);
    // Attach handler before advancing timers to avoid unhandled rejection warning.
    const caught = timeoutPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("shutdown");
    expect((err as Error).message).toContain(String(TIMEOUT_MS));
  });

  it("aborts the signal BEFORE the promise rejects (signal is aborted when rejection propagates)", async () => {
    let signalAbortedAtRejection = false;
    let capturedSignal: AbortSignal | undefined;

    const exec: Exec = (_file, _args, signal) => {
      capturedSignal = signal;
      return new Promise<ExecResult>(() => {
        /* never resolves */
      });
    };

    const timeoutPromise = runSimctlWithTimeout(["list"], exec, TIMEOUT_MS);
    // Attach handler before advancing timers.
    const caught = timeoutPromise.catch(() => {
      // By the time the rejection handler runs, the signal must already be aborted.
      if (capturedSignal !== undefined) {
        signalAbortedAtRejection = capturedSignal.aborted;
      }
    });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    await caught;

    expect(signalAbortedAtRejection).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §5 — runSimctlWithTimeout: signal is not aborted when exec resolves (no spurious kill)
// ---------------------------------------------------------------------------

describe("runSimctlWithTimeout — no spurious kill on fast exec", () => {
  it("signal is NOT aborted when exec resolves before timeout (real timers)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const exec: Exec = async (_file, _args, signal) => {
      capturedSignal = signal;
      return SUCCESS_RESULT;
    };

    await runSimctlWithTimeout(["list"], exec, 1_000);

    expect(capturedSignal?.aborted).toBe(false);
  });
});
