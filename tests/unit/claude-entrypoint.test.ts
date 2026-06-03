import test from "node:test";
import assert from "node:assert/strict";
import {
  getClaudeEntrypoint,
  claudeCliUserAgent,
} from "../../open-sse/config/anthropicHeaders.ts";

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
