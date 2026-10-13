/**
 * Bridge a synchronous better-sqlite3 operation into the async repository-port
 * contract: a sync throw (guard failure, disk error, corrupt-payload decode)
 * becomes a REJECTED promise — callers of a Promise-typed port method never
 * see a synchronous exception (port good citizenship / LSP parity with the
 * in-memory reference implementations).
 *
 * #85 (read-path bridge — #91 arch-review nit 2): generic over the action's
 * return value so the read paths (`find*`, `listRuns`) route their synchronous
 * payload decode through the same bridge as the writes.
 */
export function resolveAfter<T>(action: () => T): Promise<T> {
  try {
    return Promise.resolve(action());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
