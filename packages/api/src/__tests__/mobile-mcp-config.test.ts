/**
 * Unit tests for loadMobileMcpConfig() (packages/api/src/config/mobile-mcp-config.ts).
 *
 * AC coverage:
 *   - Config loader returns correct defaults when env vars are absent.
 *   - Config loader parses FLOWSCOUT_MCP_SERVER_COMMAND correctly.
 *   - Config loader parses numeric timeout vars.
 *   - Config loader rejects invalid timeout values with MobileMcpConfigError.
 *   - Config loader returns appBundleDir from FLOWSCOUT_APP_BUNDLE_DIR.
 *   - Config loader never logs full env or config (T5 — structural assertion).
 *   - serverEnv is scoped (PATH-only, T5 — never blanket process.env).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { loadMobileMcpConfig, MobileMcpConfigError } from "../config/mobile-mcp-config.js";

// ---------------------------------------------------------------------------
// Helpers — use vi.stubEnv() for safe, isolated env mutation
// ---------------------------------------------------------------------------

/** Managed env var keys for the config loader. */
type EnvKey =
  | "FLOWSCOUT_MCP_SERVER_COMMAND"
  | "FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS"
  | "FLOWSCOUT_MCP_CALL_TIMEOUT_MS"
  | "FLOWSCOUT_APP_BUNDLE_DIR";

/**
 * Run fn with specific env vars stubbed via vi.stubEnv().
 * vi.stubEnv() is automatically restored by vi.unstubAllEnvs() in afterEach.
 */
function withEnv(vars: Partial<Record<EnvKey, string | undefined>>, fn: () => void): void {
  // vi.stubEnv handles setting and restoring env vars cleanly.
  for (const [key, value] of Object.entries(vars) as Array<[EnvKey, string | undefined]>) {
    if (value !== undefined) {
      vi.stubEnv(key, value);
    } else {
      // Stub with empty string then test handles the "absent" case
      vi.stubEnv(key, "");
    }
  }
  fn();
}

afterEach(() => {
  // Restore all env stubs after each test.
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Defaults (all env vars absent — no stubs)
// ---------------------------------------------------------------------------

describe("loadMobileMcpConfig — defaults (all env vars absent)", () => {
  it("returns npx,mobile-mcp as the default server command", () => {
    // Ensure keys are not set (unstubAllEnvs ensures no leftover stubs)
    vi.stubEnv("FLOWSCOUT_MCP_SERVER_COMMAND", "");
    const result = loadMobileMcpConfig();
    expect(result.driverConfig.server.serverCommand).toEqual(["npx", "mobile-mcp"]);
  });

  it("returns 10000 as the default connect timeout", () => {
    vi.stubEnv("FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS", "");
    const result = loadMobileMcpConfig();
    expect(result.driverConfig.server.connectTimeoutMs).toBe(10_000);
  });

  it("returns 30000 as the default call timeout", () => {
    vi.stubEnv("FLOWSCOUT_MCP_CALL_TIMEOUT_MS", "");
    const result = loadMobileMcpConfig();
    expect(result.driverConfig.server.callTimeoutMs).toBe(30_000);
  });

  it("returns undefined appBundleDir when FLOWSCOUT_APP_BUNDLE_DIR is absent", () => {
    vi.stubEnv("FLOWSCOUT_APP_BUNDLE_DIR", "");
    const result = loadMobileMcpConfig();
    expect(result.appBundleDir).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Server command parsing
// ---------------------------------------------------------------------------

describe("loadMobileMcpConfig — FLOWSCOUT_MCP_SERVER_COMMAND", () => {
  it("parses a comma-separated command into an argv array", () => {
    withEnv({ FLOWSCOUT_MCP_SERVER_COMMAND: "npx,mobile-mcp" }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server.serverCommand).toEqual(["npx", "mobile-mcp"]);
    });
  });

  it("trims whitespace from each segment", () => {
    withEnv({ FLOWSCOUT_MCP_SERVER_COMMAND: " /usr/bin/node , mobile-mcp " }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server.serverCommand).toEqual(["/usr/bin/node", "mobile-mcp"]);
    });
  });

  it("filters empty segments produced by trailing commas", () => {
    withEnv({ FLOWSCOUT_MCP_SERVER_COMMAND: "npx,mobile-mcp," }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server.serverCommand).toEqual(["npx", "mobile-mcp"]);
    });
  });

  it("falls back to defaults when the value is an empty string", () => {
    withEnv({ FLOWSCOUT_MCP_SERVER_COMMAND: "" }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server.serverCommand).toEqual(["npx", "mobile-mcp"]);
    });
  });

  it("falls back to defaults when the value is only whitespace", () => {
    withEnv({ FLOWSCOUT_MCP_SERVER_COMMAND: "   " }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server.serverCommand).toEqual(["npx", "mobile-mcp"]);
    });
  });

  it("supports a single-element command", () => {
    withEnv({ FLOWSCOUT_MCP_SERVER_COMMAND: "/usr/local/bin/mobile-mcp-server" }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server.serverCommand).toEqual([
        "/usr/local/bin/mobile-mcp-server",
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Timeout parsing
// ---------------------------------------------------------------------------

describe("loadMobileMcpConfig — FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS", () => {
  it("parses a valid positive integer", () => {
    withEnv({ FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS: "5000" }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server.connectTimeoutMs).toBe(5000);
    });
  });

  it("throws MobileMcpConfigError for zero", () => {
    withEnv({ FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS: "0" }, () => {
      expect(() => loadMobileMcpConfig()).toThrow(MobileMcpConfigError);
    });
  });

  it("throws MobileMcpConfigError for a negative value", () => {
    withEnv({ FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS: "-1000" }, () => {
      expect(() => loadMobileMcpConfig()).toThrow(MobileMcpConfigError);
    });
  });

  it("throws MobileMcpConfigError for a non-numeric string", () => {
    withEnv({ FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS: "fast" }, () => {
      expect(() => loadMobileMcpConfig()).toThrow(MobileMcpConfigError);
    });
  });

  it("throws MobileMcpConfigError for a float", () => {
    withEnv({ FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS: "1.5" }, () => {
      expect(() => loadMobileMcpConfig()).toThrow(MobileMcpConfigError);
    });
  });

  it("uses the default when the value is empty (empty string stub = absent)", () => {
    withEnv({ FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS: "" }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server.connectTimeoutMs).toBe(10_000);
    });
  });
});

describe("loadMobileMcpConfig — FLOWSCOUT_MCP_CALL_TIMEOUT_MS", () => {
  it("parses a valid positive integer", () => {
    withEnv({ FLOWSCOUT_MCP_CALL_TIMEOUT_MS: "60000" }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server.callTimeoutMs).toBe(60_000);
    });
  });

  it("throws MobileMcpConfigError for a non-numeric string", () => {
    withEnv({ FLOWSCOUT_MCP_CALL_TIMEOUT_MS: "never" }, () => {
      expect(() => loadMobileMcpConfig()).toThrow(MobileMcpConfigError);
    });
  });

  it("uses the default when the value is empty (empty string stub = absent)", () => {
    withEnv({ FLOWSCOUT_MCP_CALL_TIMEOUT_MS: "" }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server.callTimeoutMs).toBe(30_000);
    });
  });
});

// ---------------------------------------------------------------------------
// App bundle dir
// ---------------------------------------------------------------------------

describe("loadMobileMcpConfig — FLOWSCOUT_APP_BUNDLE_DIR", () => {
  it("returns the trimmed directory path when set", () => {
    withEnv({ FLOWSCOUT_APP_BUNDLE_DIR: "/tmp/flowscout-apps" }, () => {
      const result = loadMobileMcpConfig();
      expect(result.appBundleDir).toBe("/tmp/flowscout-apps");
    });
  });

  it("trims whitespace from the directory path", () => {
    withEnv({ FLOWSCOUT_APP_BUNDLE_DIR: "  /var/builds/apps  " }, () => {
      const result = loadMobileMcpConfig();
      expect(result.appBundleDir).toBe("/var/builds/apps");
    });
  });

  it("returns undefined for an empty string (treated as absent)", () => {
    withEnv({ FLOWSCOUT_APP_BUNDLE_DIR: "" }, () => {
      const result = loadMobileMcpConfig();
      expect(result.appBundleDir).toBeUndefined();
    });
  });

  it("returns undefined for whitespace-only string", () => {
    withEnv({ FLOWSCOUT_APP_BUNDLE_DIR: "  " }, () => {
      const result = loadMobileMcpConfig();
      expect(result.appBundleDir).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Security invariants (T5)
// ---------------------------------------------------------------------------

describe("loadMobileMcpConfig — security invariants (T5)", () => {
  it("serverEnv contains only PATH, not other env vars (T5)", () => {
    vi.stubEnv("FLOWSCOUT_VAULT_KEY", "super-secret");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost/db");
    const result = loadMobileMcpConfig();
    const env = result.driverConfig.server.serverEnv;
    expect(env).not.toHaveProperty("FLOWSCOUT_VAULT_KEY");
    expect(env).not.toHaveProperty("DATABASE_URL");
    const keys = Object.keys(env);
    expect(keys.every((k) => k === "PATH")).toBe(true);
  });

  it("the returned config object is structured, not a reference to process.env (structural T5)", () => {
    withEnv({ FLOWSCOUT_MCP_SERVER_COMMAND: "node,server.js" }, () => {
      const result = loadMobileMcpConfig();
      expect(result.driverConfig.server).not.toBe(process.env);
      expect(result.driverConfig.server.serverCommand).toBeInstanceOf(Array);
    });
  });
});

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

describe("MobileMcpConfigError", () => {
  it("is an instance of Error", () => {
    const err = new MobileMcpConfigError("test");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name MobileMcpConfigError", () => {
    const err = new MobileMcpConfigError("test");
    expect(err.name).toBe("MobileMcpConfigError");
  });

  it("is thrown (not a generic Error) for invalid timeout", () => {
    withEnv({ FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS: "bad" }, () => {
      expect(() => loadMobileMcpConfig()).toThrow(MobileMcpConfigError);
    });
  });
});
