import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildConfig } from "../../scripts/docker/fleet-review/build-config.mjs";
import {
  assertExternal,
  checkoutUpstream,
  dockerArguments,
} from "../../scripts/docker/fleet-review/build-fleet.mjs";

test("build pin rejects floating refs, credentials and injected registry components", () => {
  for (const UPSTREAM_SHA of ["main", "486509c7", "", "a".repeat(39), "a".repeat(41)]) {
    assert.throws(() => buildConfig({ UPSTREAM_SHA }));
  }
  for (const UPSTREAM_REPO of [
    "https://user:secret@github.com/a/b",
    "../b",
    "a/b\nsecret",
    "a/b;echo",
  ]) {
    assert.throws(() => buildConfig({ UPSTREAM_REPO }));
  }
  assert.throws(() => buildConfig({ GHCR_NAMESPACE: "UpperCase-Registry" }));
  assert.throws(() => buildConfig({ FLEET_VERSION: "$(hostname)" }));
});

test("mismatched fetched commit fails before checkout or Docker", () => {
  const calls = [];
  assert.throws(
    () =>
      checkoutUpstream(buildConfig({}), "/unused", (command, args) => {
        calls.push([command, args]);
        return args[0] === "rev-parse" ? "0".repeat(40) : "";
      }),
    /does not match/
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1][1].at(-1), buildConfig({}).UPSTREAM_SHA);
});

test("verified checkout uses detached exact SHA without branch tracking", () => {
  const config = buildConfig({});
  const calls = [];
  checkoutUpstream(config, "/unused", (_command, args) => {
    calls.push(args);
    return config.UPSTREAM_SHA;
  });
  assert.deepEqual(calls.at(-1).slice(-2), ["--detach", config.UPSTREAM_SHA]);
});

test("build args identify fleet packaging and upstream independently and contain no runtime secrets", () => {
  const config = buildConfig({
    FLEET_REPO: "another/fleet",
    GHCR_NAMESPACE: "another",
    FLEET_VERSION: "candidate.2",
  });
  const args = dockerArguments(config, "/tmp/source", "a".repeat(40), {
    FLEET_PLATFORM: "linux/arm64",
    JWT_SECRET: "private-value",
    INITIAL_PASSWORD: "private-value",
  });
  assert.ok(args.includes("ghcr.io/another/omniroute-fleet:candidate.2-local"));
  assert.ok(args.includes("org.opencontainers.image.source=https://github.com/another/fleet"));
  assert.ok(args.includes(`io.omniroute.fleet.upstream.revision=${config.UPSTREAM_SHA}`));
  assert.equal(args.at(-1), "/tmp/source");
  assert.ok(!args.join(" ").includes("private-value"));
  assert.ok(!args.includes("--push"));
});

test("scratch rejects the checkout, descendants and symlink aliases", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "fleet-path-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo");
  const child = join(repo, "scratch");
  mkdirSync(child, { recursive: true });
  symlinkSync(child, join(temp, "alias"));
  assert.throws(() => assertExternal(repo, repo));
  assert.throws(() => assertExternal(repo, child));
  assert.throws(() => assertExternal(repo, join(temp, "alias")));
  assert.doesNotThrow(() => assertExternal(repo, temp));
});
