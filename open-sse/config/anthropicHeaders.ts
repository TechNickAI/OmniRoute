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

/**
 * Client-negotiated `anthropic-beta` values that are safe to forward to the
 * claude.ai backend on top of OmniRoute's own set. Kept to betas the backend
 * actually accepts and that OmniRoute does not otherwise emit — so a blind
 * passthrough cannot reintroduce the over-sending fingerprint/rejection bugs
 * (#3415, #2454). Currently: deferred-tool negotiation (#3974).
 */
export const FORWARDABLE_CLIENT_BETAS = Object.freeze(["tool-search-tool-2025-10-19"]);

/**
 * Union an `anthropic-beta` comma-list with the allowlisted client-negotiated
 * betas, preserving base order and appending only NEW tokens (deduped,
 * case-insensitive). The client beta is added only if it is on `allow`, so this
 * never forces betas the client did not request nor leaks betas the backend
 * rejects. See #3974 (tool-search-tool dropped on the Claude OAuth path).
 */
export function mergeClientAnthropicBeta(
  base: string,
  clientBeta: string | null | undefined,
  allow: readonly string[] = FORWARDABLE_CLIENT_BETAS
): string {
  const baseList = base
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (typeof clientBeta !== "string" || !clientBeta.trim()) return baseList.join(",");
  const seen = new Set(baseList.map((s) => s.toLowerCase()));
  const allowSet = new Set(allow.map((s) => s.toLowerCase()));
  for (const token of clientBeta
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const lower = token.toLowerCase();
    if (allowSet.has(lower) && !seen.has(lower)) {
      baseList.push(token);
      seen.add(lower);
    }
  }
  return baseList.join(",");
}

/**
 * Collapse a list of comma-list header values into a deduped, trimmed token
 * array. Empty/undefined/null entries are dropped. Used to reconcile the
 * case-variant `anthropic-version` / `anthropic-beta` headers below.
 */
function uniqueCommaValues(values: Array<string | undefined | null>): string[] {
  return [
    ...new Set(
      values
        .filter((value) => value !== undefined && value !== null && value !== "")
        .flatMap((value) => String(value).split(","))
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * Dedupe case-variant Anthropic headers in-place. Node/undici's fetch merges
 * `anthropic-version` and `Anthropic-Version` into a single `"v, v"` value,
 * which the Anthropic API rejects (#1475). Collapse both case variants down to
 * one canonical lowercase header carrying a single value. Same for
 * `anthropic-beta` (joined comma-list, deduped). Mutates `headers`.
 */
export function normalizeAnthropicHeaderVariants(headers: Record<string, string>): void {
  // Only collapse when BOTH case variants are present simultaneously — that is the
  // only situation undici merges into a rejected `"v, v"` value. A lone variant is
  // sent fine on its own, so leave it untouched (preserving the caller's casing
  // instead of silently rewriting it to lowercase).
  if ("anthropic-version" in headers && "Anthropic-Version" in headers) {
    const versionValues = uniqueCommaValues([
      headers["anthropic-version"],
      headers["Anthropic-Version"],
    ]);
    delete headers["Anthropic-Version"];
    delete headers["anthropic-version"];
    if (versionValues.length > 0) {
      headers["anthropic-version"] = versionValues[0];
    }
  }

  if ("anthropic-beta" in headers && "Anthropic-Beta" in headers) {
    const betaValues = uniqueCommaValues([headers["anthropic-beta"], headers["Anthropic-Beta"]]);
    delete headers["Anthropic-Beta"];
    delete headers["anthropic-beta"];
    if (betaValues.length > 0) {
      headers["anthropic-beta"] = betaValues.join(",");
    }
  }
}

export const CLAUDE_CLI_VERSION = "2.1.207";

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
 * already uses (`claude-cli/<version> (external, sdk-cli)`).
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
