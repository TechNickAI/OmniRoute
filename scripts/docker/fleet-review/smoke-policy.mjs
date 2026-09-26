// Only smoke-fleet's throwaway container; synthetic rows have no credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readPolicy, syncPolicy, inventory } from "./fleet-policy.mjs";
import { managementClient } from "./sync-fleet.mjs";

export async function smokePolicy({ url, password, docker, name }) {
  const client = await managementClient(url, password);
  const policy = readPolicy(
    readFileSync(new URL("./fleet-policy.example.yaml", import.meta.url), "utf8")
  );
  const fresh = await syncPolicy(policy, client);
  assert.equal(fresh.changed, false);
  assert.deepEqual(fresh.blockers, []);
  console.log("PASS: zero-account policy dry-run is clean against the compiled API");
  const swarm = randomUUID();
  const shared = randomUUID();
  // SQLite fixture insertion avoids provider-creation hooks and OAuth entirely.
  const seed = `
    const db = require('better-sqlite3')('/app/data/storage.sqlite');
    const insert = db.prepare('INSERT INTO provider_connections (id,provider,auth_type,email,is_active,"group",created_at,updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
    const now = new Date().toISOString();
    insert.run(${JSON.stringify(swarm)}, 'codex', 'apikey', 'swarm@example.invalid', 'swarm', now, now);
    insert.run(${JSON.stringify(shared)}, 'codex', 'apikey', 'shared@example.invalid', 'shared', now, now);
    db.close();
  `;
  docker(["exec", name, "node", "-e", seed]);
  policy.connections = [
    { connectionId: swarm, pool: "codex/swarm", identity: "swarm@example.invalid" },
  ];
  policy.combos = {
    coding: { strategy: "reset-aware", steps: [{ pool: "codex/swarm", model: "codex/gpt-5" }] },
  };
  policy.keys = {
    "swarm-workers": {
      enabled: true,
      pools: ["codex/swarm"],
      combos: ["coding"],
      rateLimits: [{ limit: 6, window: 60 }],
      expiresAt: null,
    },
  };
  policy.gates.swarmSingleLaneReady = true;
  let secret;
  await syncPolicy(policy, client, {
    dryRun: false,
    saveKey: async (_name, key) => {
      secret = key;
    },
  });
  assert.equal(typeof secret, "string");
  const state = await inventory(client);
  const key = state.keys.find((item) => item.name === "fleet:swarm-workers");
  assert.deepEqual(key.allowedConnections, [swarm]);
  assert.equal(key.isActive, true);
  assert.equal(key.modelAccessMode, "restricted");
  assert.deepEqual(key.allowedModels, ["fleet-coding"]);
  assert.deepEqual(key.rateLimits, [{ limit: 6, window: 60 }]);
  assert.equal((await syncPolicy(policy, client)).changed, false);
  assert.equal((await syncPolicy(policy, client, { dryRun: false })).changed, false);
  for (const model of ["codex/gpt-5", "voice", "claude-chat"]) {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "x-omniroute-connection": shared,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "synthetic access check" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(
      response.status,
      403,
      "raw models and Owner-only routes must be denied before provider execution"
    );
  }
  console.log(
    "PASS: policy applies explicit pool grants, rate limits and route denials; repeat sync is a no-op"
  );
  policy.protectedIdentities.push({ provider: "codex", identity: "swarm@example.invalid" });
  await assert.rejects(syncPolicy(policy, client, { dryRun: false }), /managed keys disabled/);
  assert.equal((await inventory(client)).keys.find((item) => item.id === key.id).isActive, false);
  console.log("PASS: newly protected identity blocks grants and disables the existing managed key");
}
