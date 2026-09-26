import { readFileSync } from "node:fs";
import { z } from "zod";

const defaults = JSON.parse(readFileSync(new URL("./build-config.json", import.meta.url), "utf8"));

export function buildConfig(env = process.env) {
  const config = Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, env[key] ?? value])
  );
  for (const key of ["UPSTREAM_REPO", "FLEET_REPO"]) {
    if (
      !z
        .string()
        .regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/)
        .safeParse(config[key]).success
    ) {
      throw new Error(`${key} must be a GitHub owner/repository, without credentials or a URL`);
    }
  }
  if (
    !z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .safeParse(config.UPSTREAM_SHA).success
  ) {
    throw new Error("UPSTREAM_SHA must be a full lowercase 40-character commit SHA");
  }
  for (const key of ["GHCR_NAMESPACE", "IMAGE_NAME"]) {
    if (
      !z
        .string()
        .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
        .safeParse(config[key]).success
    ) {
      throw new Error(`${key} must be a lowercase registry component`);
    }
  }
  if (
    !z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,70}$/)
      .safeParse(config.FLEET_VERSION).success
  ) {
    throw new Error("FLEET_VERSION must be a lowercase Docker tag component (max 71 characters)");
  }
  return {
    ...config,
    image: `ghcr.io/${config.GHCR_NAMESPACE}/${config.IMAGE_NAME}`,
  };
}
