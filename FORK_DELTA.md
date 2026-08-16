# Fork delta — TechNickAI/OmniRoute

This fork exists to carry **one** deliberate change against upstream
`diegosouzapw/OmniRoute`. Everything else should be upstream or on its way there.

Base: `upstream/release/v3.8.50`

## The one delta: `CLAUDE_CC_ENTRYPOINT`

| | |
|---|---|
| Commits | `feat(claude): configurable OAuth billing entrypoint`, `test(claude): align entrypoint patch with current client version`, `fix(claude): scope entrypoint override to OAuth wire identity`, `docs: document CLAUDE_CC_ENTRYPOINT` |
| Files | `open-sse/config/anthropicHeaders.ts`, `open-sse/executors/base.ts`, `open-sse/executors/claudeIdentity.ts`, `src/lib/oauth/providers/claude.ts`, `.env.example`, `docs/reference/ENVIRONMENT.md`, `tests/unit/claude-entrypoint.test.ts` |
| Why not upstream | Owner-specific Claude OAuth billing identity. Not submitted by choice, not because it was rejected. |
| Removal condition | Drop if upstream ships a configurable OAuth entrypoint, or if we stop routing Claude OAuth traffic through this fork. |
| Tests | `tests/unit/claude-entrypoint.test.ts` — 5 passing |

## Submitted upstream (remove from the fork once merged)

| PR | Title | Status |
|---|---|---|
| [#10558](https://github.com/diegosouzapw/OmniRoute/pull/10558) | Database settings page returns HTTP 500 when SQLite lacks the optional dbstat table | OPEN |
| [#10559](https://github.com/diegosouzapw/OmniRoute/pull/10559) | Compression telemetry retention has never deleted a row (same unit bug as #9625) | OPEN |

When either merges, rebase onto the new upstream tag and drop the local copy.
Verify by file content, not by `git cherry` — patch-id heuristics are unreliable
after a rebase and have reported both false positives and false negatives here.

## Removed in this cleanup

- `ci: restore the standalone artifact build` + `ci: keep fork deployment automation in
  omniroute-ops` — an add/delete pair that cancelled to a byte-identical tree. Deploy CI
  now lives in `TechNickAI/omniroute-ops` (`standalone-build.yml`, takes a `ref` input).

## Rules

1. New fork work starts from the upstream **release tag**, never `main`.
2. Every delta needs a written removal condition (this file).
3. Anything generally useful goes upstream first; the fork carries it only until it merges.
4. Deploy/CI automation belongs in `omniroute-ops`, not in this tree.
