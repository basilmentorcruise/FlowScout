/**
 * collaborators.ts — FROZEN SEAM (owned by #31, not edited by Wave-1 tickets).
 *
 * Defines the collaborator interfaces consumed by the crawl loop and the
 * `defaultCollaborators()` factory that wires them up.
 *
 * Wave-1 replacement contract:
 *   - #33 (E2.3 budgets): replaces BudgetEnforcer body in budget/BudgetEnforcer.ts
 *   - #34 (E2.4 frontier): replaces Frontier body in frontier/Frontier.ts and
 *       injects #32's StateIdentityStrategy via the `identifyState` param
 *   - #35 (E2.5 probes): extends Frontier via #34's published extension point
 *   - #36 (E2.6 policy chain): supplies a real DecisionPolicy at the composition root
 *   - #37 (E2.7 integration): wires everything at packages/api composition root
 *
 * INVARIANT: Wave-1 tickets replace a collaborator's *body* or *inject* a new
 * default, but NEVER alter the interface shapes below or the `CrawlCollaborators`
 * type. Any such change requires a new ADR.
 *
 * Dependency: only @flowscout/domain and sibling crawl/* modules. No adapters.
 */
import type {
  StateIdentity,
  A11ySnapshot,
  StateGraphRepository,
  CrawlEventStream,
} from "@flowscout/domain";
import { A11ySignatureStrategy, CompositeStateIdentityStrategy } from "@flowscout/domain";
import { BudgetEnforcer } from "./budget/BudgetEnforcer.js";
import type { BudgetContext } from "./budget/BudgetEnforcer.js";
import { Frontier } from "./frontier/Frontier.js";

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
 * FROZEN: shape is set by #31. Wave-1 provides new implementations; the shape
 * (field names + types) does not change without a new ADR.
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
 */
export interface CollaboratorOptions {
  /** Required: the port that persists the graph. */
  readonly stateGraphRepository: StateGraphRepository;
  /** Required: the port that publishes crawl events. */
  readonly crawlEventStream: CrawlEventStream;
  /** Optional: override the identity strategy (default: placeholder). */
  readonly identifyState?: StateIdentityFn;
  /** Optional: override the budget enforcer (default: stub). */
  readonly budgetEnforcer?: BudgetEnforcer;
  /** Optional: override the frontier (default: stub). */
  readonly frontier?: Frontier;
}

/**
 * defaultCollaborators() — factory that assembles the collaborator set.
 *
 * FROZEN FACTORY SIGNATURE: Wave-1 tickets that add new collaborators extend
 * `CollaboratorOptions` with an optional field and update this factory body.
 * The `CrawlCollaborators` shape and this function's parameter type are the
 * seam contract; they do not change without a new ADR.
 *
 * #34 (E2.4) body edit: swaps the default identifyState from placeholderIdentify
 * to the real A11ySignatureStrategy wrapped in CompositeStateIdentityStrategy.
 * The StateIdentityFn seam is (snapshot) => StateIdentity; the strategy takes a
 * richer StateIdentityInput, so we adapt with a closure supplying the MVP-default
 * platform constant "ios" (FlowScout MVP is iOS-first; #37 can pass a real platform
 * via options.identifyState if multi-platform support lands).
 */
export function defaultCollaborators(options: CollaboratorOptions): CrawlCollaborators {
  // #34: real strategy default. One-line closure adapts StateIdentityStrategy.identify
  // (which takes StateIdentityInput) to StateIdentityFn ((snapshot) => StateIdentity).
  const defaultStrategy = new CompositeStateIdentityStrategy(new A11ySignatureStrategy());
  const defaultIdentifyState: StateIdentityFn = (snapshot) =>
    defaultStrategy.identify({ a11ySnapshot: snapshot, platform: "ios" });

  return {
    identifyState: options.identifyState ?? defaultIdentifyState,
    budgetEnforcer: options.budgetEnforcer ?? new BudgetEnforcer(),
    frontier: options.frontier ?? new Frontier(),
    stateGraphRepository: options.stateGraphRepository,
    crawlEventStream: options.crawlEventStream,
  };
}
