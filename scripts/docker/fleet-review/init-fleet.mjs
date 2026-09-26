#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { buildConfig } from "./build-config.mjs";

/** Create fresh instance secrets once. Never rotate an existing database's keys. */
export function initFleet(destination = ".env.fleet") {
  if (!z.string().min(1).safeParse(destination).success)
    throw new Error("Configuration destination must be a nonempty path");
  const config = buildConfig();
  const secret = () => randomBytes(32).toString("hex");
  const content = [
    "# Private instance configuration. Back up with the router data volume.",
    "# Never include this file in a shared image, Git commit, or support log.",
    "COMPOSE_PROJECT_NAME=omniroute-fleet",
    `OMNIROUTE_IMAGE=${config.image}:${config.FLEET_VERSION}-local`,
    "FLEET_PORT=21128",
    "FLEET_MEMORY_LIMIT=3g",
    "FLEET_HEAP_MB=2048",
    ...["JWT_SECRET", "API_KEY_SECRET", "STORAGE_ENCRYPTION_KEY", "INITIAL_PASSWORD"].map(
      (key) => `${key}=${secret()}`
    ),
    "",
  ].join("\n");
  writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error("usage");
    initFleet(process.argv[2]);
    console.log("Created private fleet configuration. Open it locally for the dashboard password.");
  } catch (error) {
    console.error(
      error.code === "EEXIST"
        ? "Configuration already exists; preserved all existing secrets."
        : "Could not create configuration. Usage: node scripts/docker/fleet-review/init-fleet.mjs [file]"
    );
    process.exitCode = 1;
  }
}
