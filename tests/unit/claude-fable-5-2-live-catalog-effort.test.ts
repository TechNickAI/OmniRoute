import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fable 5.2 shipped 2026-11-09. Claude subscription discovery lists the bare id
// `claude-fable-5-2` with no effort metadata, so `claude/claude-fable-5-2-xhigh`
// 400'd "not available in the active live catalog" until the registry declared
// the model and its effort tiers. Mirrors how `claude-fable-5-1-xhigh` resolves.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-fable52-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "fable-52-test-secret";

const core = await import("../../src/lib/db/core.ts");
const { replaceSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");

const CONNECTION_ID = "claude-conn-fable52";

async function seedLiveCatalog() {
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO provider_connections
       (id, provider, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(CONNECTION_ID, "claude", 1, now, now);
  await replaceSyncedAvailableModelsForConnection("claude", CONNECTION_ID, [
    { id: "claude-fable-5-2", name: "Claude Fable 5.2", source: "api" as const },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", source: "api" as const },
  ]);
}

test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await seedLiveCatalog();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
  test(`claude/claude-fable-5-2-${effort} resolves to the 5.2 base with effort ${effort}`, async () => {
    const info = (await getModelInfo(`claude/claude-fable-5-2-${effort}`)) as any;
    assert.equal(info.errorType, undefined, info.errorMessage);
    assert.equal(info.provider, "claude");
    assert.equal(info.model, "claude-fable-5-2");
    assert.equal(info.resolvedThinkingEffort ?? info.metadata?.resolvedThinkingEffort, effort);
  });
}

test("claude/claude-fable-5-1-xhigh still resolves to 5.1 (no cross-version capture)", async () => {
  const info = (await getModelInfo("claude/claude-fable-5-1-xhigh")) as any;
  assert.equal(info.errorType, undefined, info.errorMessage);
  assert.equal(info.model, "claude-fable-5-1");
});
