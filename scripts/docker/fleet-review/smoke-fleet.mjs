#!/usr/bin/env node

// Exercises a built image with throwaway state. Never calls an LLM provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { smokePolicy } from "./smoke-policy.mjs";

const image = process.argv[2] || "ghcr.io/deepgem-interactive/omniroute-fleet:3.8.51-fleet.1-local";
const name = `omniroute-smoke-${randomBytes(6).toString("hex")}`;
const volume = `${name}-data`;
const temp = mkdtempSync(join(tmpdir(), "omniroute-smoke-"));
const envFile = join(temp, "runtime.env");
const password = randomBytes(32).toString("hex");
writeFileSync(
  envFile,
  [
    `INITIAL_PASSWORD=${password}`,
    ...["JWT_SECRET", "API_KEY_SECRET", "STORAGE_ENCRYPTION_KEY"].map(
      (key) => `${key}=${randomBytes(32).toString("hex")}`
    ),
    "REQUIRE_API_KEY=true",
    "DATA_DIR=/app/data",
    "APP_LOG_TO_FILE=false",
    "NEXT_TELEMETRY_DISABLED=1",
    "CLAUDE_CC_ENTRYPOINT=sdk-cli",
    "PORT=20128",
    "DASHBOARD_PORT=20128",
    "API_PORT=20128",
    "OMNIROUTE_HOSTNAME=0.0.0.0",
    "",
  ].join("\n"),
  { mode: 0o600 }
);

function docker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 180_000,
  });
  if (result.error || result.status !== 0) {
    // Arguments contain only generated resource names/paths, never secrets.
    throw new Error(`Docker ${args[0]} failed (exit ${result.status ?? "timeout"})`);
  }
  return result.stdout.trim();
}

async function start() {
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--env-file",
    envFile,
    "-p",
    "127.0.0.1::20128",
    "-v",
    `${volume}:/app/data`,
    image,
  ]);
  const port = docker(["port", name, "20128/tcp"]).split(":").at(-1);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`, {
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok) return url;
    } catch {
      // The socket need not be listening yet during first-run migrations.
    }
    await delay(1000);
  }
  throw new Error("Container did not become ready within 120 seconds");
}

async function request(url, path, options = {}) {
  return fetch(`${url}${path}`, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
}

async function login(url) {
  const response = await request(url, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200, "generated dashboard password must work");
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("auth_token="));
  assert.ok(cookie, "login must set an auth cookie");
  return cookie.split(";")[0];
}

try {
  docker(["volume", "create", volume]);
  let url = await start();
  console.log("PASS: fresh container boots with isolated state");
  assert.notEqual(docker(["exec", name, "id", "-u"]), "0");
  assert.equal((await request(url, "/v1/models")).status, 401);
  assert.ok([401, 403].includes((await request(url, "/api/keys")).status));
  console.log("PASS: non-root runtime, inference and management authentication");

  const cookie = await login(url);
  const diagnosis = await request(url, "/api/db/health", {
    headers: { Cookie: cookie },
  });
  assert.equal(diagnosis.status, 200);
  const health = await diagnosis.json();
  assert.equal(health.driver?.degraded, false, "database must be durable");
  assert.ok(["better-sqlite3", "node:sqlite"].includes(health.driver?.name));
  console.log(`PASS: compiled server uses native SQLite (${health.driver.name})`);

  const created = await request(url, "/api/keys", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "fleet-smoke" }),
  });
  assert.equal(created.status, 201);
  const { key } = await created.json();
  assert.equal(typeof key, "string", "key creation must return a usable secret");
  assert.ok(key.length > 0);
  const clientHeaders = { Authorization: `Bearer ${key}` };
  assert.equal((await request(url, "/v1/models", { headers: clientHeaders })).status, 200);
  assert.ok(
    [401, 403].includes((await request(url, "/api/keys", { headers: clientHeaders })).status)
  );
  console.log("PASS: endpoint key works for inference and cannot administer keys");

  docker(["stop", "--time", "45", name]);
  docker(["rm", name]);
  url = await start();
  await login(url);
  assert.equal((await request(url, "/v1/models", { headers: clientHeaders })).status, 200);
  console.log("PASS: password, database and endpoint key survive container replacement");
  await smokePolicy({ url, password, docker, name });
} finally {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 });
  spawnSync("docker", ["volume", "rm", volume], {
    stdio: "ignore",
    timeout: 30_000,
  });
  rmSync(temp, { recursive: true, force: true });
}
