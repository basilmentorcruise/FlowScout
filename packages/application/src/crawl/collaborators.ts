/**
 * collaborators.ts — UNFROZEN by #37 (additive only, per ADR-0004 §7.2 addendum).
 *
 * #37 adds new OPTIONAL collaborator fields (with safe defaults) without changing:
 *   - The existing `CrawlCollaborators` required fields.
 *   - The public constructor signature of `StartCrawlRun`.
 *   - `defaultCollaborators({ stateGraphRepository, crawlEventStream })` — still compiles.
 *
 * Wave-1 replacement contract (unchanged):
 *   - #33 (E2.3 budgets): BudgetEnforcer body in budget/BudgetEnforcer.ts
 *   - #34 (E2.4 frontier): Frontier body in frontier/Frontier.ts
 *   - #35 (E2.5 probes): Frontier extension point
 *   - #36 (E2.6 policy chain): real DecisionPolicy at composition root
 *   - #37 (E2.7 integration): THIS FILE — additive unfreeze (ADR-0004 §7.2 addendum)
 *
 * Dependency: only @flowscout/domain and sibling crawl/* modules. No adapters.
 */
import type {
  StateIdentity,
  A11ySnapshot,
  StateGraphRepository,
  CrawlEventStream,
  SimulatorLifecycle,
} from "@flowscout/domain";
import { A11ySignatureStrategy, CompositeStateIdentityStrategy } from "@flowscout/domain";
import { BudgetEnforcer } from "./budget/BudgetEnforcer.js";
import type { BudgetContext } from "./budget/BudgetEnforcer.js";
import { Frontier } from "./frontier/Frontier.js";
import { registerHiddenAffordanceProbes } from "./frontier/probes/index.js";
import { CredentialRedactor } from "./redaction/CredentialRedactor.js";
import { CredentialBoundaryDetector } from "./twofa/CredentialBoundaryDetector.js";
import { DuplicatePathDetector } from "./duplicate/DuplicatePathDetector.js";
import { defaultEnumerateBaseCandidates } from "./BaseCandidateEnumerator.js";
import type { BaseCandidateEnumeratorFn } from "./BaseCandidateEnumerator.js";
import { NoOpUsageReporter } from "./UsageReporter.js";
import type { UsageReporter } from "./UsageReporter.js";
import type { CrawlRunSafety } from "./CrawlRunSafety.js";

// ── Collaborator interfaces ───────────────────────────────────────────────────

/**
 * StateIdentityFn — a function that maps an a11y snapshot to a stable StateIdentity.
 * #31 ships `placeholderIdentify`; #34 injects #32's `A11ySignatureStrategy.identify`.
 * The loop calls this function — it never knows which strategy is active.
 */
export type StateIdentityFn = (snapshot: A11ySnapshot) => StateIdentity;

// Re-export the context type so the loop can use it without importing budget directly
export type { BudgetContext };

/**
 * CrawlCollaborators — the complete set of dependencies injected into the loop.
 * The loop orchestrates through these; each collaborator owns its own behavior.
 *
 * #37 ADDITIVE UNFREEZE: new optional fields added at the end. All required fields
 * from #31 are UNCHANGED (backward-compatible).
 */
export interface CrawlCollaborators {
  /** Maps a11y snapshot -> StateIdentity. Injected; #34 swaps in #32's strategy. */
  readonly identifyState: StateIdentityFn;
  /** Enforces per-run caps (steps, LLM calls, tokens, revisits). #33 fills in. */
  readonly budgetEnforcer: BudgetEnforcer;
  /** Tracks visited states and tried actions; handles backtrack. #34 fills in. */
  readonly frontier: Frontier;
  /** Persists the state graph (incremental upserts during the crawl). */
  readonly stateGraphRepository: StateGraphRepository;
  /** Publishes CrawlEvent for this run to downstream consumers (E4/E5). */
  readonly crawlEventStream: CrawlEventStream;

  // ── #37 additive fields (all optional with safe defaults) ─────────────────

  /** Redacts credentials/PII from a11y snapshots and typed text (T3/T7/T8). */
  readonly redactor: CredentialRedactor;
  /** Detects credential/2FA surfaces before decide() (T8). */
  readonly credentialBoundary: CredentialBoundaryDetector;
  /** Detects nodes with in-degree > 1 after crawl (structural duplicate-path). */
  readonly duplicatePathDetector: DuplicatePathDetector;
  /** Enumerates base CandidateActions from the a11y tree before probes. */
  readonly enumerateBaseCandidates: BaseCandidateEnumeratorFn;
  /** Reports LLM usage after each decide() call for budget enforcement (T6). */
  readonly usageReporter: UsageReporter;
  /** Simulator lifecycle for reset-safety-net (T4). Optional: tests may omit. */
  readonly simulatorLifecycle?: SimulatorLifecycle;
  /** Non-production guard config (T4). Optional: tests may omit to skip the guard. */
  readonly runSafety?: CrawlRunSafety;
}

// ── Overridable dependencies for the factory ─────────────────────────────────

/**
 * Options for `defaultCollaborators()`.
 *
 * All fields are optional overrides; the factory fills in stubs for anything
 * not provided. Wave-1 tickets inject their real implementations here without
 * editing the loop or this factory's signature.
 *
 * Required: stateGraphRepository + crawlEventStream (infrastructure that must
 * be resolved at the composition root — not stub-able because the loop NEEDS
 * them to record state and publish events).
 *
 * #37 ADDITIVE: new optional fields for the new collaborators.
 * `defaultCollaborators({ stateGraphRepository, crawlEventStream })` STILL WORKS.
 */
export interface CollaboratorOptions {
  /** Required: the port that persists the graph. */
  readonly stateGraphRepository: StateGraphRepository;
  /** Required: the port that publishes crawl events. */
  readonly crawlEventStream: CrawlEventStream;
  /** Optional: override the identity strategy (default: real strategy). */
  readonly identifyState?: StateIdentityFn;
  /** Optional: override the budget enforcer (default: stub). */
  readonly budgetEnforcer?: BudgetEnforcer;
  /** Optional: override the frontier (default: stub with probes). */
  readonly frontier?: Frontier;
  /** Optional: override the credential redactor (default: CredentialRedactor). */
  readonly redactor?: CredentialRedactor;
  /** Optional: override the 2FA boundary detector (default: CredentialBoundaryDetector). */
  readonly credentialBoundary?: CredentialBoundaryDetector;
  /** Optional: override the duplicate path detector (default: DuplicatePathDetector). */
  readonly duplicatePathDetector?: DuplicatePathDetector;
  /** Optional: override the base candidate enumerator. */
  readonly enumerateBaseCandidates?: BaseCandidateEnumeratorFn;
  /** Optional: override the usage reporter (default: no-op). */
  readonly usageReporter?: UsageReporter;
  /** Optional: simulator lifecycle for reset-safety-net (T4). */
  readonly simulatorLifecycle?: SimulatorLifecycle;
  /** Optional: non-production guard config (T4). */
  readonly runSafety?: CrawlRunSafety;
}

/**
 * defaultCollaborators() — factory that assembles the collaborator set.
 *
 * BACKWARD-COMPATIBLE: `defaultCollaborators({ stateGraphRepository, crawlEventStream })`
 * still compiles and works exactly as before. All new fields are optional.
 *
 * #37 ADDITIVE: adds new collaborators with safe defaults. The factory signature
 * (`options: CollaboratorOptions`) is unchanged; new fields are in `CollaboratorOptions`.
 */
export function defaultCollaborators(options: CollaboratorOptions): CrawlCollaborators {
  // #34: real strategy default. One-line closure adapts StateIdentityStrategy.identify
  // (which takes StateIdentityInput) to StateIdentityFn ((snapshot) => StateIdentity).
  const defaultStrategy = new CompositeStateIdentityStrategy(new A11ySignatureStrategy());
  const defaultIdentifyState: StateIdentityFn = (snapshot) =>
    defaultStrategy.identify({ a11ySnapshot: snapshot, platform: "ios" });

  // #35 (E2.5) body edit: register hidden-affordance probe sources on the default Frontier.
  // When a custom frontier is supplied via options, the caller is responsible for probe registration.
  const defaultFrontier = new Frontier();
  registerHiddenAffordanceProbes(defaultFrontier);

  const base = {
    // ── Required (#31) ───────────────────────────────────────────────────────
    identifyState: options.identifyState ?? defaultIdentifyState,
    budgetEnforcer: options.budgetEnforcer ?? new BudgetEnforcer(),
    frontier: options.frontier ?? defaultFrontier,
    stateGraphRepository: options.stateGraphRepository,
    crawlEventStream: options.crawlEventStream,

    // ── #37 additive (safe defaults — no-op / pure implementations) ─────────
    redactor: options.redactor ?? new CredentialRedactor(),
    credentialBoundary: options.credentialBoundary ?? new CredentialBoundaryDetector(),
    duplicatePathDetector: options.duplicatePathDetector ?? new DuplicatePathDetector(),
    enumerateBaseCandidates: options.enumerateBaseCandidates ?? defaultEnumerateBaseCandidates,
    usageReporter: options.usageReporter ?? new NoOpUsageReporter(),
  };

  // exactOptionalPropertyTypes: spread optional fields only when defined.
  // Extract to avoid adding branches in the parent function's complexity count.
  return applyOptionalFields(base, options.simulatorLifecycle, options.runSafety);
}

/**
 * Merges optional fields into the base collaborators object.
 * Uses conditional spreads to satisfy exactOptionalPropertyTypes (T12).
 * Extracted into its own function to keep defaultCollaborators complexity bounded.
 */
function applyOptionalFields(
  base: Omit<CrawlCollaborators, "simulatorLifecycle" | "runSafety">,
  simulatorLifecycle: SimulatorLifecycle | undefined,
  runSafety: CrawlRunSafety | undefined,
): CrawlCollaborators {
  if (simulatorLifecycle !== undefined && runSafety !== undefined) {
    return { ...base, simulatorLifecycle, runSafety };
  }
  if (simulatorLifecycle !== undefined) {
    return { ...base, simulatorLifecycle };
  }
  if (runSafety !== undefined) {
    return { ...base, runSafety };
  }
  return base;
}
