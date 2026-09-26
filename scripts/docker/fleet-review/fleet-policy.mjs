import { parseDocument } from "yaml";
import { z } from "zod";

const nonemptyIdentity = z.string().refine((value) => value.trim().length > 0);
const uniqueStrings = z.array(z.string()).refine((value) => new Set(value).size === value.length);
const policySchema = z.strictObject({
  version: z.literal(1),
  namespace: z.literal("fleet"),
  protectedIdentities: z
    .array(
      z.strictObject({
        provider: z.string(),
        identity: nonemptyIdentity,
      })
    )
    .min(1),
  providers: z.record(z.string(), z.strictObject({ subscription: z.boolean() })),
  pools: z.record(z.string(), z.strictObject({ provider: z.string(), label: z.string() })),
  connections: z.array(
    z.strictObject({
      connectionId: z.string(),
      pool: z.string(),
      identity: nonemptyIdentity,
    })
  ),
  combos: z.record(
    z.string(),
    z.strictObject({
      strategy: z.enum(["reset-aware", "priority"]),
      steps: z.array(z.strictObject({ pool: z.string(), model: z.string() })).min(1),
    })
  ),
  keys: z.record(
    z.string(),
    z.strictObject({
      enabled: z.boolean(),
      pools: uniqueStrings,
      combos: uniqueStrings,
      rateLimits: z
        .array(
          z.strictObject({
            limit: z.number().int().positive(),
            window: z.number().int().positive(),
          })
        )
        .min(1),
      expiresAt: z.string().nullable(),
    })
  ),
  capabilityOverrides: z.array(
    z.strictObject({
      target: z.string(),
      key: z.enum(["context_length", "max_input_tokens", "max_output_tokens", "reasoning_efforts"]),
      value: z.union([z.number().int().positive(), uniqueStrings]),
    })
  ),
  gates: z.strictObject({
    emergencyAlertReady: z.boolean(),
    swarmSingleLaneReady: z.boolean(),
    openRouterCapVerified: z.boolean(),
    openRouterDailyCapUsd: z.literal(20),
    openRouterNoTrainModels: uniqueStrings,
  }),
});

export class PolicyError extends Error {}
const fail = (message) => {
  throw new PolicyError(message);
};
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const slug = (value) => typeof value === "string" && /^[a-z][a-z0-9-]{0,70}$/.test(value);
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const list = (value) =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string") &&
  new Set(value).size === value.length;
const fields = (value, allowed, where) => {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    fail(`Invalid fields in ${where}`);
};
export const canonicalIdentity = (identity) => {
  const text = String(identity ?? "")
    .trim()
    .toLowerCase()
    .replace(/@gmail$/, "@gmail.com");
  const [local, domain] = text.split("@");
  return ["gmail.com", "googlemail.com"].includes(domain)
    ? `${local.split("+")[0].replaceAll(".", "")}@gmail.com`
    : text;
};
export const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
}

export function readPolicy(text) {
  let policy;
  try {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) fail("Invalid policy YAML");
    policy = doc.toJS({ maxAliasCount: 0 });
  } catch {
    fail("Invalid policy YAML (duplicates and aliases are not allowed)");
  }
  return validatePolicy(policy);
}

export function validatePolicy(p) {
  // Keep validation diagnostics free of identities or other private policy values.
  if (!policySchema.safeParse(p).success) fail("Invalid policy structure");
  fields(
    p,
    [
      "version",
      "namespace",
      "protectedIdentities",
      "providers",
      "pools",
      "connections",
      "combos",
      "keys",
      "capabilityOverrides",
      "gates",
    ],
    "policy"
  );
  if (p.version !== 1 || p.namespace !== "fleet")
    fail("Expected policy version 1 and namespace fleet");
  for (const key of ["providers", "pools", "combos", "keys"])
    if (!record(p[key])) fail(`Invalid ${key}`);
  for (const key of ["connections", "protectedIdentities", "capabilityOverrides"])
    if (!Array.isArray(p[key])) fail(`Invalid ${key}`);
  if (!p.protectedIdentities.length) fail("Protected identity denylist cannot be empty");
  for (const deny of p.protectedIdentities) {
    fields(deny, ["provider", "identity"], "protected identity");
    if (!slug(deny.provider) || typeof deny.identity !== "string" || !deny.identity.trim())
      fail("Invalid protected identity");
  }
  for (const [name, provider] of Object.entries(p.providers)) {
    fields(provider, ["subscription"], "provider");
    if (!slug(name) || typeof provider.subscription !== "boolean") fail("Invalid provider");
  }
  for (const [name, pool] of Object.entries(p.pools)) {
    fields(pool, ["provider", "label"], "pool");
    if (
      !p.providers[pool.provider] ||
      !["shared", "owner", "swarm", "emergency", "capped"].includes(pool.label) ||
      name !== `${pool.provider}/${pool.label}`
    )
      fail("Invalid pool");
  }
  const bound = new Set();
  for (const c of p.connections) {
    fields(c, ["connectionId", "pool", "identity"], "connection binding");
    if (
      !uuid(c.connectionId) ||
      !p.pools[c.pool] ||
      typeof c.identity !== "string" ||
      !c.identity.trim() ||
      bound.has(c.connectionId)
    )
      fail("Invalid or duplicate connection binding");
    bound.add(c.connectionId);
  }
  for (const [name, combo] of Object.entries(p.combos)) {
    fields(combo, ["strategy", "steps"], "combo");
    if (
      !slug(name) ||
      !["reset-aware", "priority"].includes(combo.strategy) ||
      !Array.isArray(combo.steps) ||
      !combo.steps.length
    )
      fail("Invalid combo");
    for (const step of combo.steps) {
      fields(step, ["pool", "model"], "combo step");
      if (
        !p.pools[step.pool] ||
        typeof step.model !== "string" ||
        !step.model.startsWith(`${p.pools[step.pool].provider}/`) ||
        /[*\s]/.test(step.model)
      )
        fail("Invalid provider-prefixed combo model");
    }
    if (
      combo.steps.some((s) => p.providers[p.pools[s.pool].provider].subscription) &&
      combo.strategy !== "reset-aware"
    )
      fail("Subscription combos require reset-aware strategy");
    // Emergency tier composition requires quota-only fallback plus an alert consumer.
    // Until that integration is implemented, never grant emergency through this sync.
    if (combo.steps.some((s) => p.pools[s.pool].label === "emergency"))
      fail("Emergency activation awaits quota-only fallback and alert integration");
  }
  for (const [name, key] of Object.entries(p.keys)) {
    fields(key, ["enabled", "pools", "combos", "rateLimits", "expiresAt"], "key");
    if (
      !slug(name) ||
      typeof key.enabled !== "boolean" ||
      !list(key.pools) ||
      !key.pools.length ||
      key.pools.some((pool) => !p.pools[pool]) ||
      !list(key.combos) ||
      key.combos.some((combo) => !p.combos[combo])
    )
      fail("Invalid key references");
    if (
      key.expiresAt !== null &&
      (typeof key.expiresAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT.*Z$/.test(key.expiresAt) ||
        !Number.isFinite(Date.parse(key.expiresAt)))
    )
      fail("Invalid key expiry");
    if (!Array.isArray(key.rateLimits) || !key.rateLimits.length)
      fail("Explicit key rate limits are required");
    for (const limit of key.rateLimits) {
      fields(limit, ["limit", "window"], "rate limit");
      if (![limit.limit, limit.window].every((n) => Number.isInteger(n) && n > 0))
        fail("Invalid rate limit");
    }
    if (name !== "owner" && key.combos.some((c) => ["voice", "claude-chat"].includes(c)))
      fail("Owner routes cannot be granted to another key");
    if (
      !["swarm-controller", "swarm-workers"].includes(name) &&
      key.pools.some((pool) => p.pools[pool].label === "emergency")
    )
      fail("Emergency pool is swarm-only");
    if (key.enabled && !key.combos.length) fail("Enabled keys require explicit combos");
    for (const combo of key.combos)
      if (p.combos[combo].steps.some((step) => !key.pools.includes(step.pool)))
        fail("Combo escapes key pools");
  }
  fields(
    p.gates,
    [
      "emergencyAlertReady",
      "swarmSingleLaneReady",
      "openRouterCapVerified",
      "openRouterDailyCapUsd",
      "openRouterNoTrainModels",
    ],
    "gates"
  );
  for (const flag of ["emergencyAlertReady", "swarmSingleLaneReady", "openRouterCapVerified"])
    if (typeof p.gates[flag] !== "boolean") fail("Invalid activation gate");
  if (p.gates.openRouterDailyCapUsd !== 20 || !list(p.gates.openRouterNoTrainModels))
    fail("OpenRouter requires the reviewed $20/day cap and no-train allowlist");
  for (const o of p.capabilityOverrides) {
    fields(o, ["target", "key", "value"], "capability override");
    if (
      typeof o.target !== "string" ||
      !o.target.includes("/") ||
      !["context_length", "max_input_tokens", "max_output_tokens", "reasoning_efforts"].includes(
        o.key
      )
    )
      fail("Invalid capability override");
    if (
      o.key === "reasoning_efforts"
        ? !list(o.value) || !o.value.length
        : !Number.isInteger(o.value) || o.value <= 0
    )
      fail("Invalid capability value");
  }
  return p;
}

export function protectedConnection(p, c) {
  return p.protectedIdentities.some(
    (deny) =>
      deny.provider === c.provider &&
      [c.email, c.name, c.providerSpecificData?.email, c.providerSpecificData?.username]
        .filter(Boolean)
        .some((identity) => canonicalIdentity(identity) === canonicalIdentity(deny.identity))
  );
}

const subset = (actual, desired) =>
  Object.fromEntries(Object.keys(desired).map((key) => [key, actual[key] ?? null]));
export function planPolicy(p, inventory) {
  validatePolicy(p);
  const blockers = [];
  const providers = [];
  const combos = [];
  const keys = [];
  const overrides = [];
  const poolIds = Object.fromEntries(Object.keys(p.pools).map((name) => [name, []]));
  const managed = inventory.keys.filter((k) => k.name.startsWith("fleet:"));
  const keyNames = managed.map((k) => k.name);
  if (new Set(keyNames).size !== keyNames.length) blockers.push("Duplicate managed key names");
  for (const binding of p.connections) {
    const c = inventory.connections.find((item) => item.id === binding.connectionId);
    const pool = p.pools[binding.pool];
    if (
      !c ||
      c.provider !== pool.provider ||
      !c.email ||
      canonicalIdentity(c.email) !== canonicalIdentity(binding.identity)
    ) {
      blockers.push("Connection identity/provider binding mismatch");
      continue;
    }
    if (protectedConnection(p, c)) {
      blockers.push("Protected identity: grant refused");
      continue;
    }
    const body = { group: pool.label };
    if (c.provider === "claude") body.providerSpecificData = { blockExtraUsage: true };
    if (
      c.group !== body.group ||
      (c.provider === "claude" && c.providerSpecificData?.blockExtraUsage !== true)
    ) {
      providers.push({ id: c.id, body });
    }
    if (c.isActive === true) poolIds[binding.pool].push(c.id);
  }
  // Enforce the Claude spending flag even on unbound accounts; never grant them.
  for (const c of inventory.connections.filter((c) => c.provider === "claude")) {
    if (
      c.providerSpecificData?.blockExtraUsage !== true &&
      !providers.some((item) => item.id === c.id)
    ) {
      providers.push({
        id: c.id,
        body: { providerSpecificData: { blockExtraUsage: true } },
      });
    }
  }
  for (const [name, combo] of Object.entries(p.combos)) {
    const needed = Object.values(p.keys).some((k) => k.enabled && k.combos.includes(name));
    if (!needed) continue;
    const models = [];
    for (const step of combo.steps) {
      const ids = poolIds[step.pool].sort();
      if (!ids.length) {
        blockers.push(`Combo ${name}: required pool is empty`);
        continue;
      }
      if (
        p.pools[step.pool].provider === "openrouter" &&
        (!p.gates.openRouterCapVerified || !p.gates.openRouterNoTrainModels.includes(step.model))
      )
        blockers.push("OpenRouter cap/no-train gate not satisfied");
      for (const connectionId of ids)
        models.push({ kind: "model", model: step.model, connectionId });
    }
    const body = { name: `fleet-${name}`, strategy: combo.strategy, models };
    const matches = inventory.combos.filter((c) => c.name === body.name);
    if (matches.length > 1) blockers.push("Duplicate managed combo names");
    const existing = matches[0];
    const current = existing && {
      name: existing.name,
      strategy: existing.strategy,
      models: existing.models.map((s) => ({
        kind: s.kind,
        model: s.model,
        connectionId: s.connectionId,
      })),
    };
    if (!same(current, body)) combos.push({ id: existing?.id, body });
  }
  for (const [name, k] of Object.entries(p.keys)) {
    const existing = managed.find((item) => item.name === `fleet:${name}`);
    if (!k.enabled) {
      if (existing?.isActive) keys.push({ id: existing.id, name, body: { isActive: false } });
      continue;
    }
    if (name.startsWith("swarm-") && !p.gates.swarmSingleLaneReady)
      blockers.push("Swarm one-lane scheduler gate not satisfied");
    const ids = [...new Set(k.pools.flatMap((pool) => poolIds[pool]))].sort();
    if (k.pools.some((pool) => !poolIds[pool].length))
      blockers.push(`Key ${name}: required pool is empty`);
    if (k.pools.some((pool) => p.pools[pool].label === "emergency"))
      blockers.push("Emergency activation awaits quota-only fallback and alert integration");
    const body = {
      name: `fleet:${name}`,
      isActive: true,
      modelAccessMode: "restricted",
      allowedModels: k.combos.map((c) => `fleet-${c}`).sort(),
      allowedCombos: k.combos.map((c) => `fleet-${c}`).sort(),
      allowedConnections: ids,
      rateLimits: k.rateLimits,
      expiresAt: k.expiresAt,
      scopes: [],
      allowAutoCombos: false,
      catalogScope: "combos",
    };
    if (!existing || !same(subset(existing, body), body))
      keys.push({ id: existing?.id, name, body });
  }
  for (const k of managed)
    if (!p.keys[k.name.slice(6)] && k.isActive)
      keys.push({ id: k.id, name: k.name.slice(6), body: { isActive: false } });
  for (const o of p.capabilityOverrides) {
    const existing = inventory.overrides.find((v) => v.target === o.target && v.key === o.key);
    if (!existing || !same(existing.value, o.value))
      overrides.push({
        body: {
          ...o,
          value: o.key === "reasoning_efforts" ? o.value.join(",") : o.value,
        },
      });
  }
  return {
    blockers: [...new Set(blockers)],
    providers,
    combos,
    keys,
    overrides,
    managed,
    changed: providers.length + combos.length + keys.length + overrides.length > 0,
  };
}

export async function inventory(client) {
  const [providers, keys, combos, overrides] = await Promise.all([
    client("/api/providers"),
    client("/api/keys"),
    client("/api/combos?limit=100"),
    client("/api/model-capability-overrides"),
  ]);
  if (
    !Array.isArray(providers.connections) ||
    !Array.isArray(keys.keys) ||
    !Array.isArray(combos.combos) ||
    !Array.isArray(overrides.overrides)
  )
    fail("Unexpected upstream inventory response");
  if (
    combos.total > combos.combos.length ||
    providers.total > providers.connections.length ||
    keys.total > keys.keys.length
  )
    fail("Inventory was truncated; no policy writes are safe");
  return {
    connections: providers.connections,
    keys: keys.keys,
    combos: combos.combos,
    overrides: overrides.overrides,
  };
}

export async function syncPolicy(p, client, { dryRun = true, saveKey = async () => {} } = {}) {
  let current = await inventory(client);
  const plan = planPolicy(p, current);
  const report = {
    blockers: plan.blockers,
    changed: plan.changed,
    changes: {
      providers: plan.providers.length,
      combos: plan.combos.length,
      keys: plan.keys.length,
      capabilityOverrides: plan.overrides.length,
    },
  };
  if (dryRun) return report;
  if (!plan.changed && !plan.blockers.length) return report;
  // Disable all managed keys before changing shared routing state. Never widen first.
  try {
    for (const key of plan.managed.filter((k) => k.isActive))
      await client(`/api/keys/${key.id}`, "PATCH", { isActive: false });
    const disabled = await inventory(client);
    if (disabled.keys.some((k) => k.name.startsWith("fleet:") && k.isActive))
      fail("Managed keys remain active");
  } catch {
    fail("Cannot verify managed-key shutdown; stop fleet traffic before retrying");
  }
  if (plan.blockers.length)
    fail("Policy blocked; managed keys disabled. Run --dry-run for redacted reasons.");
  const created = [];
  try {
    for (const op of plan.providers) await client(`/api/providers/${op.id}`, "PUT", op.body);
    for (const op of plan.combos)
      await client(`/api/combos${op.id ? `/${op.id}` : ""}`, op.id ? "PUT" : "POST", op.body);
    for (const op of plan.overrides)
      await client("/api/model-capability-overrides", "PATCH", op.body);
    // Rediscover after provider/combo writes; refuse inventory races before activation.
    current = await inventory(client);
    let next = planPolicy(p, current);
    if (
      next.blockers.length ||
      next.providers.length ||
      next.combos.length ||
      next.overrides.length
    )
      fail("Inventory changed or routing writes did not converge");
    for (const op of next.keys) {
      if (op.id)
        await client(`/api/keys/${op.id}`, "PATCH", {
          ...op.body,
          isActive: false,
        });
      else {
        // POST cannot set isActive. An expired key is inert until final activation.
        const result = await client("/api/keys", "POST", {
          ...op.body,
          expiresAt: "2000-01-01T00:00:00.000Z",
        });
        if (!uuid(result.id) || typeof result.key !== "string")
          fail("Unexpected key creation response");
        created.push(result.id);
        await saveKey(op.name, result.key);
        await client(`/api/keys/${result.id}`, "PATCH", {
          ...op.body,
          isActive: false,
        });
      }
    }
    current = await inventory(client);
    next = planPolicy(p, current);
    if (
      next.blockers.length ||
      next.providers.length ||
      next.combos.length ||
      next.overrides.length
    )
      fail("Inventory changed before activation");
    for (const op of next.keys) {
      if (!op.id) fail("Key state changed before activation");
      if (op.body.isActive) await client(`/api/keys/${op.id}`, "PATCH", op.body);
    }
    const final = planPolicy(p, await inventory(client));
    if (final.changed || final.blockers.length) fail("Policy read-back verification failed");
    return { ...report, applied: true };
  } catch (error) {
    // Best effort re-disable every known managed key; surface cleanup failure explicitly.
    const known = new Set([
      ...plan.managed.map((k) => k.id),
      ...current.keys.filter((k) => k.name.startsWith("fleet:")).map((k) => k.id),
      ...created,
    ]);
    const results = await Promise.allSettled(
      [...known].map((id) => client(`/api/keys/${id}`, "PATCH", { isActive: false }))
    );
    if (results.some((r) => r.status === "rejected"))
      fail("Sync failed and key shutdown could not be verified; stop fleet traffic immediately");
    throw error;
  }
}
