/**
 * Run domain model.
 * A Run is a single crawl execution — the top-level aggregate tying
 * the app, its configuration, state-graph, workflows, and report together.
 */
import type { RunStatus } from "./report.js";

/** Crawl budget configuration (no magic numbers: all values must be explicit). */
export interface CrawlBudget {
  /** Maximum number of crawl steps per run. */
  readonly maxSteps: number;
  /** Maximum number of LLM calls per run. */
  readonly maxLlmCalls: number;
  /** Maximum token spend per run (prompt + completion). */
  readonly maxTokens: number;
  /** Maximum revisits to the same state identity before skipping. */
  readonly maxRevisitsPerState: number;
  /**
   * Number of consecutive steps with no new distinct StateIdentity before
   * the engine finalizes with a coverage-plateau termination (status=partial).
   * ADR-0004 §4: configurable, not a fixed heuristic.
   */
  readonly plateauWindow: number;
  /**
   * Fraction of plateauWindow elapsed before a BudgetWarningEvent("plateau")
   * is emitted (e.g. 0.75 = warn at 75% of the plateau window).
   * ADR-0004 §4: configurable warn ratio.
   */
  readonly plateauWarnRatio: number;
}

/**
 * Default crawl budget factory — all defaults from ADR-0004 §3.6.
 * No magic numbers in the engine: the loop always reads from config.
 *
 * | Field                | Default | Rationale (ADR-0004 §3.6)                          |
 * | -------------------- | ------- | --------------------------------------------------- |
 * | maxSteps             | 400     | Upper bound on a single-app exploration run.        |
 * | maxLlmCalls          | 40      | F2 lever — ~10% of steps is the ceiling.            |
 * | maxTokens            | 120000  | ≈ maxLlmCalls × ~3k tokens/call headroom.           |
 * | maxRevisitsPerState  | 3       | Breaks A→B→A loops.                                 |
 * | plateauWindow        | 40      | No new state in 40 steps ⇒ coverage plateau.        |
 * | plateauWarnRatio     | 0.75    | Warn at 75% of plateau window elapsed.              |
 */
export function defaultCrawlBudget(): CrawlBudget {
  return {
    maxSteps: 400,
    maxLlmCalls: 40,
    maxTokens: 120_000,
    maxRevisitsPerState: 3,
    plateauWindow: 40,
    plateauWarnRatio: 0.75,
  };
}

/** A crawl run record. */
export interface Run {
  readonly id: string;
  readonly appId: string;
  readonly appVersion: string;
  readonly platform: "ios" | "android";
  readonly budget: CrawlBudget;
  readonly status: RunStatus;
  readonly startedAt: string; // ISO-8601
  readonly finishedAt: string | null; // ISO-8601 or null if in-progress
  /** Driver + policy versions for reproducibility and diffing. */
  readonly driverVersion: string;
  readonly policyVersion: string;
  /** FlowScout schema version at time of run. */
  readonly schemaVersion: string;
}
