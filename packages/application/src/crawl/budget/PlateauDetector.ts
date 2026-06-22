/**
 * PlateauDetector — tracks coverage plateau for the crawl engine (#33 / E2.3).
 *
 * Coverage plateau = no new distinct StateIdentity discovered in `plateauWindow`
 * consecutive steps. ADR-0004 §4 defines this as the stopping criterion.
 *
 * A "new" state is detected by `visitCount === 1` at the time of `recordStep`.
 * When `visitCount === 1`, the step introduced a new node → reset the counter.
 *
 * Thread-of-control: one per BudgetEnforcer, called synchronously from recordStep.
 * No async, no I/O — pure state.
 */
export class PlateauDetector {
  /** Steps elapsed since the last new distinct StateIdentity was discovered. */
  private stepsSinceNewState = 0;

  /** Total number of distinct states discovered so far. */
  private distinctStateCount = 0;

  constructor(private readonly plateauWindow: number) {}

  /**
   * Record one step. If `isNewState` is true the counter resets; otherwise increments.
   * Returns true if the plateau window has been reached.
   */
  recordStep(isNewState: boolean): boolean {
    if (isNewState) {
      this.distinctStateCount++;
      this.stepsSinceNewState = 0;
    } else {
      this.stepsSinceNewState++;
    }
    return this.stepsSinceNewState >= this.plateauWindow;
  }

  /** Steps elapsed since the last new state was discovered. */
  getStepsSinceNewState(): number {
    return this.stepsSinceNewState;
  }

  /** Total distinct states discovered so far. */
  getDistinctStateCount(): number {
    return this.distinctStateCount;
  }

  /**
   * Returns the plateau window size this detector was constructed with.
   */
  getPlateauWindow(): number {
    return this.plateauWindow;
  }

  /**
   * Whether the plateau window has been reached.
   */
  isPlateauReached(): boolean {
    return this.stepsSinceNewState >= this.plateauWindow;
  }
}
