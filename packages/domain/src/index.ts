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

export { A11ySignatureStrategy } from "./models/state-identity/A11ySignatureStrategy.js";
export { CompositeStateIdentityStrategy } from "./models/state-identity/CompositeStateIdentityStrategy.js";

// DecisionCachePort — additive domain port for the LLM decision cache (#36)
export type { DecisionCachePort } from "./ports/DecisionCachePort.js";
