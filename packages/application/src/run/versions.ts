/**
 * Run provenance version constants (#84 / E7.2, e7-plan §#84).
 *
 * Every `Run` created by the write-path orchestrator is stamped with driver /
 * policy / schema versions for reproducibility and future cross-run diffing
 * (ADR-0001 §2.7 provenance intent, preserved by ADR-0008 §1.4). Named constants
 * — never inline magic strings at the creation site.
 */

/** Version provenance stamped onto a `Run` at creation. */
export interface RunVersions {
  /** Concrete mobile-driver adapter generation used for the crawl. */
  readonly driverVersion: string;
  /** Decision-policy chain generation (cached-knowledge head + LLM leaf). */
  readonly policyVersion: string;
  /** FlowScout persistence/domain schema generation (ADR-0008 hybrid schema). */
  readonly schemaVersion: string;
}

/** Mobile MCP driver generation (E1 adapter, ADR-0003). */
export const DRIVER_VERSION = "mobile-mcp-driver/0.0.1";

/** Crawl decision-policy chain generation (E2.6/E2.7, ADR-0004). */
export const POLICY_VERSION = "policy-chain/e2.7";

/** Persistence schema generation (ADR-0008 §1.3 hybrid schema, first cut). */
export const SCHEMA_VERSION = "flowscout-schema/1";

/** The default provenance set — injectable seam for tests (DI). */
export function defaultRunVersions(): RunVersions {
  return {
    driverVersion: DRIVER_VERSION,
    policyVersion: POLICY_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
}
