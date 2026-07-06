/**
 * @flowscout/domain — public API barrel.
 * Pure domain: models, value objects, and port interfaces. No I/O.
 */

// Models
export type {
  StateIdentity,
  Platform,
  StateNode,
  StateEdge,
  ActionType,
  StateGraph,
} from "./models/state-graph.js";
export { makeStateIdentity } from "./models/state-graph.js";

export type { WorkflowStep, ConfidenceScore, Workflow, WorkflowMap } from "./models/workflow.js";
export { makeConfidenceScore } from "./models/workflow.js";

// Intent overlay model (E3.2 / #55 — additive semantic overlay, ADR-0006 §2)
export type { IntentSource, ControlIntent, ScreenIntent, IntentModel } from "./models/intent.js";

export type { RunStatus, ReportMetadata, Report } from "./models/report.js";

export type { CrawlBudget, Run } from "./models/run.js";
export { defaultCrawlBudget } from "./models/run.js";

// Ports
export type {
  DeviceInfo,
  TapTarget,
  SwipeDirection,
  A11ySnapshot,
  ScreenshotBytes,
  MobileDriverPort,
  SimulatorLifecycle,
} from "./ports/MobileDriverPort.js";

export type {
  CandidateAction,
  DecisionContext,
  PolicyDecision,
  DecisionPolicy,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
  LlmPort,
} from "./ports/DecisionPolicyPort.js";

export type {
  RunRepository,
  StateGraphRepository,
  ReportRepository,
  ListRunsOptions,
  RunPage,
} from "./ports/RepositoryPorts.js";

export type {
  AppCredential,
  PlaintextCredential,
  CredentialVaultPort,
} from "./ports/CredentialVaultPort.js";

export type {
  RenderOptions,
  RenderResult,
  ReportRendererPort,
} from "./ports/ReportRendererPort.js";

export type {
  CrawlEvent,
  CrawlStartedEvent,
  StateDiscoveredEvent,
  ActionTakenEvent,
  StateTransitionEvent,
  CredentialPromptEvent,
  BudgetWarningEvent,
  CrawlFinishedEvent,
  CrawlErrorEvent,
  CrawlEventStream,
} from "./ports/CrawlEventStream.js";

// StateIdentity strategy — port + default implementation
export type { StateIdentityInput, StateIdentityStrategy } from "./ports/StateIdentityPort.js";

export {
  A11ySignatureStrategy,
  projectA11ySkeleton,
} from "./models/state-identity/A11ySignatureStrategy.js";
export { CompositeStateIdentityStrategy } from "./models/state-identity/CompositeStateIdentityStrategy.js";
export type { CanonicalIdentityMap } from "./models/state-identity/CompositeStateIdentityStrategy.js";

// DecisionCachePort — additive domain port for the LLM decision cache (#36)
export type { DecisionCachePort } from "./ports/DecisionCachePort.js";

// IntentCachePort — additive domain port for the intent cache (#55, ADR-0006 §3.4)
export type { IntentCachePort } from "./ports/IntentCachePort.js";

// EmbeddingPort — additive async domain port for screen embeddings (#57, ADR-0005 §4.2)
export type { EmbeddingInput, EmbeddingResult, EmbeddingPort } from "./ports/EmbeddingPort.js";

// E3.4 sameness refinement — config, cosine, refiner (#57, ADR-0005 §2/§3/§7)
export type { SamenessConfig } from "./models/state-identity/SamenessConfig.js";
export {
  defaultSamenessConfig,
  DEFAULT_MERGE_THRESHOLD,
  DEFAULT_MERGE_MARGIN,
  DEFAULT_MIN_EMBEDDING_DIM,
} from "./models/state-identity/SamenessConfig.js";
export { cosineSimilarity, isUsableEmbedding } from "./models/state-identity/cosine.js";
export { SamenessRefiner } from "./models/state-identity/SamenessRefiner.js";
export type {
  BucketInput,
  RefinementResult,
  DeadBandNote,
} from "./models/state-identity/SamenessRefiner.js";

// GroupingCachePort — additive domain port for the naming/grouping cache (#56, ADR-0007 §3.4)
export type { GroupingCachePort, WorkflowLabeling } from "./ports/GroupingCachePort.js";

// EmbeddingCachePort — additive domain port for the one-vector-per-bucket cache (#58, ADR-0005 §4.4)
export type { EmbeddingCachePort } from "./ports/EmbeddingCachePort.js";

// DuplicatePathGroup — additive model: the semantic-duplicate / hidden-path association (#58)
export type { DuplicatePathGroup } from "./models/duplicate-path.js";
