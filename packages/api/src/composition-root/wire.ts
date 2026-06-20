/**
 * Composition root — the ONLY place that names concrete adapters and wires DI.
 * Swapping a driver, store, or policy is a one-line change here.
 *
 * TODO (E1+): Replace stub adapters with real implementations as epics land.
 *             Add environment-config loading (dotenv / config) for DATABASE_URL,
 *             FLOWSCOUT_VAULT_KEY, etc.
 */
import { AppContext } from "@flowscout/application";
import type { AppPorts } from "@flowscout/application";

// Adapters — the only files in this package that import concrete adapter classes
import { MobileMcpDriver } from "@flowscout/adapter-mobile-mcp";
import { LlmAdapter, LlmDecisionPolicy } from "@flowscout/adapter-llm";
import {
  PrismaRunRepository,
  PrismaStateGraphRepository,
  PrismaReportRepository,
} from "@flowscout/adapter-persistence";
import { VaultAdapter } from "@flowscout/adapter-vault";
import { HtmlReportRenderer } from "@flowscout/adapter-report-html";

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
 */
export function buildAppContext(): AppContext {
  const llm = new LlmAdapter();
  const mobileDriver = new MobileMcpDriver();

  const ports: AppPorts = {
    mobileDriver,
    simulatorLifecycle: mobileDriver, // MobileMcpDriver implements both ports
    decisionPolicy: new LlmDecisionPolicy(llm),
    runRepository: new PrismaRunRepository(),
    stateGraphRepository: new PrismaStateGraphRepository(),
    reportRepository: new PrismaReportRepository(),
    credentialVault: new VaultAdapter(),
    reportRenderer: new HtmlReportRenderer(),
    crawlEventStream: new InProcessCrawlEventStream(),
  };

  return new AppContext(ports);
}
