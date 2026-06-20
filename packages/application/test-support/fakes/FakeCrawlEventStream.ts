/**
 * FakeCrawlEventStream — in-memory fake for CrawlEventStream.
 * Collects published events for assertion in unit tests.
 */
import type { CrawlEventStream, CrawlEvent } from "@flowscout/domain";

export class FakeCrawlEventStream implements CrawlEventStream {
  readonly published: CrawlEvent[] = [];
  private subscribers = new Map<string, Array<(event: CrawlEvent) => void>>();

  async publish(event: CrawlEvent): Promise<void> {
    this.published.push(event);
    const handlers = this.subscribers.get(event.runId) ?? [];
    for (const handler of handlers) {
      handler(event);
    }
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

  /** Test helper: get events for a specific run. */
  eventsFor(runId: string): CrawlEvent[] {
    return this.published.filter((e) => e.runId === runId);
  }
}
