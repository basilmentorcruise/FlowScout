/**
 * FakeCrawlEventStream — in-memory fake for CrawlEventStream.
 * Collects published events for assertion in unit tests.
 */
import type { CrawlEventStream, CrawlEvent } from "@flowscout/domain";
export declare class FakeCrawlEventStream implements CrawlEventStream {
  readonly published: CrawlEvent[];
  private subscribers;
  publish(event: CrawlEvent): Promise<void>;
  subscribe(runId: string, handler: (event: CrawlEvent) => void): () => void;
  /** Test helper: get events for a specific run. */
  eventsFor(runId: string): CrawlEvent[];
}
//# sourceMappingURL=FakeCrawlEventStream.d.ts.map
