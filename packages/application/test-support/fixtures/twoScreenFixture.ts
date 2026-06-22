/**
 * twoScreenFixture — synthetic 2-screen app fixture for crawl engine tests.
 *
 * Screen 1 (Home): has a "Go to Detail" button.
 * Screen 2 (Detail): has a "Back" button that returns to Home.
 *
 * The FakeMobileDriver alternates snapshots based on tap sequence:
 *   - Initial: Home screen
 *   - After tapping any element: Detail screen
 *   - After tapping any element again: Home screen (tests revisit/deduplication)
 *
 * Fixture data is entirely synthetic — no real identifiers, tokens, or PII.
 */
import type { A11ySnapshot, CandidateAction, TapTarget } from "@flowscout/domain";
import { FakeMobileDriver, FakeDecisionPolicy } from "../fakes/index.js";

/** Synthetic a11y snapshots — never contain real PII or identifiers. */
export const HOME_SNAPSHOT: A11ySnapshot =
  '{"role":"application","label":"Fake Home","children":[{"role":"button","label":"Go to Detail","id":"btn-go-detail"}]}' as A11ySnapshot;

export const DETAIL_SNAPSHOT: A11ySnapshot =
  '{"role":"application","label":"Fake Detail","children":[{"role":"button","label":"Back","id":"btn-back"}]}' as A11ySnapshot;

/** A FakeMobileDriver scripted to simulate a 2-screen navigation flow. */
export class TwoScreenDriver extends FakeMobileDriver {
  private _currentSnapshot: A11ySnapshot = HOME_SNAPSHOT;

  override async snapshotAccessibilityTree(_udid: string): Promise<A11ySnapshot> {
    return this._currentSnapshot;
  }

  override async tap(_udid: string, _target: TapTarget): Promise<void> {
    // Alternate screens on tap: Home -> Detail -> Home -> ...
    if (this._currentSnapshot === HOME_SNAPSHOT) {
      this._currentSnapshot = DETAIL_SNAPSHOT;
    } else {
      this._currentSnapshot = HOME_SNAPSHOT;
    }
  }

  get currentSnapshot(): A11ySnapshot {
    return this._currentSnapshot;
  }
}

/** Decision sequence for the 2-screen fixture:
 *  1. Tap the "Go to Detail" button (act)
 *  2. Tap the "Back" button (act)
 *  3. Done (we've seen both screens)
 */
const GO_TO_DETAIL_ACTION: CandidateAction = {
  actionType: "tap",
  actionPayload: JSON.stringify({ elementId: "btn-go-detail" }),
  rationale: "navigate to detail screen",
};

const BACK_ACTION: CandidateAction = {
  actionType: "tap",
  actionPayload: JSON.stringify({ elementId: "btn-back" }),
  rationale: "navigate back to home",
};

export interface TwoScreenFixture {
  readonly driver: TwoScreenDriver;
  readonly policy: FakeDecisionPolicy;
}

/**
 * Factory: returns a scripted 2-screen fixture ready for crawl tests.
 * Call once per test to keep tests isolated.
 */
export function twoScreenFixture(): TwoScreenFixture {
  const driver = new TwoScreenDriver();
  const policy = new FakeDecisionPolicy([
    { kind: "act", action: GO_TO_DETAIL_ACTION, usedLlm: false },
    { kind: "act", action: BACK_ACTION, usedLlm: false },
    { kind: "done", reason: "all screens visited" },
  ]);
  return { driver, policy };
}
