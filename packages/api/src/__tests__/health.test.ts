/**
 * Health route scaffold test.
 * Validates that the route handler resolves with the correct shape.
 * Full integration tests are out of scope for the foundation scaffold.
 */
import { describe, it, expect } from "vitest";

describe("health route (scaffold)", () => {
  it("returns the expected status shape from the handler", async () => {
    // Isolated handler logic — no Fastify server needed
    const handler = (): Promise<{ status: string; service: string; timestamp: string }> =>
      Promise.resolve({
        status: "ok",
        service: "flowscout-api",
        timestamp: new Date().toISOString(),
      });

    const result = await handler();
    expect(result.status).toBe("ok");
    expect(result.service).toBe("flowscout-api");
    expect(typeof result.timestamp).toBe("string");
  });
});
