/**
 * Bridge a synchronous better-sqlite3 operation into the async repository-port
 * contract: a sync throw (guard failure, disk error) becomes a REJECTED promise —
 * callers of `save*(...)` never see a synchronous exception from a Promise-typed
 * method (port good citizenship).
 */
export function resolveAfter(action: () => void): Promise<void> {
  try {
    action();
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
