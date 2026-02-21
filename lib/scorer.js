/**
 * Account scoring and selection.
 *
 * Picks the best account using time-weighted scoring — accounts that reset
 * sooner get dramatically lower scores even at high utilization.
 *
 * Formula:
 *   sessionScore = sessionPercent × (sessionTimeUntilReset / 5h)
 *   weeklyScore  = weeklyPercent  × (weeklyTimeUntilReset / 7d)
 *   effectiveScore = max(sessionScore, weeklyScore)
 *   Lowest effectiveScore wins.
 *
 * When reset time is unknown, timeWeight defaults to 1.0 (conservative).
 */

/** Maximum reset windows for time weighting. */
const SESSION_MAX_RESET_MS = 5 * 60 * 60 * 1000;  // 5 hours
const WEEKLY_MAX_RESET_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Calculate time weight: fraction of max reset window remaining.
 * Clamped to [0.0, 1.0]. Returns 1.0 if reset time is unknown.
 *
 * @param {string|null} resetsAt - ISO timestamp of reset
 * @param {number} maxResetMs - Maximum reset window in ms
 * @param {number} [now] - Current time (for testing)
 * @returns {number} Weight between 0.0 and 1.0
 */
function timeWeight(resetsAt, maxResetMs, now) {
  if (!resetsAt) return 1.0;
  const nowMs = now ?? Date.now();
  const resetMs = new Date(resetsAt).getTime();
  if (isNaN(resetMs)) return 1.0;
  const remaining = resetMs - nowMs;
  if (remaining <= 0) return 0.0;
  return Math.min(remaining / maxResetMs, 1.0);
}

/**
 * Calculate the time-weighted effective score for an account.
 * Lower is better — accounts resetting soon get near-zero scores.
 *
 * @param {object} usage - { sessionPercent, weeklyPercent, sessionResetsAt, weeklyResetsAt }
 * @param {number} [now] - Current time (for testing)
 * @returns {number}
 */
export function effectiveScore(usage, now) {
  if (!usage) return 100;
  const sessionPct = usage.sessionPercent || 0;
  const weeklyPct = usage.weeklyPercent || 0;

  const sessionTw = timeWeight(usage.sessionResetsAt, SESSION_MAX_RESET_MS, now);
  const weeklyTw = timeWeight(usage.weeklyResetsAt, WEEKLY_MAX_RESET_MS, now);

  const sessionScore = sessionPct * sessionTw;
  const weeklyScore = weeklyPct * weeklyTw;

  return Math.max(sessionScore, weeklyScore);
}

/**
 * Calculate effective utilization — the higher of session or weekly.
 * Kept for backward compatibility (used by runner.js exhaustion check).
 */
export function effectiveUtilization(usage) {
  if (!usage) return 100;
  return Math.max(usage.sessionPercent || 0, usage.weeklyPercent || 0);
}

/**
 * Pick the best account from a list of accounts with usage data.
 *
 * @param {Array<{name: string, configDir: string, token: string, usage: object}>} accounts
 * @param {string} [excludeName] - Account name to exclude (e.g., the one that just hit a limit)
 * @returns {{ account: object, reason: string } | null}
 */
export function pickBestAccount(accounts, excludeName) {
  const candidates = accounts.filter(a => {
    if (a.name === excludeName) return false;
    if (!a.token) return false;
    if (a.usage?.error) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  const now = Date.now();

  // Sort by time-weighted score (ascending — lowest score first)
  candidates.sort((a, b) => {
    const aScore = effectiveScore(a.usage, now);
    const bScore = effectiveScore(b.usage, now);
    return aScore - bScore;
  });

  const best = candidates[0];
  const score = effectiveScore(best.usage, now).toFixed(1);

  return {
    account: best,
    reason: `lowest score ${score} (session: ${best.usage.sessionPercent}%, weekly: ${best.usage.weeklyPercent}%)`,
  };
}

export {
  timeWeight,
  SESSION_MAX_RESET_MS,
  WEEKLY_MAX_RESET_MS,
};
