/**
 * ApiClient scaffold test.
 * Validates the ApiClient class structure without making real HTTP calls.
 */
import { describe, it, expect } from "vitest";
import { ApiClient } from "../model/ApiClient.js";

describe("ApiClient (scaffold)", () => {
  it("constructs with default baseUrl", () => {
    const client = new ApiClient();
    expect(client).toBeInstanceOf(ApiClient);
  });

  it("constructs with a custom baseUrl", () => {
    const client = new ApiClient("http://localhost:3000");
    expect(client).toBeInstanceOf(ApiClient);
  });

  it("getHealth rejects when fetch fails (no real server)", async () => {
    const client = new ApiClient("http://127.0.0.1:0");
    // With no server running, fetch will reject or the response will not be ok
    await expect(client.getHealth()).rejects.toThrow();
  });
});
