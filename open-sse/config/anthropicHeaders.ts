export const ANTHROPIC_VERSION_HEADER = "2023-06-01";

const ANTHROPIC_BETA_BASE = Object.freeze([
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
  "advisor-tool-2026-03-01",
  "extended-cache-ttl-2025-04-11",
  "cache-diagnosis-2026-04-07",
]);

const CLAUDE_OAUTH_EXTRA_BETAS = Object.freeze(["fine-grained-tool-streaming-2025-05-14"]);

export const ANTHROPIC_BETA_FULL = ANTHROPIC_BETA_BASE.join(",");
export const ANTHROPIC_BETA_API_KEY = ANTHROPIC_BETA_BASE.filter(
  (beta) => beta !== "oauth-2025-04-20"
).join(",");
export const ANTHROPIC_BETA_CLAUDE_OAUTH = [
  ...ANTHROPIC_BETA_BASE.slice(0, 3),
  ...CLAUDE_OAUTH_EXTRA_BETAS,
  ...ANTHROPIC_BETA_BASE.slice(3),
].join(",");

export const CLAUDE_CLI_VERSION = "2.1.158";

/**
 * Anthropic billing "entrypoint" label sent on native Claude OAuth requests:
 * the `cc_entrypoint=` field of `x-anthropic-billing-header` and the
 * `(external, <entrypoint>)` suffix of the claude-cli User-Agent.
 *
 * - `cli`     — mirrors the official Claude Code CLI (default; current behavior).
 * - `sdk-cli` — mirrors the Claude Agent SDK.
 *
 * Anthropic currently meters some `cli`-labelled third-party OAuth traffic
 * against the account's *extra usage* balance instead of plan limits
 * (see anthropics/claude-code#45203). Operators whose subscription requests get
 * rejected with "You're out of extra usage" can set `CLAUDE_CC_ENTRYPOINT=sdk-cli`
 * to route through the Agent SDK entrypoint, which is currently classified as
 * plan usage. This is the same wire image OmniRoute's CC-Compatible provider
 * already uses (`claude-cli/2.1.158 (external, sdk-cli)`).
 */
export type ClaudeEntrypoint = "cli" | "sdk-cli";
const VALID_CLAUDE_ENTRYPOINTS: readonly ClaudeEntrypoint[] = ["cli", "sdk-cli"];
let warnedInvalidClaudeEntrypoint = false;

export function getClaudeEntrypoint(): ClaudeEntrypoint {
  const raw = process.env.CLAUDE_CC_ENTRYPOINT?.trim();
  if (!raw) return "cli";
  if ((VALID_CLAUDE_ENTRYPOINTS as readonly string[]).includes(raw)) {
    return raw as ClaudeEntrypoint;
  }
  if (!warnedInvalidClaudeEntrypoint) {
    warnedInvalidClaudeEntrypoint = true;
    console.warn(
      `[claude] Ignoring invalid CLAUDE_CC_ENTRYPOINT="${raw}" (expected "cli" or "sdk-cli"); using "cli".`
    );
  }
  return "cli";
}

/** Builds the claude-cli User-Agent with the configured entrypoint suffix. */
export function claudeCliUserAgent(version: string): string {
  return `claude-cli/${version} (external, ${getClaudeEntrypoint()})`;
}

export const CLAUDE_CLI_USER_AGENT = claudeCliUserAgent(CLAUDE_CLI_VERSION);
export const CLAUDE_CLI_STAINLESS_PACKAGE_VERSION = "0.94.0";
export const CLAUDE_CLI_STAINLESS_RUNTIME_VERSION = "v24.3.0";
