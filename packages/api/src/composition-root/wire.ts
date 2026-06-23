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
} from "@flowscout/application";
import type { AppPorts } from "@flowscout/application";

// Adapters — the only files in this package that import concrete adapter classes.
// *** SWAP POINT ***: change the import + the two MobileMcpDriver lines below to swap the driver.
import { MobileMcpDriver } from "@flowscout/adapter-mobile-mcp";
import {
  LlmAdapter,
  createAnthropicClient,
  assembleLlmPolicyFromPorts,
  createPolicyChain,
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

  const appContext = new AppContext(ports);
  // Expose startCrawlRun via the context (AppContext.startCrawlRun)
  (appContext as AppContextWithCrawl).startCrawlRun = startCrawlRun;

  return appContext;
}

/** Extended AppContext that exposes the wired StartCrawlRun use-case. */
export interface AppContextWithCrawl extends AppContext {
  startCrawlRun: StartCrawlRun;
}
