/**
 * Bench an OAuth connection whose login has been revoked upstream.
 *
 * Codex answers a revoked login with `401 Encountered invalidated oauth token for user` while the
 * stored access token is still inside its expiry window. resolveTerminalConnectionStatus() would
 * park a 401 as `expired`, but markAccountUnavailable() deliberately un-parks any 401 whose token
 * has not expired yet (a post-refresh race must not take a good account down), so a revoked login
 * only ever gets the ≤2 min oauthAuthFailureBackoff cooldown and is re-selected forever.
 * Measured: one revoked Codex connection served 3,159 401s over 5.5 days at 9-11% of Codex
 * attempts, each costing a failover, until a human replaced it.
 *
 * This keeps a per-connection streak of CONSECUTIVE revoked-token 401s. At the threshold the caller
 * parks the connection as `expired` (excluded from selection, still eligible for the token-health
 * refresh sweep) and raises one loud alert. Any other outcome on the connection (an ordinary 401,
 * a 429, a 5xx, or a success via clearAccountError) resets the streak, so a single transient 401
 * never benches anything.
 */

/** Upstream bodies that mean "this login was revoked", not "this token needs a refresh". */
const REVOKED_OAUTH_SIGNALS = [/\binvalidated oauth token\b/i];

const DEFAULT_THRESHOLD = 3;

function threshold(): number {
  const raw = Number(process.env.OMNIROUTE_REVOKED_OAUTH_BENCH_THRESHOLD);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_THRESHOLD;
}

const streaks = new Map<string, number>();

export function isRevokedOAuthLogin(status: number, errorText: string): boolean {
  if (status !== 401) return false;
  const text = String(errorText || "");
  return REVOKED_OAUTH_SIGNALS.some((pattern) => pattern.test(text));
}

export interface RevokedOAuthVerdict {
  /** Consecutive revoked-token 401s on this connection, including this one. 0 = streak reset. */
  streak: number;
  /** True when this failure reaches the threshold: park the connection. */
  bench: boolean;
  /** True only on the failure that first reaches the threshold: raise the one alert. */
  alert: boolean;
}

/** Record one failure outcome for an OAuth connection and say whether to bench it. */
export function recordFailure(
  connectionId: string,
  status: number,
  errorText: string,
  authType: string | null | undefined
): RevokedOAuthVerdict {
  if (authType !== "oauth" || !isRevokedOAuthLogin(status, errorText)) {
    streaks.delete(connectionId);
    return { streak: 0, bench: false, alert: false };
  }
  const streak = (streaks.get(connectionId) ?? 0) + 1;
  streaks.set(connectionId, streak);
  const limit = threshold();
  return { streak, bench: streak >= limit, alert: streak === limit };
}

/** A success (or operator re-auth) ends the streak. */
export function resetStreak(connectionId: string): void {
  streaks.delete(connectionId);
}

export const REVOKED_OAUTH_ERROR_TYPE = "oauth_login_revoked";
