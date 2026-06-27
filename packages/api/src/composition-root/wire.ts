/**
 * Composition root — the ONLY place that names concrete adapters and wires DI.
 * Swapping the concrete driver is a single-line change here (ADR-0001 §2.3).
 *
 * #37 (E2.7): Wires the full crawl engine at the composition root:
 *   - CachedKnowledgePolicy is now the chain HEAD (memory-flagged MUST).
 *   - StartCrawlRun is constructed from AppPorts/AppContext.
 *   - usageReporter closure bridges chain.llmPolicy.lastCallResult → engine (port-purity).
 *   - CrawlRunSafety from config (no-production guard, T4).
 *   - Never logs full env/config (T5).
 *
 * Security: the Anthropic API key is loaded only here and passed via the LlmAdapter
 * constructor — never logged, never placed in events, never in the engine (T5/T10).
 */
import {
  AppContext,
  CachedKnowledgePolicy,
  defaultCollaborators,
  StartCrawlRun,
  // E3.6 (#59) — WorkflowMap assembly: use-case + the five merged passes + shared budget meter.
  BuildWorkflowMap,
  RunBudgetMeter,
  WorkflowExtractor,
  InferIntent,
  defaultInferIntentConfig,
  A11yIntentDeriver,
  LlmIntentRefiner,
  IntentBudgetGuard,
  InMemoryIntentCache,
  RefineIdentities,
  defaultRefineIdentitiesConfig,
  SemanticDuplicateDetector,
  defaultDuplicateDetectorConfig,
  EmbeddingBudgetGuard,
  InMemoryEmbeddingCache,
  RuleNameStrategy,
  LlmNamingRefiner,
  AppPurposeInferer,
  NameAndGroupWorkflows,
  InMemoryGroupingCache,
  defaultGroupingConfig,
  CredentialRedactor,
} from "@flowscout/application";
import type { AppPorts } from "@flowscout/application";
import {
  SamenessRefiner,
  defaultSamenessConfig,
  projectA11ySkeleton,
  defaultCrawlBudget,
} from "@flowscout/domain";
import type { CrawlBudget, EmbeddingPort, LlmPort, StateGraphRepository } from "@flowscout/domain";

// Adapters — the only files in this package that import concrete adapter classes.
// *** SWAP POINT ***: change the import + the two MobileMcpDriver lines below to swap the driver.
import { MobileMcpDriver } from "@flowscout/adapter-mobile-mcp";
import {
  LlmAdapter,
  createAnthropicClient,
  assembleLlmPolicyFromPorts,
  createPolicyChain,
  EmbeddingAdapter,
  createEmbeddingClient,
} from "@flowscout/adapter-llm";
import { InMemoryDecisionCache } from "@flowscout/application";
import {
  PrismaRunRepository,
  PrismaStateGraphRepository,
  PrismaReportRepository,
} from "@flowscout/adapter-persistence";
import { VaultAdapter } from "@flowscout/adapter-vault";
import { HtmlReportRenderer } from "@flowscout/adapter-report-html";

// Config loader — the sole env-reading logic for the mobile driver.
import { loadMobileMcpConfig } from "../config/index.js";

// TODO (E1+): Add a real CrawlEventStream adapter (in-process event bus or Redis pub/sub)
import type { CrawlEventStream, CrawlEvent } from "@flowscout/domain";

/** Minimal in-process event stream (no persistence — replaced in E5 with SSE relay). */
class InProcessCrawlEventStream implements CrawlEventStream {
  private subscribers = new Map<string, Array<(event: CrawlEvent) => void>>();

  publish(event: CrawlEvent): Promise<void> {
    const handlers = this.subscribers.get(event.runId) ?? [];
    for (const handler of handlers) {
      handler(event);
    }
    return Promise.resolve();
  }

  subscribe(runId: string, handler: (event: CrawlEvent) => void): () => void {
    const existing = this.subscribers.get(runId) ?? [];
    this.subscribers.set(runId, [...existing, handler]);
    return () => {
      const current = this.subscribers.get(runId) ?? [];
      this.subscribers.set(
        runId,
        current.filter((h) => h !== handler),
      );
    };
  }
}

/**
 * Build and return the wired AppContext.
 * Called once at startup (server entry point).
 *
 * The env config loader is called here so config is resolved at construction time,
 * not lazily — startup failures surface immediately.
 */
export function buildAppContext(): AppContext {
  // Read env-driven config once at root. No parsing logic inline (T5 — never log full config).
  const { driverConfig } = loadMobileMcpConfig();

  // Build LLM chain:
  //   1. LLMPolicy (with InMemoryDecisionCache) as the leaf.
  //   2. CachedKnowledgePolicy wrapping LLMPolicy — THE CHAIN HEAD (#37 MUST).
  //   3. PolicyChain(cachedKnowledge, llmPolicy) — head = CachedKnowledgePolicy.
  const anthropicClient = createAnthropicClient();
  const llm = new LlmAdapter(anthropicClient);
  const cache = new InMemoryDecisionCache();
  const llmPolicy = assembleLlmPolicyFromPorts(llm, cache);

  // #37 MUST: CachedKnowledgePolicy is the chain HEAD (not LLMPolicy as #36 stub had).
  const cachedKnowledge = new CachedKnowledgePolicy(llmPolicy);
  const chain = createPolicyChain(cachedKnowledge, llmPolicy);

  // SWAP POINT: change MobileMcpDriver to an alternate driver implementation here.
  const mobileDriver = new MobileMcpDriver(driverConfig);

  const crawlEventStream = new InProcessCrawlEventStream();
  const stateGraphRepository = new PrismaStateGraphRepository();

  const ports: AppPorts = {
    mobileDriver,
    simulatorLifecycle: mobileDriver, // MobileMcpDriver implements both ports — single instance
    decisionPolicy: chain,
    runRepository: new PrismaRunRepository(),
    stateGraphRepository,
    reportRepository: new PrismaReportRepository(),
    credentialVault: new VaultAdapter(),
    reportRenderer: new HtmlReportRenderer(),
    crawlEventStream,
  };

  // #37: usageReporter closure over chain.llmPolicy.lastCallResult.
  // This bridges token usage from the chain to the engine WITHOUT importing PolicyChain
  // in the application layer (preserves port-purity / T10).
  const usageReporter = {
    lastCall: () => {
      const result = chain.llmPolicy.lastCallResult;
      if (result === null) return null;
      return {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      };
    },
  };

  // #37: CrawlRunSafety — non-production guard (T4). Loaded from env/config.
  // This is the documented, config-driven control against accidental production targeting.
  const nonProductionFlag = process.env["FLOWSCOUT_NON_PRODUCTION"] === "true";
  const runSafety = {
    target: "simulator", // UDID resolved at runtime from device discovery
    nonProduction: nonProductionFlag,
  };

  // Build the StartCrawlRun use-case from ports (composition root only).
  const collaborators = defaultCollaborators({
    stateGraphRepository,
    crawlEventStream,
    usageReporter,
    simulatorLifecycle: mobileDriver,
    runSafety,
  });

  const startCrawlRun = new StartCrawlRun(mobileDriver, chain, collaborators);

  // #59 (E3.6): assemble BuildWorkflowMap from resolved ports + composition-root adapters.
  // The EmbeddingAdapter + the raw LlmAdapter are the ONLY concrete adapters used; the use-case
  // itself imports no adapter (port purity / NFR1 — boundaries gate enforces).
  const buildWorkflowMap = wireWorkflowMapUseCase(stateGraphRepository, llm);

  const appContext = new AppContext(ports);
  // Expose startCrawlRun via the context (AppContext.startCrawlRun)
  (appContext as AppContextWithCrawl).startCrawlRun = startCrawlRun;
  // Expose buildWorkflowMap via the context (mirrors the …WithCrawl pattern).
  (appContext as AppContextWithWorkflowMap).buildWorkflowMap = buildWorkflowMap;

  return appContext;
}

/**
 * Construct the run's `EmbeddingPort` (Voyage adapter, model id config-pinned via `EMBEDDING_MODEL`)
 * and assemble `BuildWorkflowMap` from it + the injected `LlmPort` + the resolved graph repository.
 * Isolated from `buildAppContext` so the embedding-adapter construction stays a single seam.
 */
function wireWorkflowMapUseCase(
  stateGraphRepository: StateGraphRepository,
  llm: LlmPort,
): BuildWorkflowMap {
  const embeddingModelId = process.env["EMBEDDING_MODEL"];
  const embeddings: EmbeddingPort = new EmbeddingAdapter(
    createEmbeddingClient(),
    embeddingModelId !== undefined ? { modelId: embeddingModelId } : {},
  );
  return wireBuildWorkflowMap({
    stateGraphRepository,
    llm,
    embeddings,
    crawlBudget: defaultCrawlBudget(),
  });
}

/**
 * Resolved-port dependencies for `BuildWorkflowMap` — ALL port-typed (`StateGraphRepository`,
 * `LlmPort`, `EmbeddingPort`, `CrawlBudget`). The concrete adapters are constructed by the caller
 * (`buildAppContext`) and injected here, so this factory — and the use-case it builds — names no
 * adapter (NFR1). Exported so the wiring/port-purity test can drive it with fakes.
 */
export interface BuildWorkflowMapDeps {
  readonly stateGraphRepository: StateGraphRepository;
  readonly llm: LlmPort;
  readonly embeddings: EmbeddingPort;
  readonly crawlBudget: CrawlBudget;
}

/**
 * Assemble `BuildWorkflowMap` (#59) from resolved ports. Threads ONE shared `RunBudgetMeter` into
 * the intent/naming/purpose `IntentBudgetGuard` and the embedding `EmbeddingBudgetGuard` so the
 * combined LLM + embedding spend is bounded by a single ceiling (§4). The detector runs BEFORE the
 * naming/grouping pass (so the final workflow objects already carry `isHiddenPath`).
 */
export function wireBuildWorkflowMap(deps: BuildWorkflowMapDeps): BuildWorkflowMap {
  const { stateGraphRepository, llm, embeddings, crawlBudget } = deps;
  const redactor = new CredentialRedactor();

  // ONE shared counter → one global LLM+embedding ceiling for the run (§4).
  const meter = new RunBudgetMeter(crawlBudget);
  const intentGuard = new IntentBudgetGuard(meter);
  const embeddingGuard = new EmbeddingBudgetGuard(meter);

  const extractor = new WorkflowExtractor(); // #54

  const inferIntent = new InferIntent(
    redactor,
    new A11yIntentDeriver(),
    new LlmIntentRefiner(llm, intentGuard, new InMemoryIntentCache()),
    defaultInferIntentConfig(),
  ); // #55

  const refineIdentities = new RefineIdentities(
    embeddings,
    new InMemoryEmbeddingCache(),
    redactor,
    embeddingGuard,
    new SamenessRefiner(defaultSamenessConfig()),
    projectA11ySkeleton,
    defaultRefineIdentitiesConfig(),
  ); // #58 (refine)
  const duplicateDetector = new SemanticDuplicateDetector(defaultDuplicateDetectorConfig()); // #58 (detect)

  const groupingConfig = defaultGroupingConfig();
  const groupingCache = new InMemoryGroupingCache(); // shared by the naming refiner + purpose inferer
  const nameAndGroup = new NameAndGroupWorkflows(
    redactor,
    new RuleNameStrategy(),
    new LlmNamingRefiner(llm, intentGuard, groupingCache, redactor),
    new AppPurposeInferer(llm, intentGuard, groupingCache, redactor, groupingConfig),
    groupingConfig,
  ); // #56

  return new BuildWorkflowMap(
    stateGraphRepository,
    extractor,
    inferIntent,
    refineIdentities,
    duplicateDetector,
    nameAndGroup,
    meter,
  );
}

/** Extended AppContext that exposes the wired StartCrawlRun use-case. */
export interface AppContextWithCrawl extends AppContext {
  startCrawlRun: StartCrawlRun;
}

/** Extended AppContext that exposes the wired BuildWorkflowMap use-case (#59). */
export interface AppContextWithWorkflowMap extends AppContext {
  buildWorkflowMap: BuildWorkflowMap;
}
