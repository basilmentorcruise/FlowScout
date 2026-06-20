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
