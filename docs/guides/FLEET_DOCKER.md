---
title: "Fleet Docker review toolkit"
---

# Fleet Docker review toolkit

The optional toolkit in `scripts/docker/fleet-review/` builds a pinned OmniRoute image,
starts an isolated router and Redis, and reconciles pool access through the existing
management API. It does not change the application, its default Compose setup, or CI.
The example policy contains synthetic identities, no provider connections, and disabled keys.

## Build and start locally

Use a supported Node version, Git, Docker with Buildx, and Docker Compose. From the repository root:

```bash
npm ci --prefix scripts/docker/fleet-review --ignore-scripts
cd scripts/docker/fleet-review
node sync-fleet.mjs --policy fleet-policy.example.yaml --validate
node build-fleet.mjs
node init-fleet.mjs
docker compose --env-file .env.fleet -f docker-compose.fleet.yml up -d --wait
```

The build fetches `TechNickAI/OmniRoute` at
`486509c71b9890914d78cf2c83a22f967fbb635e` into a temporary directory outside the
checkout and verifies the commit before building `runner-base`. Only that fetched source
is the Docker build context. The command loads an image locally; it does not publish it.
Build resource requirements are described in the [Docker Guide](DOCKER_GUIDE.md#build-time-resources).

`build-config.json` defines the upstream repository and SHA, packaging repository,
registry namespace, image name, and version. Environment variables with the same names
override those defaults. The default local tag is
`ghcr.io/deepgem-interactive/omniroute-fleet:3.8.51-fleet.1-local`; this name does not
imply registry access or an existing published image. If you override the build tag,
update the image setting in your private runtime file to match.

The dashboard and API bind to `127.0.0.1:21128`; the OAuth callback binds to
`127.0.0.1:1455`. Redis has no published port. Each service has a separate named volume.
The default project name is `omniroute-fleet`; choose another project name and API port
in the runtime file when running multiple review stacks. The fixed callback port must
also be available. The default memory limits are suitable for review; size a deployment
for its request workload using the [Docker memory guidance](DOCKER_GUIDE.md#runtime-ram-for-coding-agents).

`init-fleet.mjs` creates `.env.fleet` with mode `0600`, fresh instance secrets, and a
dashboard password. It refuses to overwrite an existing file. Read the password locally;
do not paste the file into a PR, support log, or image. Preserve the original encryption
secret with the database through every container replacement.

## Review and apply policy

Copy `fleet-policy.example.yaml` to a private path outside the whole repository before
adding real identities or connection bindings. Keep provider authorization separate:
sync neither signs accounts in nor imports credentials. The example keys are `owner`,
`observer`, `swarm-controller`, and `swarm-workers`; all start disabled.

From the toolkit directory, inspect the example against the running empty router:

```bash
node sync-fleet.mjs --policy fleet-policy.example.yaml --dry-run
```

For an operator-maintained policy, pass its absolute path with `--policy`. `--validate`
checks syntax and policy rules without contacting the router. `--dry-run` is read-only:
exit `0` means no drift, `2` means changes are needed, and `1` means validation, policy,
or operational failure. The default endpoint is `http://127.0.0.1:21128`; `--url` accepts
only local HTTP loopback addresses. `--runtime-file` selects the private runtime file.

The protected-identity denylist is provider-qualified and prevents a matched identity
from receiving access through any managed key. Connection bindings require the actual
connection ID and matching provider identity. Enabled keys receive explicit connection
allowlists, combo restrictions, and rate limits; an empty required pool blocks activation.
Treat the sample policy as an operator-reviewed starting point, not automatic account discovery.

Drain clients before using `--apply`. Sync requires dashboard management authority and
can change provider grouping, combos, capability overrides, and every key it manages under
the `fleet:` prefix. It also sets `blockExtraUsage` on all Claude connections, including
connections outside the requested pools. Apply disables managed keys before changes,
checks inventory again, and verifies the resulting state before completing activation.
On failure it attempts to disable managed keys; if shutdown cannot be verified, stop
traffic and investigate before retrying.

Apply writes generated key files with mode `0600` into a mode `0700` directory outside
the checkout. Use `--state-dir` to choose that directory; the default is
`~/.local/state/omniroute-fleet`. Keep those
files private and distribute only the intended endpoint key to each agent.

Emergency access remains blocked: per-use alerting is not implemented by this toolkit.
Paid-provider budget enforcement and no-training guarantees are not supplied by policy
sync; a configuration declaration is not evidence that either is enforced.

## Tests and smoke checks

From the repository root:

```bash
node --test tests/unit/fleet-*.test.mjs
```

From the toolkit directory, after building the image:

```bash
node smoke-fleet.mjs
```

An optional image argument selects another local build. The smoke uses disposable
containers and volumes and synthetic connection records without provider credentials.
It checks fresh startup, non-root execution and authentication, the native SQLite module,
endpoint-key isolation from management, state survival across container replacement,
empty-policy reconciliation, key restrictions and repeat-sync behavior, and protected
identity shutdown. It sends no inference requests to a provider.

## Back up outside the checkout

Backups contain credentials and must never live under the repository, a worktree, or the
toolkit directory. Choose a private destination outside all checkouts with directory
mode `0700` and file mode `0600`; apply the same rule to temporary backup archives.

1. Drain clients, then stop this stack's `omniroute` and `redis` services using this
   toolkit's Compose file and runtime file. Wait for graceful shutdown before copying data.
2. Archive both named volumes into the external destination. With the default project
   name they are `omniroute-fleet_router-data` and `omniroute-fleet_limiter-data`.
   Verify the actual volume names if you changed the project name.
3. Save the matching `.env.fleet`, private policy, and policy-sync state directory in the
   same protected backup set. A database backup without its encryption secret is incomplete.
4. Restart this stack, then verify readiness. Test restoration into separate disposable
   volumes before relying on a backup. Encrypt backup sets before sending them offsite.

Do not use `docker compose down -v` for routine updates: it deletes the persistent volumes.
Keep one router process per SQLite volume; see the
[single-replica constraints](DOCKER_GUIDE.md#availability-default-sqlite-is-single-replica).
