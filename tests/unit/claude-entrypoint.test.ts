import test from "node:test";
import assert from "node:assert/strict";
import {
  getClaudeEntrypoint,
  claudeCliUserAgent,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_CLI_VERSION,
} from "../../open-sse/config/anthropicHeaders.ts";
import { mergeUpstreamExtraHeaders } from "../../open-sse/executors/base/headers.ts";

const ORIGINAL = process.env.CLAUDE_CC_ENTRYPOINT;

function withEntrypoint(value: string | undefined, fn: () => void) {
  if (value === undefined) delete process.env.CLAUDE_CC_ENTRYPOINT;
  else process.env.CLAUDE_CC_ENTRYPOINT = value;
  try {
    fn();
  } finally {
    if (ORIGINAL === undefined) delete process.env.CLAUDE_CC_ENTRYPOINT;
    else process.env.CLAUDE_CC_ENTRYPOINT = ORIGINAL;
  }
}

test("getClaudeEntrypoint defaults to cli when unset", () => {
  withEntrypoint(undefined, () => {
    assert.equal(getClaudeEntrypoint(), "cli");
    assert.equal(claudeCliUserAgent("2.1.158"), "claude-cli/2.1.158 (external, cli)");
  });
});

test("getClaudeEntrypoint honors sdk-cli (cc_entrypoint + UA stay consistent)", () => {
  withEntrypoint("sdk-cli", () => {
    assert.equal(getClaudeEntrypoint(), "sdk-cli");
    assert.equal(claudeCliUserAgent("2.1.158"), "claude-cli/2.1.158 (external, sdk-cli)");
  });
});

test("getClaudeEntrypoint honors explicit cli", () => {
  withEntrypoint("cli", () => {
    assert.equal(getClaudeEntrypoint(), "cli");
  });
});

test("getClaudeEntrypoint trims surrounding whitespace", () => {
  withEntrypoint("  sdk-cli  ", () => {
    assert.equal(getClaudeEntrypoint(), "sdk-cli");
  });
});

test("getClaudeEntrypoint falls back to cli on an invalid value", () => {
  withEntrypoint("bogus", () => {
    assert.equal(getClaudeEntrypoint(), "cli");
    assert.equal(claudeCliUserAgent("2.1.158"), "claude-cli/2.1.158 (external, cli)");
  });
});

// Regression guard: CLAUDE_CLI_USER_AGENT is used in getClaudeCliHeaders() for
// API-key connections. It must always be "cli" — never reflect CLAUDE_CC_ENTRYPOINT,
// which is an OAuth-only billing identity knob. Changing this to use claudeCliUserAgent()
// (dynamic) would leak the sdk-cli entrypoint into non-OAuth credential surfaces.
test("CLAUDE_CLI_USER_AGENT is always cli regardless of CLAUDE_CC_ENTRYPOINT", () => {
  assert.equal(CLAUDE_CLI_USER_AGENT, `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`);
  assert.ok(
    !CLAUDE_CLI_USER_AGENT.includes("sdk-cli"),
    "static registry UA must never carry sdk-cli"
  );
});

// Upstream headers are an explicit operator override. OAuth uses the dynamic default
// UA, while mergeUpstreamExtraHeaders keeps its documented last-writer-wins behavior.
test("mergeUpstreamExtraHeaders preserves an explicit User-Agent override", () => {
  const version = "4.0.0";
  const headers: Record<string, string> = {
    "User-Agent": claudeCliUserAgent(version),
  };
  const expected = `claude-cli/${version} (external, ${getClaudeEntrypoint()})`;
  assert.equal(headers["User-Agent"], expected);

  // Operator sets a custom User-Agent via upstream extra headers — mergeUpstreamExtraHeaders
  // will apply it, overriding the OAuth billing UA.
  mergeUpstreamExtraHeaders(headers, { "User-Agent": "custom-proxy/1.0" });
  assert.equal(headers["User-Agent"], "custom-proxy/1.0");

  assert.equal(headers["User-Agent"], "custom-proxy/1.0");
});
