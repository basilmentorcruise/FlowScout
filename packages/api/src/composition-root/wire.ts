/**
 * Composition root — the ONLY place that names concrete adapters and wires DI.
 * Swapping the concrete driver is a single-line change here (ADR-0001 §2.3).
 *
 * E1.7 (#18): loadMobileMcpConfig() replaces the hardcoded defaultMcpConfig block.
 * No business logic in this file — parsing lives in packages/api/src/config/.
 */
import { AppContext } from "@flowscout/application";
import type { AppPorts } from "@flowscout/application";

// Adapters — the only files in this package that import concrete adapter classes.
// *** SWAP POINT ***: change the import + the two MobileMcpDriver lines below to swap the driver.
import { MobileMcpDriver } from "@flowscout/adapter-mobile-mcp";
import { LlmAdapter, LlmDecisionPolicy } from "@flowscout/adapter-llm";
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

  const llm = new LlmAdapter();
  // SWAP POINT: change MobileMcpDriver to an alternate driver implementation here.
  const mobileDriver = new MobileMcpDriver(driverConfig);

  const ports: AppPorts = {
    mobileDriver,
    simulatorLifecycle: mobileDriver, // MobileMcpDriver implements both ports — single instance
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
