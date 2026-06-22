/**
 * PlateauDetector unit tests — #33 / E2.3.
 *
 * Acceptance criteria covered:
 * - Given plateauWindow=W, when W steps pass with no new state, isPlateauReached()=true.
 * - A new-state step resets the counter.
 * - stepsSinceNewState increments correctly on revisits.
 * - distinctStateCount tracks correctly.
 */
import { describe, it, expect } from "vitest";
import { PlateauDetector } from "../PlateauDetector.js";

describe("PlateauDetector", () => {
  describe("initial state", () => {
    it("starts with stepsSinceNewState=0 and distinctStateCount=0", () => {
      const det = new PlateauDetector(5);
      expect(det.getStepsSinceNewState()).toBe(0);
      expect(det.getDistinctStateCount()).toBe(0);
      expect(det.isPlateauReached()).toBe(false);
    });
  });

  describe("plateau detection", () => {
    it("reaches plateau after exactly plateauWindow consecutive non-new steps", () => {
      const window = 3;
      const det = new PlateauDetector(window);

      // Start with one new state
      det.recordStep(true);
      expect(det.isPlateauReached()).toBe(false);

      // Revisit steps — not new states
      det.recordStep(false);
      expect(det.isPlateauReached()).toBe(false);
      det.recordStep(false);
      expect(det.isPlateauReached()).toBe(false);
      // Third non-new step reaches the window
      det.recordStep(false);
      expect(det.isPlateauReached()).toBe(true);
    });

    it("returns true from recordStep when plateau is reached", () => {
      const det = new PlateauDetector(2);
      det.recordStep(true); // new state, counter = 0
      det.recordStep(false); // counter = 1
      const reached = det.recordStep(false); // counter = 2 >= window → reached
      expect(reached).toBe(true);
    });

    it("does not reach plateau if a new state resets the counter", () => {
      const det = new PlateauDetector(3);
      det.recordStep(true);  // counter = 0
      det.recordStep(false); // counter = 1
      det.recordStep(false); // counter = 2
      det.recordStep(true);  // new state → counter resets to 0
      expect(det.isPlateauReached()).toBe(false);
      expect(det.getStepsSinceNewState()).toBe(0);
    });

    it("plateau at window=1 triggers after one non-new step", () => {
      const det = new PlateauDetector(1);
      det.recordStep(true);  // new state, counter = 0
      expect(det.isPlateauReached()).toBe(false);
      det.recordStep(false); // counter = 1 >= window → reached
      expect(det.isPlateauReached()).toBe(true);
    });
  });

  describe("distinctStateCount", () => {
    it("increments only on new-state steps", () => {
      const det = new PlateauDetector(10);
      det.recordStep(true);
      det.recordStep(false);
      det.recordStep(true);
      det.recordStep(false);
      det.recordStep(true);
      expect(det.getDistinctStateCount()).toBe(3);
    });
  });

  describe("stepsSinceNewState", () => {
    it("increments on non-new steps and resets on new-state steps", () => {
      const det = new PlateauDetector(100);
      det.recordStep(true);  // counter = 0
      expect(det.getStepsSinceNewState()).toBe(0);
      det.recordStep(false); // counter = 1
      expect(det.getStepsSinceNewState()).toBe(1);
      det.recordStep(false); // counter = 2
      expect(det.getStepsSinceNewState()).toBe(2);
      det.recordStep(true);  // new state → counter = 0
      expect(det.getStepsSinceNewState()).toBe(0);
    });
  });

  describe("getPlateauWindow", () => {
    it("returns the configured plateau window", () => {
      const det = new PlateauDetector(40);
      expect(det.getPlateauWindow()).toBe(40);
    });
  });
});
