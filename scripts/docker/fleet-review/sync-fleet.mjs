#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { assertExternal } from "./build-fleet.mjs";
import { PolicyError, readPolicy, syncPolicy } from "./fleet-policy.mjs";

export async function managementClient(url, password) {
  if (!z.string().url().safeParse(url).success || !z.string().min(1).safeParse(password).success)
    throw new PolicyError("Management URL and password are required");
  const base = new URL(url);
  if (
    base.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  ) {
    throw new PolicyError(
      "Policy sync connects only to a local HTTP loopback router; run it on the fleet host"
    );
  }
  const login = await fetch(new URL("/api/auth/login", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!login.ok) throw new PolicyError("Fleet management login failed");
  const cookie = login.headers
    .getSetCookie()
    .find((item) => item.startsWith("auth_token="))
    ?.split(";")[0];
  if (!cookie) throw new PolicyError("Fleet management login did not set a session");
  return async (path, method = "GET", body) => {
    const response = await fetch(new URL(path, base), {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!response.ok)
      throw new PolicyError(
        `Management ${method} failed with HTTP ${response.status}; response body withheld`
      );
    return response.json();
  };
}

function privateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (process.platform !== "win32" && stat.mode & 0o077))
    throw new PolicyError("Runtime secret file must be a regular private (0600) file");
  return readFileSync(path, "utf8");
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      policy: { type: "string", default: "fleet-policy.yaml" },
      url: { type: "string", default: "http://127.0.0.1:21128" },
      "runtime-file": { type: "string", default: ".env.fleet" },
      "state-dir": { type: "string" },
      "dry-run": { type: "boolean" },
      apply: { type: "boolean" },
      validate: { type: "boolean" },
    },
  });
  const options = z
    .object({
      policy: z.string().min(1),
      url: z.string().url(),
      "runtime-file": z.string().min(1),
      "state-dir": z.string().min(1).optional(),
      "dry-run": z.boolean().optional(),
      apply: z.boolean().optional(),
      validate: z.boolean().optional(),
    })
    .strict();
  if (!options.safeParse(values).success) throw new PolicyError("Invalid policy sync options");
  if ([values.apply, values["dry-run"], values.validate].filter(Boolean).length > 1)
    throw new PolicyError("Choose --validate, --dry-run or --apply");
  const content = readFileSync(values.policy, "utf8");
  const policy = readPolicy(content);
  const hash = createHash("sha256").update(content).digest("hex");
  if (values.validate) {
    console.log(JSON.stringify({ valid: true, policyHash: hash }));
    return 0;
  }
  const runtime = privateFile(values["runtime-file"]);
  const password = runtime.match(/^INITIAL_PASSWORD=([^\r\n]+)$/m)?.[1];
  if (!password) throw new PolicyError("Runtime file lacks INITIAL_PASSWORD");
  let lock;
  let state;
  try {
    if (values.apply) {
      state = resolve(values["state-dir"] ?? join(homedir(), ".local/state/omniroute-fleet"));
      mkdirSync(state, { recursive: true, mode: 0o700 });
      if (lstatSync(state).isSymbolicLink())
        throw new PolicyError("State directory cannot be a symlink");
      assertExternal(fileURLToPath(new URL("../../../", import.meta.url)), state);
      chmodSync(state, 0o700);
      const candidate = join(state, "sync.lock");
      mkdirSync(candidate, { mode: 0o700 });
      lock = candidate;
    }
    const client = await managementClient(values.url, password);
    const result = await syncPolicy(policy, client, {
      dryRun: !values.apply,
      saveKey: async (name, key) => {
        // Unique files preserve previously issued secrets after recovery/re-creation.
        writeFileSync(join(state, `${name}-${randomBytes(8).toString("hex")}.key`), key + "\n", {
          flag: "wx",
          mode: 0o600,
        });
      },
    });
    if (values.apply && !result.blockers.length) {
      const temp = join(state, `policy-${randomBytes(8).toString("hex")}.json`);
      writeFileSync(
        temp,
        JSON.stringify({
          policyHash: hash,
          appliedAt: new Date().toISOString(),
        }) + "\n",
        { flag: "wx", mode: 0o600 }
      );
      renameSync(temp, join(state, "policy.json"));
    }
    console.log(JSON.stringify({ policyHash: hash, ...result }, null, 2));
    return result.blockers.length ? 1 : !values.apply && result.changed ? 2 : 0;
  } finally {
    if (lock) rmSync(lock, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      error instanceof PolicyError
        ? error.message
        : "Policy sync failed; no credentials or upstream response bodies were logged"
    );
    process.exitCode = 1;
  }
}
