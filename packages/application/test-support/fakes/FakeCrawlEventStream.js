export class FakeCrawlEventStream {
  published = [];
  subscribers = new Map();
  async publish(event) {
    this.published.push(event);
    const handlers = this.subscribers.get(event.runId) ?? [];
    for (const handler of handlers) {
      handler(event);
    }
  }
  subscribe(runId, handler) {
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
  eventsFor(runId) {
    return this.published.filter((e) => e.runId === runId);
  }
}
//# sourceMappingURL=FakeCrawlEventStream.js.map
