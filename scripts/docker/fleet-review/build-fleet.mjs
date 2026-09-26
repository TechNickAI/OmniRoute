#!/usr/bin/env node

// Only a verified public upstream checkout is sent to Docker. No fleet runtime files.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { buildConfig } from "./build-config.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed`);
  return result.stdout?.trim();
}

export function assertExternal(checkout, scratch) {
  const path = relative(realpathSync(checkout), realpathSync(scratch));
  if (!path || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))) {
    throw new Error("Build scratch directory must be outside the fleet checkout");
  }
}

export function checkoutUpstream(config, destination, command = run) {
  command("git", ["init", "--quiet", destination], root);
  command(
    "git",
    [
      "-c",
      "credential.helper=",
      "fetch",
      "--quiet",
      "--depth=1",
      `https://github.com/${config.UPSTREAM_REPO}.git`,
      config.UPSTREAM_SHA,
    ],
    destination
  );
  const actual = command("git", ["rev-parse", "FETCH_HEAD^{commit}"], destination, true);
  if (actual !== config.UPSTREAM_SHA) throw new Error("Fetched upstream commit does not match pin");
  command(
    "git",
    ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", actual],
    destination
  );
}

export function dockerArguments(config, context, revision, env = process.env) {
  if (
    !z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .safeParse(revision).success
  )
    throw new Error("Fleet revision must be a full commit SHA");
  const platform = env.FLEET_PLATFORM ?? `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`;
  if (!z.enum(["linux/amd64", "linux/arm64"]).safeParse(platform).success)
    throw new Error("Use one native Linux platform per build");
  const memory = env.FLEET_BUILD_MEMORY_MB ?? "8192";
  if (
    !z
      .string()
      .regex(/^[1-9][0-9]{3,4}$/)
      .safeParse(memory).success
  )
    throw new Error("Invalid build heap size");
  const tag = `${config.image}:${config.FLEET_VERSION}-local`;
  return [
    "buildx",
    "build",
    "--load",
    "--progress=plain",
    "--target",
    "runner-base",
    "--platform",
    platform,
    "--tag",
    tag,
    "--build-arg",
    "OMNIROUTE_USE_TURBOPACK=0",
    "--build-arg",
    `OMNIROUTE_BUILD_MEMORY_MB=${memory}`,
    "--build-arg",
    "OMNIROUTE_BUILD_WORKERS=2",
    ...Object.entries({
      "org.opencontainers.image.title": "OmniRoute Fleet",
      "org.opencontainers.image.description":
        "Agent fleet router, built from pinned upstream source",
      "org.opencontainers.image.url": `https://github.com/${config.FLEET_REPO}`,
      "org.opencontainers.image.source": `https://github.com/${config.FLEET_REPO}`,
      "org.opencontainers.image.revision": revision,
      "org.opencontainers.image.version": config.FLEET_VERSION,
      "io.omniroute.fleet.upstream.repository": `https://github.com/${config.UPSTREAM_REPO}`,
      "io.omniroute.fleet.upstream.revision": config.UPSTREAM_SHA,
    }).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    context,
  ];
}

export function buildFleet(env = process.env) {
  const config = buildConfig(env);
  const revision = run("git", ["rev-parse", "HEAD"], root, true);
  // Validate every build parameter before making a network request.
  dockerArguments(config, "validation", revision, env);
  const scratch = mkdtempSync(join(tmpdir(), "omniroute-upstream-"));
  try {
    assertExternal(root, scratch);
    const context = join(scratch, "source");
    checkoutUpstream(config, context);
    run("docker", dockerArguments(config, context, revision, env), root);
    console.log(
      `Built ${config.image}:${config.FLEET_VERSION}-local from ${config.UPSTREAM_REPO}@${config.UPSTREAM_SHA}`
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2)
      throw new Error("Usage: node scripts/docker/fleet-review/build-fleet.mjs");
    buildFleet();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
