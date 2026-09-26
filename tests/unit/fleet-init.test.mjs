import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initFleet } from "../../scripts/docker/fleet-review/init-fleet.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "omniroute-fleet-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, ".env.fleet");
}

test("fresh instances receive independent private secrets", (t) => {
  const first = fixture(t);
  const second = fixture(t);
  initFleet(first);
  initFleet(second);
  const secrets = [first, second].flatMap((path) =>
    [
      ...readFileSync(path, "utf8").matchAll(
        /^(?:JWT_SECRET|API_KEY_SECRET|STORAGE_ENCRYPTION_KEY|INITIAL_PASSWORD)=([a-f0-9]{64})$/gm
      ),
    ].map((match) => match[1])
  );
  assert.equal(secrets.length, 8);
  assert.equal(new Set(secrets).size, 8);
  if (process.platform !== "win32") assert.equal(statSync(first).mode & 0o777, 0o600);
});

test("initialization never overwrites existing encryption keys", (t) => {
  const path = fixture(t);
  initFleet(path);
  const before = readFileSync(path);
  assert.throws(() => initFleet(path), { code: "EEXIST" });
  assert.deepEqual(readFileSync(path), before);
});

test("initialization refuses symlinks without touching their targets", (t) => {
  const path = fixture(t);
  const target = `${path}.target`;
  writeFileSync(target, "existing keys");
  symlinkSync(target, path);
  assert.throws(() => initFleet(path), { code: "EEXIST" });
  assert.equal(readFileSync(target, "utf8"), "existing keys");
});
