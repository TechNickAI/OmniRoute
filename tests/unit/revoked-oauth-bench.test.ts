import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// WO-MC32: a revoked OAuth login (Codex "invalidated oauth token" 401 while the stored access
// token is still inside its expiry window) must be benched after N consecutive revoked-token
// 401s, and nothing else (one transient 401, ordinary 401s, 429s, 5xx) may bench it.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-revoked-oauth-bench-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_REVOKED_OAUTH_BENCH_THRESHOLD = "3";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const compliance = await import("../../src/lib/compliance/index.ts");

const REVOKED = "[401]: Encountered invalidated oauth token for user, failing request";
const PLAIN_401 = "Unauthorized";

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function codexOAuthConnection() {
  // Token still valid for an hour: the exact state of the revoked login in production, which the
  // pre-existing "still-valid token is not expired" guard un-parks on every 401.
  const conn = await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    isActive: true,
    testStatus: "active",
  });
  return (conn as any).id as string;
}

async function fail(id: string, status: number, body: string) {
  // Production order: the connection sits out its cooldown, the first request after it expires
  // fails again. Expire any cooldown so each call is a new observation, not a deduped duplicate.
  await providersDb.updateProviderConnection(id, { rateLimitedUntil: null });
  await auth.markAccountUnavailable(id, status, body, "codex", "gpt-6.1-sol");
  return providersDb.getProviderConnectionById(id);
}

function benchAuditRows(id: string) {
  return compliance
    .getAuditLog({ action: "provider.connection.benched" } as any)
    .filter((row: any) => JSON.stringify(row).includes(id));
}

test("N consecutive revoked-login 401s bench the connection and raise exactly one alert", async () => {
  await resetStorage();
  const id = await codexOAuthConnection();

  let after = await fail(id, 401, REVOKED);
  assert.notEqual(after.testStatus, "expired", "one revoked 401 must not bench");
  after = await fail(id, 401, REVOKED);
  assert.notEqual(after.testStatus, "expired", "two revoked 401s must not bench (threshold 3)");
  after = await fail(id, 401, REVOKED);
  assert.equal(after.testStatus, "expired", "third consecutive revoked 401 must bench");
  assert.equal(after.lastErrorType, "oauth_login_revoked");
  assert.equal(benchAuditRows(id).length, 1, "bench raises one audit alert");

  // Still benched and still exactly one alert if more revoked 401s arrive.
  after = await fail(id, 401, REVOKED);
  assert.equal(after.testStatus, "expired");
  assert.equal(benchAuditRows(id).length, 1, "no repeat alert while benched");

  // Benched means excluded from selection.
  const selected: any = await auth.getProviderCredentials("codex");
  assert.ok(!selected || selected.connectionId !== id, "benched connection must not be selected");
});

test("a single transient revoked-token 401 followed by success does NOT bench", async () => {
  await resetStorage();
  const id = await codexOAuthConnection();

  let after = await fail(id, 401, REVOKED);
  assert.notEqual(after.testStatus, "expired");
  await auth.clearAccountError(id, after); // the next request succeeded
  after = await fail(id, 401, REVOKED);
  after = await fail(id, 401, REVOKED);
  assert.notEqual(after.testStatus, "expired", "streak must restart after a success");
  assert.equal(benchAuditRows(id).length, 0);
});

test("ordinary 401s, 429s and 5xx never bench, and they break a revoked-token streak", async () => {
  await resetStorage();
  const id = await codexOAuthConnection();

  for (let i = 0; i < 5; i++) {
    const after = await fail(id, 401, PLAIN_401);
    assert.notEqual(after.testStatus, "expired", `plain 401 #${i + 1} must not bench`);
  }
  for (const [status, body] of [
    [429, "rate limit exceeded"],
    [502, "bad gateway"],
    [503, "service unavailable"],
  ] as const) {
    for (let i = 0; i < 4; i++) {
      const after = await fail(id, status, body);
      assert.notEqual(after.testStatus, "expired", `${status} must not bench`);
    }
  }

  // revoked, revoked, 503, revoked, revoked: never 3 consecutive → no bench.
  const id2 = await codexOAuthConnection();
  await fail(id2, 401, REVOKED);
  await fail(id2, 401, REVOKED);
  await fail(id2, 503, "service unavailable");
  await fail(id2, 401, REVOKED);
  const after = await fail(id2, 401, REVOKED);
  assert.notEqual(after.testStatus, "expired", "an interleaved 5xx must reset the streak");
  assert.equal(benchAuditRows(id).length + benchAuditRows(id2).length, 0);
});
