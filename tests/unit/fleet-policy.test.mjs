import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  canonicalIdentity,
  planPolicy,
  readPolicy,
  syncPolicy,
  validatePolicy,
} from "../../scripts/docker/fleet-review/fleet-policy.mjs";

const source = readFileSync(
  new URL("../../scripts/docker/fleet-review/fleet-policy.example.yaml", import.meta.url),
  "utf8"
);
const empty = () => ({ connections: [], keys: [], combos: [], overrides: [] });
function fixture() {
  const policy = readPolicy(source);
  const id = randomUUID();
  policy.gates.swarmSingleLaneReady = true;
  policy.connections = [
    {
      connectionId: id,
      pool: "codex/swarm",
      identity: "synthetic@example.invalid",
    },
  ];
  policy.combos = {
    coding: {
      strategy: "reset-aware",
      steps: [{ pool: "codex/swarm", model: "codex/fake-model" }],
    },
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
  const state = {
    ...empty(),
    connections: [
      {
        id,
        provider: "codex",
        email: "synthetic@example.invalid",
        isActive: true,
        group: "swarm",
      },
    ],
  };
  return { policy, state, id };
}
function fakeRouter(state, hook = () => {}) {
  const writes = [];
  let reads = 0;
  const client = async (path, method = "GET", body) => {
    hook({ path, method, body, reads, state });
    if (method === "GET") {
      reads++;
      if (path === "/api/providers")
        return structuredClone({
          connections: state.connections,
          total: state.connections.length,
        });
      if (path === "/api/keys")
        return structuredClone({ keys: state.keys, total: state.keys.length });
      if (path.startsWith("/api/combos?"))
        return structuredClone({
          combos: state.combos,
          total: state.combos.length,
        });
      return structuredClone({ overrides: state.overrides });
    }
    writes.push({ path, method, body: structuredClone(body) });
    if (path.startsWith("/api/keys/"))
      Object.assign(
        state.keys.find((k) => path.endsWith(k.id)),
        body
      );
    else if (path === "/api/keys") {
      const key = { ...body, id: randomUUID(), isActive: true };
      state.keys.push(key);
      return { ...key, key: "synthetic-secret-never-log" };
    } else if (path === "/api/combos") state.combos.push({ ...body, id: randomUUID() });
    else if (path.startsWith("/api/combos/"))
      Object.assign(
        state.combos.find((c) => path.endsWith(c.id)),
        body
      );
    else if (path.startsWith("/api/providers/")) {
      const c = state.connections.find((c) => path.endsWith(c.id));
      Object.assign(c, {
        ...body,
        providerSpecificData: {
          ...c.providerSpecificData,
          ...body.providerSpecificData,
        },
      });
    } else if (path === "/api/model-capability-overrides") {
      const old = state.overrides.find((o) => o.target === body.target && o.key === body.key);
      const value = body.key === "reasoning_efforts" ? body.value.split(",") : body.value;
      if (old) old.value = value;
      else state.overrides.push({ ...body, value });
    }
    return {};
  };
  return { client, writes };
}

test("zero-account bootstrap is valid and has no drift or grants", () => {
  const plan = planPolicy(readPolicy(source), empty());
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.blockers, []);
});

test("policy parser rejects duplicate YAML keys, aliases, unknown fields and permissive wildcards", () => {
  assert.throws(() => readPolicy(source + "\nversion: 1\n"));
  assert.throws(() => readPolicy("version: &x 1\nnamespace: *x"));
  const { policy } = fixture();
  assert.throws(() => validatePolicy({ ...policy, typo: true }));
  policy.combos.coding.steps[0].model = "codex/*";
  assert.throws(() => validatePolicy(policy));
});

test("pool grants include only bound active connections and never other pools", () => {
  const { policy, state, id } = fixture();
  state.connections.push({
    id: randomUUID(),
    provider: "codex",
    email: "other@example.invalid",
    group: "shared",
    isActive: true,
  });
  const plan = planPolicy(policy, state);
  assert.deepEqual(plan.keys[0].body.allowedConnections, [id]);
  assert.deepEqual(plan.keys[0].body.allowedModels, ["fleet-coding"]);
  assert.equal(plan.keys[0].body.modelAccessMode, "restricted");
});

test("protected identities match provider and canonical email aliases", () => {
  const { policy, state } = fixture();
  // These synthetic Gmail strings exercise normalization without a real account.
  policy.protectedIdentities.push({
    provider: "codex",
    identity: "protectedfixture@gmail.com",
  });
  state.connections[0].email = "P.R.O.T.E.C.T.E.D.F.I.X.T.U.R.E+unit@googlemail.com";
  policy.connections[0].identity = "protectedfixture@gmail.com";
  assert.equal(canonicalIdentity(state.connections[0].email), "protectedfixture@gmail.com");
  assert.ok(planPolicy(policy, state).blockers.includes("Protected identity: grant refused"));
  state.connections[0].provider = "claude";
  policy.connections[0].pool = "claude/shared";
  assert.ok(!planPolicy(policy, state).blockers.includes("Protected identity: grant refused"));
});

test("protected Claude account is refused and identity mismatch cannot be waived", () => {
  const { policy, state } = fixture();
  state.connections[0].provider = "claude";
  state.connections[0].email = "protected-claude@example.invalid";
  policy.connections[0] = {
    ...policy.connections[0],
    pool: "claude/shared",
    identity: state.connections[0].email,
  };
  assert.ok(planPolicy(policy, state).blockers.includes("Protected identity: grant refused"));
  policy.connections[0].identity = "different@example.invalid";
  assert.ok(
    planPolicy(policy, state).blockers.includes("Connection identity/provider binding mismatch")
  );
});

test("empty or inactive required pools block activation instead of granting allow-all", () => {
  const { policy, state } = fixture();
  state.connections[0].isActive = false;
  const plan = planPolicy(policy, state);
  assert.ok(plan.blockers.some((b) => b.includes("required pool is empty")));
});

test("Owner-only routes and cross-pool combos cannot be granted to workers", () => {
  const { policy } = fixture();
  policy.combos.voice = policy.combos.coding;
  policy.keys["swarm-workers"].combos = ["voice"];
  assert.throws(() => validatePolicy(policy), /Owner routes/);
  policy.keys["swarm-workers"].combos = ["coding"];
  policy.combos.coding.steps[0].pool = "codex/shared";
  assert.throws(() => validatePolicy(policy), /escapes key pools/);
});

test("emergency is refused before quota-only fallback and per-use alerts exist", () => {
  const { policy, state } = fixture();
  policy.keys["swarm-workers"].pools.push("codex/emergency");
  assert.ok(planPolicy(policy, state).blockers.some((b) => b.startsWith("Emergency activation")));
});

test("OpenRouter rejects missing provider-side cap evidence or no-train model approval", () => {
  const { policy, state } = fixture();
  policy.connections[0].pool = "openrouter/capped";
  state.connections[0].provider = "openrouter";
  policy.combos.coding = {
    strategy: "priority",
    steps: [{ pool: "openrouter/capped", model: "openrouter/fake-model" }],
  };
  policy.keys["swarm-workers"].pools = ["openrouter/capped"];
  assert.ok(
    planPolicy(policy, state).blockers.includes("OpenRouter cap/no-train gate not satisfied")
  );
});

test("Claude extra usage block is repaired without replacing credential metadata", () => {
  const { policy, state } = fixture();
  state.connections.push({
    id: randomUUID(),
    provider: "claude",
    providerSpecificData: { accessToken: "must-not-copy" },
  });
  const plan = planPolicy(policy, state);
  assert.deepEqual(plan.providers[0].body, {
    providerSpecificData: { blockExtraUsage: true },
  });
  assert.ok(!JSON.stringify(plan.providers).includes("must-not-copy"));
});

test("dry-run makes no writes and exposes only redacted counts and reasons", async () => {
  const { policy, state } = fixture();
  const { client, writes } = fakeRouter(state);
  const result = await syncPolicy(policy, client);
  assert.equal(writes.length, 0);
  assert.ok(result.changed);
  assert.ok(!JSON.stringify(result).includes("synthetic@example.invalid"));
});

test("apply issues an expired restricted key, saves it privately, and converges idempotently", async () => {
  const { policy, state, id } = fixture();
  policy.capabilityOverrides = [
    { target: "codex/fake-model", key: "max_output_tokens", value: 1234 },
  ];
  const { client, writes } = fakeRouter(state);
  const saved = [];
  await syncPolicy(policy, client, {
    dryRun: false,
    saveKey: async (...args) => saved.push(args),
  });
  assert.equal(saved.length, 1);
  const creation = writes.find((w) => w.path === "/api/keys");
  assert.equal(creation.body.expiresAt, "2000-01-01T00:00:00.000Z");
  assert.deepEqual(creation.body.allowedConnections, [id]);
  assert.equal(state.keys[0].isActive, true);
  const count = writes.length;
  const second = await syncPolicy(policy, client, { dryRun: false });
  assert.equal(second.changed, false);
  assert.equal(writes.length, count);
});

test("empty-pool apply disables existing keys and refuses all other writes", async () => {
  const { policy, state } = fixture();
  state.connections[0].isActive = false;
  state.keys.push({
    id: randomUUID(),
    name: "fleet:swarm-workers",
    isActive: true,
  });
  const { client, writes } = fakeRouter(state);
  await assert.rejects(syncPolicy(policy, client, { dryRun: false }), /managed keys disabled/);
  assert.equal(state.keys[0].isActive, false);
  assert.equal(writes.length, 1);
});

test("mid-apply failure leaves managed keys disabled", async () => {
  const { policy, state } = fixture();
  state.keys.push({
    id: randomUUID(),
    name: "fleet:swarm-workers",
    isActive: true,
  });
  const { client } = fakeRouter(state, ({ method, path }) => {
    if (method === "POST" && path === "/api/combos") throw new Error("synthetic failure");
  });
  await assert.rejects(syncPolicy(policy, client, { dryRun: false }));
  assert.equal(state.keys[0].isActive, false);
});

test("inventory changing between discovery and apply cannot activate a key", async () => {
  const { policy, state } = fixture();
  const { client } = fakeRouter(state, ({ reads }) => {
    if (reads >= 4) state.connections[0].isActive = false;
  });
  await assert.rejects(syncPolicy(policy, client, { dryRun: false }), /Inventory changed/);
  assert.equal(state.keys.length, 0);
});

test("removed managed keys are disabled while unmanaged keys are preserved", async () => {
  const policy = readPolicy(source);
  const state = empty();
  state.keys = [
    { id: randomUUID(), name: "fleet:retired", isActive: true },
    { id: randomUUID(), name: "outside-policy", isActive: true },
  ];
  await syncPolicy(policy, fakeRouter(state).client, { dryRun: false });
  assert.equal(state.keys[0].isActive, false);
  assert.equal(state.keys[1].isActive, true);
});

test("a failed key shutdown stops all routing writes and explicitly requires stopping traffic", async () => {
  const { policy, state } = fixture();
  state.keys.push({
    id: randomUUID(),
    name: "fleet:swarm-workers",
    isActive: true,
  });
  const { client, writes } = fakeRouter(state, ({ method, path }) => {
    if (method === "PATCH" && path.startsWith("/api/keys/")) throw new Error("unavailable");
  });
  await assert.rejects(syncPolicy(policy, client, { dryRun: false }), /stop fleet traffic/);
  assert.equal(writes.length, 0);
  assert.equal(state.combos.length, 0);
});

test("a key-secret storage failure leaves the new key expired and disabled", async () => {
  const { policy, state } = fixture();
  const { client } = fakeRouter(state);
  await assert.rejects(
    syncPolicy(policy, client, {
      dryRun: false,
      saveKey: async () => {
        throw new Error("storage unavailable");
      },
    }),
    /storage unavailable/
  );
  assert.equal(state.keys.length, 1);
  assert.equal(state.keys[0].isActive, false);
  assert.equal(state.keys[0].expiresAt, "2000-01-01T00:00:00.000Z");
});

test("truncated inventory is rejected before any writes", async () => {
  const { policy, state } = fixture();
  const router = fakeRouter(state);
  const client = async (...args) => {
    const result = await router.client(...args);
    if (args[0].startsWith("/api/combos?")) result.total = result.combos.length + 1;
    return result;
  };
  await assert.rejects(syncPolicy(policy, client, { dryRun: false }), /Inventory was truncated/);
  assert.equal(router.writes.length, 0);
});
