/**
 * health/index.ts — stub for the health/readiness capability module.
 *
 * #12 OWNS THIS FILE as a NotImplemented stub.
 * #17 (E1.6 — Health/readiness checks) REPLACES this file entirely with
 * the real HealthReadiness implementation.
 *
 * Do NOT add logic here — stub only.
 */

import type { HealthCapability, ReadinessResult } from "../connection/capabilities.js";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`HealthCapability.${method} is not yet implemented — see ticket #17 (E1.6).`),
  );
}

/** Stub implementation — all methods throw NotImplemented. */
export class HealthStub implements HealthCapability {
  checkReadiness(_udid?: string): Promise<ReadinessResult> {
    return notImplemented("checkReadiness");
  }
}
