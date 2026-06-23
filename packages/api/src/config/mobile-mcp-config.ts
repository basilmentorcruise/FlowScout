/**
 * Env-driven config loader for the Mobile MCP adapter (E1.7 #18).
 *
 * This module is the SOLE place that reads process.env for Mobile MCP adapter config.
 * It is logic-free: it reads, parses, and validates env vars then returns a plain
 * value object. No business logic belongs here.
 *
 * Security posture (T5 — secrets/env leakage):
 *   - Never logs full env, process.env, or the full config object.
 *   - Logs only non-secret allowlisted fields: server command name + timeouts.
 *   - serverEnv passed to the child process is scoped (defaultServerEnv — PATH only).
 *   - FLOWSCOUT_APP_BUNDLE_DIR is the single source of truth for the lifecycle
 *     confinement base dir (T2 — path traversal defence; eliminates divergence
 *     between per-capability internal defaults).
 *
 * Environment variables documented in .env.example:
 *   FLOWSCOUT_MCP_SERVER_COMMAND   — comma-separated argv array (default: "npx,mobile-mcp")
 *   FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS — ms (default: 10000)
 *   FLOWSCOUT_MCP_CALL_TIMEOUT_MS  — ms (default: 30000)
 *   FLOWSCOUT_APP_BUNDLE_DIR       — allowlisted base dir for .app bundles (required for real round-trip)
 */

import type { MobileMcpDriverConfig } from "@flowscout/adapter-mobile-mcp";
import { defaultServerEnv } from "@flowscout/adapter-mobile-mcp";

// ---------------------------------------------------------------------------
// Constants (named to avoid magic numbers in the loader)
// ---------------------------------------------------------------------------

/** Default MCP server command as an argv array. First element is the executable. */
const DEFAULT_SERVER_COMMAND: readonly string[] = ["npx", "mobile-mcp"];

/** Default timeout (ms) for MCP connection/handshake. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Default timeout (ms) per individual MCP tool call. */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

/**
 * Extended result from loadMobileMcpConfig — includes the driver config plus
 * the app-bundle base directory (injected separately by the composition root
 * into lifecycle confinement, not into the driver constructor).
 */
export interface MobileMcpEnvConfig {
  /** Full driver construction config (server + timeouts). */
  readonly driverConfig: MobileMcpDriverConfig;
  /**
   * Allowlisted base directory for .app bundles (T2 path-traversal confinement).
   * Source: FLOWSCOUT_APP_BUNDLE_DIR. Undefined if not set (dev/test env).
   * The composition root passes this to the lifecycle capability's base-dir config.
   * Production runs MUST set this var — documented in .env.example.
   */
  readonly appBundleDir: string | undefined;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Read Mobile MCP configuration from environment variables and return a typed
 * value object. Pure function — no side effects other than reading process.env.
 *
 * Security (T5): only the server command name and timeout values may appear in
 * log output; never the full config, full env, or any secret.
 */
export function loadMobileMcpConfig(): MobileMcpEnvConfig {
  const serverCommand = parseServerCommand(process.env["FLOWSCOUT_MCP_SERVER_COMMAND"]);
  const connectTimeoutMs = parsePositiveInt(
    process.env["FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS"],
    DEFAULT_CONNECT_TIMEOUT_MS,
    "FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS",
  );
  const callTimeoutMs = parsePositiveInt(
    process.env["FLOWSCOUT_MCP_CALL_TIMEOUT_MS"],
    DEFAULT_CALL_TIMEOUT_MS,
    "FLOWSCOUT_MCP_CALL_TIMEOUT_MS",
  );
  const appBundleDir = parseOptionalDir(process.env["FLOWSCOUT_APP_BUNDLE_DIR"]);

  return {
    driverConfig: {
      server: {
        serverCommand,
        serverEnv: defaultServerEnv(), // scoped PATH-only env (T5 — never blanket process.env)
        connectTimeoutMs,
        callTimeoutMs,
      },
    },
    appBundleDir,
  };
}

// ---------------------------------------------------------------------------
// Private parsers
// ---------------------------------------------------------------------------

/**
 * Parse FLOWSCOUT_MCP_SERVER_COMMAND: comma-separated argv array.
 * "npx,mobile-mcp" → ["npx", "mobile-mcp"].
 * Empty segments are filtered out.
 */
function parseServerCommand(raw: string | undefined): readonly string[] {
  if (!raw || raw.trim() === "") {
    return DEFAULT_SERVER_COMMAND;
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    return DEFAULT_SERVER_COMMAND;
  }
  return parts;
}

/**
 * Parse a strictly-positive integer from an env var string.
 * Returns `defaultValue` if the string is absent or empty.
 * Throws ConfigError if the value is present but not a valid positive integer.
 */
function parsePositiveInt(raw: string | undefined, defaultValue: number, varName: string): number {
  if (!raw || raw.trim() === "") {
    return defaultValue;
  }
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new MobileMcpConfigError(
      `${varName} must be a positive integer; received: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Parse an optional directory path env var.
 * Returns undefined if unset or empty; returns the trimmed string otherwise.
 * The value is NOT resolved here (no fs.realpath) — resolution happens in the
 * lifecycle adapter which enforces confinement (T2).
 */
function parseOptionalDir(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === "") {
    return undefined;
  }
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Thrown when a required/parseable env var has an invalid value. */
export class MobileMcpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MobileMcpConfigError";
  }
}
