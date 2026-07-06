/**
 * RunCodec — pure, deterministic Run ⇄ payload serialization (ADR-0008 §5).
 *
 * Deterministic: keys are emitted in a FIXED order via explicit object literals,
 * so the same Run always produces identical bytes (byte-stable — enables diffing).
 * Decode rebuilds via allow-listed fields only (M83.3) and never transforms string
 * content (raw/inert round-trip — M83.5/M83.8: a `[REDACTED]` marker passes through
 * unchanged; the codec introduces no new secret sink and never de-redacts).
 * No I/O.
 */
import type { Run, CrawlBudget } from "@flowscout/domain";
import {
  asRecord,
  parsePayload,
  readEnum,
  readNullableString,
  readNumber,
  readString,
} from "./primitives.js";

const RUN_STATUSES: ReadonlySet<Run["status"]> = new Set<Run["status"]>([
  "running",
  "completed",
  "partial",
  "blocked-on-2fa",
  "error",
]);
const PLATFORMS: ReadonlySet<Run["platform"]> = new Set<Run["platform"]>(["ios", "android"]);

function encodeBudget(budget: CrawlBudget): Record<string, number> {
  return {
    maxSteps: budget.maxSteps,
    maxLlmCalls: budget.maxLlmCalls,
    maxTokens: budget.maxTokens,
    maxRevisitsPerState: budget.maxRevisitsPerState,
    plateauWindow: budget.plateauWindow,
    plateauWarnRatio: budget.plateauWarnRatio,
  };
}

function decodeBudget(value: unknown): CrawlBudget {
  const record = asRecord(value, "budget");
  return {
    maxSteps: readNumber(record, "maxSteps"),
    maxLlmCalls: readNumber(record, "maxLlmCalls"),
    maxTokens: readNumber(record, "maxTokens"),
    maxRevisitsPerState: readNumber(record, "maxRevisitsPerState"),
    plateauWindow: readNumber(record, "plateauWindow"),
    plateauWarnRatio: readNumber(record, "plateauWarnRatio"),
  };
}

/** Encode a Run to its deterministic JSON payload. */
export function encodeRun(run: Run): string {
  return JSON.stringify({
    id: run.id,
    appId: run.appId,
    appVersion: run.appVersion,
    platform: run.platform,
    budget: encodeBudget(run.budget),
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    driverVersion: run.driverVersion,
    policyVersion: run.policyVersion,
    schemaVersion: run.schemaVersion,
  });
}

/** Decode a payload back into a deep-equal Run (allow-listed fields only — M83.3). */
export function decodeRun(payload: string): Run {
  const record = parsePayload(payload);
  return {
    id: readString(record, "id"),
    appId: readString(record, "appId"),
    appVersion: readString(record, "appVersion"),
    platform: readEnum(record, "platform", PLATFORMS),
    budget: decodeBudget(record["budget"]),
    status: readEnum(record, "status", RUN_STATUSES),
    startedAt: readString(record, "startedAt"),
    finishedAt: readNullableString(record, "finishedAt"),
    driverVersion: readString(record, "driverVersion"),
    policyVersion: readString(record, "policyVersion"),
    schemaVersion: readString(record, "schemaVersion"),
  };
}
