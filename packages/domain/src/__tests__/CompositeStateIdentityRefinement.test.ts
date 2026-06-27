/**
 * Tests for the ACTIVATED CompositeStateIdentityStrategy merge step + SamenessConfig (#57).
 *
 * Covers:
 *  - No canonical map ⇒ pure E2 delegation (byte-for-byte primary identity).
 *  - Canonical map present ⇒ bucket mapped to its class canonical (a MERGE, never a split).
 *  - Bucket absent from the map ⇒ raw a11y identity (E2 fallback).
 *  - identify stays SYNCHRONOUS (returns a value, not a Promise) and never throws.
 *  - defaultSamenessConfig exposes the ADR-0005 §3 thresholds.
 */
import { describe, it, expect } from "vitest";
import { CompositeStateIdentityStrategy } from "../models/state-identity/CompositeStateIdentityStrategy.js";
import type { CanonicalIdentityMap } from "../models/state-identity/CompositeStateIdentityStrategy.js";
import {
  defaultSamenessConfig,
  DEFAULT_MERGE_THRESHOLD,
  DEFAULT_MERGE_MARGIN,
  DEFAULT_MIN_EMBEDDING_DIM,
} from "../models/state-identity/SamenessConfig.js";
import { makeStateIdentity } from "../models/state-graph.js";
import type { Platform, StateIdentity } from "../models/state-graph.js";
import type { StateIdentityInput, StateIdentityStrategy } from "../ports/StateIdentityPort.js";
import type { A11ySnapshot } from "../ports/MobileDriverPort.js";

const PLATFORM: Platform = "ios";

/** A stub primary that returns a fixed identity regardless of input (isolates the composite). */
class StubPrimary implements StateIdentityStrategy {
  constructor(private readonly value: StateIdentity) {}
  identify(): StateIdentity {
    return this.value;
  }
}

function input(): StateIdentityInput {
  return {
    a11ySnapshot: "{}" as unknown as A11ySnapshot,
    platform: PLATFORM,
  };
}

describe("CompositeStateIdentityStrategy — E2 delegation (no canonical map)", () => {
  it("returns the primary identity unchanged when no map is supplied", () => {
    const bucket = makeStateIdentity("bucket-x");
    const composite = new CompositeStateIdentityStrategy(new StubPrimary(bucket));
    expect(composite.identify(input())).toBe(bucket);
  });
});

describe("CompositeStateIdentityStrategy — activated merge (canonical map)", () => {
  it("maps a bucket to its class canonical identity (a merge)", () => {
    const bucket = makeStateIdentity("bucket-tab");
    const canonical = makeStateIdentity("bucket-overflow");
    const map: CanonicalIdentityMap = new Map([[bucket, canonical]]);
    const composite = new CompositeStateIdentityStrategy(new StubPrimary(bucket), map);
    expect(composite.identify(input())).toBe(canonical);
  });

  it("falls back to the raw a11y identity when the bucket is absent from the map", () => {
    const bucket = makeStateIdentity("bucket-unmerged");
    const map: CanonicalIdentityMap = new Map([
      [makeStateIdentity("other"), makeStateIdentity("other-canonical")],
    ]);
    const composite = new CompositeStateIdentityStrategy(new StubPrimary(bucket), map);
    expect(composite.identify(input())).toBe(bucket);
  });

  it("identify is synchronous — returns a StateIdentity value, not a Promise", () => {
    const bucket = makeStateIdentity("sync-bucket");
    const composite = new CompositeStateIdentityStrategy(new StubPrimary(bucket), new Map());
    const result: StateIdentity = composite.identify(input());
    expect(typeof result).toBe("string");
    expect(result).not.toBeInstanceOf(Promise);
  });
});

describe("defaultSamenessConfig", () => {
  it("exposes the ADR-0005 §3 precision-biased defaults", () => {
    const config = defaultSamenessConfig();
    expect(config.refinementEnabled).toBe(true);
    expect(config.mergeThreshold).toBe(DEFAULT_MERGE_THRESHOLD);
    expect(config.mergeThreshold).toBe(0.94);
    expect(config.mergeMargin).toBe(DEFAULT_MERGE_MARGIN);
    expect(config.mergeMargin).toBe(0.02);
    expect(config.labelVetoEnabled).toBe(true);
    expect(config.minEmbeddingDim).toBe(DEFAULT_MIN_EMBEDDING_DIM);
    expect(config.minEmbeddingDim).toBe(256);
  });
});
