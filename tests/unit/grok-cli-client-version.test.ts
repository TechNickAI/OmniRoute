import test from "node:test";
import assert from "node:assert/strict";

const {
  getGrokBuildClientVersion,
  getGrokBuildClientHeaders,
  getGrokBuildUserAgent,
  GROK_BUILD_DEFAULT_CLIENT_VERSION,
  GROK_BUILD_CLIENT_VERSION_ENV,
} = await import("@omniroute/open-sse/config/grokBuild.ts");

// xAI's cli-chat-proxy returns 426 for any client below its floor (1.0.13 as of
// 2026-09-30). The version is read per call, so the env override takes effect on
// restart without a rebuild.
function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env[GROK_BUILD_CLIENT_VERSION_ENV];
  if (value === undefined) delete process.env[GROK_BUILD_CLIENT_VERSION_ENV];
  else process.env[GROK_BUILD_CLIENT_VERSION_ENV] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[GROK_BUILD_CLIENT_VERSION_ENV];
    else process.env[GROK_BUILD_CLIENT_VERSION_ENV] = prev;
  }
}

function major(v: string) {
  return v.split(".").map((n) => Number.parseInt(n, 10));
}

test("default Grok CLI version clears xAI's 1.0.13 floor", () => {
  withEnv(undefined, () => {
    const [a, b, c] = major(getGrokBuildClientVersion());
    assert.ok(
      a > 1 || (a === 1 && (b > 0 || c >= 13)),
      `default ${getGrokBuildClientVersion()} is below 1.0.13`
    );
  });
});

test("env override sets the version header and the User-Agent together", () => {
  withEnv("1.0.99", () => {
    assert.equal(getGrokBuildClientVersion(), "1.0.99");
    const h = getGrokBuildClientHeaders();
    assert.equal(h["x-grok-client-version"], "1.0.99");
    assert.match(h["User-Agent"], /^grok-shell\/1\.0\.99 \(/);
    assert.match(getGrokBuildUserAgent(), /^grok-shell\/1\.0\.99 \(/);
  });
});

test("malformed override is ignored, not sent upstream", () => {
  for (const bad of ["", "  ", "latest", "1.0", "1.0.46\r\nX-Evil: 1", "1.0.46 (x)"]) {
    withEnv(bad, () =>
      assert.equal(getGrokBuildClientVersion(), GROK_BUILD_DEFAULT_CLIENT_VERSION, bad)
    );
  }
  withEnv(" 1.0.50 ", () => assert.equal(getGrokBuildClientVersion(), "1.0.50"));
});
