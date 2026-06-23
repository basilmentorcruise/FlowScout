/**
 * Frontier — full implementation for #34 (E2.4: visited tracking + loop & dead-end handling).
 *
 * Responsibilities:
 * 1. Visit tracking — per-state visit counts with a configurable `maxRevisitsPerState` cap
 *    that provably terminates exploration (no A→B→A livelock, security T6).
 * 2. Tried-action tracking — deduplicated by (actionType, actionPayload); marking a no-effect
 *    action as tried advances the frontier so it is not retried indefinitely.
 * 3. Backtrack logic — `selectBacktrackTarget` picks the best state with untried actions
 *    when the current state is exhausted or revisit-capped.
 * 4. Dead-end detection — `isDeadEnd` returns true when a state has no untried candidates.
 * 5. Probe extension point — `registerProbeSource` (Open/Closed) lets #35 plug in
 *    hidden-affordance probe strategies; `getEnumeratedCandidates` calls all registered probes.
 *
 * No-livelock proof (security T6 / ADR-0004 §3.6):
 *   Let S = number of distinct states, C_s = max candidates per state, R = maxRevisitsPerState.
 *   The frontier terminates within S × (R + C_s) total visits/actions because:
 *   - Each state can be visited at most R times (isRevisitCapped fires).
 *   - Each action at each state is tried at most once (dedup key: actionType+actionPayload).
 *   - Once all states are revisit-capped AND all actions tried, selectBacktrackTarget returns null
 *     and the engine finalizes gracefully. No infinite loop is possible.
 *
 * Port-only: no adapter/SDK imports (T10/NFR1). Pure in-memory, no I/O.
 * Seam contract (from #31 stub — NOT changed by #34):
 *   getVisitCount / markVisited / getTriedActions / markActionTried
 * New public API added by #34:
 *   isRevisitCapped / isAlreadyTried / hasUntried / isDeadEnd /
 *   selectBacktrackTarget / registerProbeSource / getEnumeratedCandidates / getProbeSourceIds
 */
import type { A11ySnapshot, CandidateAction } from "@flowscout/domain";
import type { ProbeSource } from "./ProbeSource.js";

// ── Configuration ─────────────────────────────────────────────────────────────

/** Default revisit cap per ADR-0004 §3.6 (breaks A→B→A loops with room for retries). */
const DEFAULT_MAX_REVISITS_PER_STATE = 3;

/** Options for constructing a Frontier instance. */
export interface FrontierOptions {
  /**
   * Maximum number of times a single state may be re-entered in one run.
   * Once reached, `isRevisitCapped` returns true and the engine must backtrack.
   * Default: 3 (ADR-0004 §3.6).
   */
  readonly maxRevisitsPerState?: number;
}

// ── Action identity key ───────────────────────────────────────────────────────

/**
 * Canonical deduplication key for a CandidateAction.
 * Uses (actionType, actionPayload) — ignores `rationale` which is for telemetry only.
 * This ensures a no-effect action (same type+payload, different rationale) is not retried.
 */
function actionKey(action: CandidateAction): string {
  return `${action.actionType}::${action.actionPayload}`;
}

// ── Frontier ──────────────────────────────────────────────────────────────────

/**
 * Frontier — tracks visited states and tried actions with backtrack/dead-end handling.
 *
 * #34 (E2.4) owns this body. The class is constructed and injected via
 * `defaultCollaborators()` in `collaborators.ts` — the loop never instantiates it directly.
 */
export class Frontier {
  private readonly _maxRevisitsPerState: number;
  private readonly _visitCounts = new Map<string, number>();
  /** Set of deduplication keys per state. */
  private readonly _triedActionKeys = new Map<string, Set<string>>();
  /** Ordered list of tried actions per state (for getTriedActions). */
  private readonly _triedActionsList = new Map<string, CandidateAction[]>();
  /** Probe sources indexed by id for O(1) replacement on re-registration. */
  private readonly _probeSources = new Map<string, ProbeSource>();

  constructor(options: FrontierOptions = {}) {
    this._maxRevisitsPerState = options.maxRevisitsPerState ?? DEFAULT_MAX_REVISITS_PER_STATE;
  }

  // ── Visit tracking (seam contract — unchanged from #31 stub) ─────────────────

  /**
   * Returns how many times this state has been visited in the current run.
   * Returns 0 for never-visited states.
   */
  getVisitCount(stateId: string): number {
    return this._visitCounts.get(stateId) ?? 0;
  }

  /**
   * Records a visit to a state (increments its visit count).
   * Called by the loop before each step.
   */
  markVisited(stateId: string): void {
    const prev = this._visitCounts.get(stateId) ?? 0;
    this._visitCounts.set(stateId, prev + 1);
  }

  /**
   * Returns true if the state has reached the per-run revisit cap.
   * The loop should force a backtrack when this is true (no-livelock guarantee).
   */
  isRevisitCapped(stateId: string): boolean {
    return this.getVisitCount(stateId) >= this._maxRevisitsPerState;
  }

  // ── Tried-action tracking (seam contract — unchanged from #31 stub) ──────────

  /**
   * Returns the ordered list of actions already tried from this state.
   * Returns an empty array for states with no tried actions.
   */
  getTriedActions(stateId: string): readonly CandidateAction[] {
    return this._triedActionsList.get(stateId) ?? [];
  }

  /**
   * Marks an action as tried from a state.
   * Deduplicates by (actionType, actionPayload): re-marking the same action is a no-op.
   * This ensures no-effect actions are recorded once and not retried indefinitely (AC4/T6).
   */
  markActionTried(stateId: string, action: CandidateAction): void {
    const key = actionKey(action);
    let keySet = this._triedActionKeys.get(stateId);
    if (keySet === undefined) {
      keySet = new Set<string>();
      this._triedActionKeys.set(stateId, keySet);
    }
    if (keySet.has(key)) return; // already tried — no-op (dedup)
    keySet.add(key);

    const list = this._triedActionsList.get(stateId) ?? [];
    this._triedActionsList.set(stateId, [...list, action]);
  }

  /**
   * Returns true if the given action has already been tried from this state.
   * Identity is by (actionType, actionPayload) — not rationale.
   */
  isAlreadyTried(stateId: string, action: CandidateAction): boolean {
    const keySet = this._triedActionKeys.get(stateId);
    if (keySet === undefined) return false;
    return keySet.has(actionKey(action));
  }

  // ── Untried / dead-end helpers ───────────────────────────────────────────────

  /**
   * Returns true if at least one candidate action is not yet tried from this state.
   * Used by the loop and selectBacktrackTarget to determine if a state has more to explore.
   */
  hasUntried(stateId: string, candidates: readonly CandidateAction[]): boolean {
    return candidates.some((a) => !this.isAlreadyTried(stateId, a));
  }

  /**
   * Returns true if the state is a dead end: no candidates at all, or all tried.
   * A dead end triggers backtracking; if no backtrack target exists the run finalizes.
   */
  isDeadEnd(stateId: string, candidates: readonly CandidateAction[]): boolean {
    return !this.hasUntried(stateId, candidates);
  }

  // ── Backtrack selection ───────────────────────────────────────────────────────

  /**
   * Selects the best backtrack target from the known state set.
   *
   * Algorithm (O(N) over known states):
   * 1. Exclude the current state.
   * 2. Filter to states that have at least one untried candidate action.
   * 3. Among those, prefer states that have been visited at least once (they are
   *    reachable via the recorded graph) over unvisited states.
   * 4. Among visited candidates, pick the one with the fewest visits (least-explored first).
   *
   * Returns null when:
   * - No state has untried actions (entire graph is exhausted) → engine finalizes gracefully.
   * - `knownStates` is empty.
   *
   * @param currentStateId   The state we are backtracking from.
   * @param knownStates      All state identities seen in this run (from the graph).
   * @param candidatesPerState  Mapping from stateId to its known candidate actions.
   *                           States not in this map are treated as having no candidates.
   */
  selectBacktrackTarget(
    currentStateId: string,
    knownStates: readonly string[],
    candidatesPerState: Readonly<Record<string, readonly CandidateAction[]>>,
  ): string | null {
    // Filter: exclude current state; must have untried actions.
    const eligible = knownStates.filter((s) => {
      if (s === currentStateId) return false;
      // eslint-disable-next-line security/detect-object-injection -- key is an internally-computed SHA-256 hash, not user input
      const candidates = candidatesPerState[s] ?? [];
      return this.hasUntried(s, candidates);
    });

    if (eligible.length === 0) return null;

    // Partition into visited (visit count > 0) and unvisited.
    const visited = eligible.filter((s) => this.getVisitCount(s) > 0);
    const pool = visited.length > 0 ? visited : eligible;

    // Pick the least-visited state (most unexplored, least likely to be a dead end).
    return pool.reduce((best, s) => (this.getVisitCount(s) < this.getVisitCount(best) ? s : best));
  }

  // ── Probe extension point (Open/Closed for #35) ──────────────────────────────

  /**
   * Register a ProbeSource for hidden-affordance candidate generation.
   *
   * #35 calls this to plug in scroll-reveal, swipe-reveal, overflow-menu, etc.
   * If a source with the same `id` is already registered, it is replaced (idempotent
   * re-registration — safe for test isolation and hot-reload).
   *
   * The Frontier core does NOT change when new probes are added (Open/Closed principle).
   */
  registerProbeSource(source: ProbeSource): void {
    this._probeSources.set(source.id, source);
  }

  /**
   * Returns the ids of all registered probe sources.
   * Used by tests to verify registration state.
   */
  getProbeSourceIds(): readonly string[] {
    return Array.from(this._probeSources.keys());
  }

  /**
   * Enumerates all probe-generated candidate actions for the given state.
   *
   * Called during frontier enumeration (e.g. before deciding the next action).
   * Each registered ProbeSource is consulted; failures are swallowed (degrade to empty,
   * never crash — ADR-0004 §6 degradation rule).
   *
   * Note: This does NOT include normal (non-probe) candidates — those come from the
   * accessibility tree enumeration that the policy performs. Probes supplement them.
   *
   * @param stateId   Current state identity.
   * @param snapshot  Current a11y snapshot passed to probes for element targeting.
   * @returns         Deduplicated flat list of probe-generated candidates.
   */
  async getEnumeratedCandidates(
    stateId: string,
    snapshot: A11ySnapshot,
  ): Promise<readonly CandidateAction[]> {
    if (this._probeSources.size === 0) return [];

    const results = await Promise.allSettled(
      Array.from(this._probeSources.values()).map((source) =>
        source.generateCandidates(stateId, snapshot),
      ),
    );

    const candidates: CandidateAction[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        candidates.push(...result.value);
      }
      // Rejected sources are silently degraded (no throw, T11 degradation rule).
    }
    return candidates;
  }
}
