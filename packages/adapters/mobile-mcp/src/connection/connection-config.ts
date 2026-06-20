/**
 * MobileMcpDriverConfig — value object holding all injected configuration.
 * ADR-0002 §2.4: "All timeouts/paths are config (no magic numbers, ADR-0001 §6)."
 *
 * Security (T5/T7):
 * - `serverCommand` is an argv array + `shell:false` spawn (never a shell string).
 * - `serverEnv` is the SCOPED env for the child process — never blanket `process.env`.
 * - No secrets are logged; only non-secret fields (timeout values, command name) may appear in logs.
 */

/**
 * Configuration for spawning the mobile-mcp MCP server over stdio.
 * All fields are injected at construction — no hardcoded paths or magic numbers.
 */
export interface McpServerConfig {
  /**
   * Command to spawn the MCP server, as an argv array.
   * The first element is the executable; subsequent elements are arguments.
   * MUST be an array — shell:false is mandatory (T1/T7 security controls).
   * Example: ["npx", "mobile-mcp"]
   */
  readonly serverCommand: readonly string[];

  /**
   * Scoped environment for the server child process.
   * Pass ONLY what the server needs — never spread process.env here (T5).
   * Default: minimal PATH-only env constructed in defaultServerEnv().
   */
  readonly serverEnv: Readonly<Record<string, string>>;

  /**
   * Timeout (ms) for the initial MCP connection/handshake.
   * The adapter throws McpTimeoutError if the server does not become ready within this bound.
   */
  readonly connectTimeoutMs: number;

  /**
   * Timeout (ms) applied to every individual tool call.
   * Passed through to callTool(); capabilities inherit it unless they override.
   */
  readonly callTimeoutMs: number;
}

/**
 * Full driver configuration that the composition root constructs and injects.
 * Flat — each field is explicitly typed so there is no opaque bag-of-options.
 */
export interface MobileMcpDriverConfig {
  readonly server: McpServerConfig;
}

/**
 * Build a minimal, scoped server environment.
 * Only `PATH` is forwarded so the server can resolve its own dependencies;
 * no secrets, vault keys, DB URLs, or LLM keys are present (T5).
 *
 * Call this from the composition root when no custom serverEnv is needed.
 */
export function defaultServerEnv(): Readonly<Record<string, string>> {
  const path = process.env["PATH"];
  return path !== undefined ? { PATH: path } : {};
}
