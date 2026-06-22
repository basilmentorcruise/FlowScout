/**
 * PlaceholderIdentity — minimal stub StateIdentity strategy for #31.
 *
 * Computes a state identity from the raw a11y snapshot string using a simple
 * hash function. This is intentionally deterministic and snapshot-content-based
 * so that the same snapshot always produces the same identity (deduplication
 * works in the walking skeleton).
 *
 * #32 (E2.2) replaces this with the full A11y-signature strategy (SHA-256 of
 * normalized structural skeleton per ADR-0004 §2) — injected via DI at the
 * collaborators seam, not editing this file.
 *
 * Dependency: only @flowscout/domain (port-only, no adapter or SDK imports).
 */
import type { A11ySnapshot, StateIdentity } from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";

/** djb2 initial seed value (classic: 5381). */
const DJB2_SEED = 5381;
/** djb2 multiplier constant: hash * 33 = (hash << 5) + hash. */
const DJB2_MULTIPLIER = 33;
/** Hex output radix. */
const HEX_RADIX = 16;
/** Pad to this width (32-bit uint → 8 hex digits max). */
const HEX_PAD_WIDTH = 8;

/**
 * Deterministic identity computed from the raw snapshot content.
 * Uses a djb2-style hash — good enough for the walking skeleton;
 * #32 will swap in a cryptographic hash with structural normalization.
 */
export function placeholderIdentify(snapshot: A11ySnapshot): StateIdentity {
  if (!snapshot || snapshot.trim().length === 0) {
    // Degraded path: empty/null snapshot gets a fixed degraded identity
    return makeStateIdentity("degraded:empty-snapshot");
  }

  const hash = djb2Hash(snapshot);
  return makeStateIdentity(`placeholder:${hash}`);
}

/**
 * djb2 hash — fast, non-cryptographic string hash.
 * Same input always yields the same output (deterministic).
 * #32 replaces this with SHA-256 + structural normalization.
 */
function djb2Hash(str: string): string {
  let hash = DJB2_SEED;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    // Standard djb2: hash = hash * 33 + char (kept 32-bit with |0)
    hash = (Math.imul(hash, DJB2_MULTIPLIER) + char) | 0;
  }
  // Shift to unsigned 32-bit for a non-negative hex string
  return (hash >>> 0).toString(HEX_RADIX).padStart(HEX_PAD_WIDTH, "0");
}
