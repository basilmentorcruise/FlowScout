/**
 * simctl.ts — shared `xcrun simctl` exec helper (ADR-0002 §4 + §6).
 *
 * Relocated to the root of the adapter package (#12) so Wave-1 tickets
 * (#14 lifecycle, #16 snapshot) can import it in parallel without a
 * depends-on edge between them.
 *
 * Security controls (T1):
 * - ALL callers use `execFile`/`spawn` argv arrays — NEVER shell strings.
 * - The `Exec` seam is injectable, making the helper unit-testable without
 *   a real Mac or Xcode installation.
 * - Any value used as a positional argument must be validated by the caller
 *   before reaching this helper (UDID, bundleId, snapshotName allowlists
 *   are the caller's responsibility per T1/T2).
 *
 * #14 owns SimulatorLifecycleManager which uses this file.
 * #16 owns SnapshotManager which also uses this file.
 * Neither ticket edits this file — they import it read-only.
 *
 * #26 hardening: runSimctlWithTimeout now kills the spawned child process on
 * timeout via an AbortController/AbortSignal threaded through the Exec seam.
 */

/**
 * Result of a simctl exec call.
 */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Injectable executor function (the DI seam for unit-testability).
 * Signature matches Node's execFile promisified form, extended with an
 * optional AbortSignal so callers can kill the child process on demand.
 *
 * - file: the executable (e.g. "xcrun")
 * - args: the argument array (e.g. ["simctl", "list", "--json"])
 * - signal: optional AbortSignal; when aborted, the child process is killed
 *
 * The default implementation uses node:child_process.execFile with shell: false
 * via util.promisify — T1 compliance is structural (no shell string ever formed).
 */
export type Exec = (
  file: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<ExecResult>;

/**
 * Build the default Exec implementation backed by execFile.
 * Called once at construction; tests inject a fake instead.
 *
 * shell:false is implicit for execFile (it never uses a shell).
 * The AbortSignal is forwarded to execFile so the OS kills the child process
 * when the signal is aborted (T8 orphan-process fix, #26).
 */
export function createDefaultExec(): Exec {
  // Lazy require keeps this file unit-testable when callers inject a fake Exec.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFile } = require("node:child_process") as typeof import("node:child_process");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { promisify } = require("node:util") as typeof import("node:util");
  const execFileAsync = promisify(execFile);

  return async (file, args, signal) => {
    const result = await execFileAsync(file, [...args], { shell: false, signal });
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

/**
 * Run a xcrun simctl subcommand.
 *
 * @param args - arguments after simctl (e.g. ["list", "--json"])
 * @param exec - injectable executor; defaults to the real execFile wrapper
 */
export async function runSimctl(args: readonly string[], exec: Exec): Promise<ExecResult> {
  return exec("xcrun", ["simctl", ...args]);
}

/**
 * Run a xcrun simctl subcommand with a timeout.
 * Wraps exec in a race against a timer.
 *
 * On timeout:
 *   1. The internal AbortController is aborted, killing the spawned child process
 *      via the AbortSignal passed to the Exec implementation (T8 orphan-process fix, #26).
 *   2. The promise rejects with a descriptive error message.
 *
 * On success or exec-failure before timeout:
 *   - The timeout timer is cleared (no timer leak).
 *   - The signal is NOT aborted (no spurious kill).
 *
 * Note: exec is called directly (not via runSimctl) so the AbortSignal can be
 * forwarded without altering the runSimctl public signature.
 */
export async function runSimctlWithTimeout(
  args: readonly string[],
  exec: Exec,
  timeoutMs: number,
): Promise<ExecResult> {
  const controller = new AbortController();

  return new Promise<ExecResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Kill the child process by aborting the signal before rejecting.
      controller.abort();
      reject(new Error(`simctl ${args[0] ?? ""} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    exec("xcrun", ["simctl", ...args], controller.signal).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err: unknown) => {
        clearTimeout(timer);
        // Preserve the original error — wrap in Error if it is not already one.
        const wrapped = err instanceof Error ? err : new Error(`simctl error: ${String(err)}`);
        reject(wrapped);
      },
    );
  });
}
