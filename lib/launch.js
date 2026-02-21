/**
 * Shared launch logic for cmdRun and cmdResume.
 *
 * Extracts the common credential-reading, pre-flight reauth, and
 * account-selection flow so both commands can reuse it without
 * duplicating ~200 lines of identical code.
 */

import { readCredentials, isTokenExpired } from './keychain.js';
import { checkAllUsage } from './usage.js';
import { pickBestAccount } from './scorer.js';
import { reauthExpiredAccounts } from './reauth.js';

/**
 * Read credentials for all accounts and perform pre-flight expired
 * token detection with optional interactive re-auth.
 *
 * @param {Array<{name: string, configDir: string}>} accounts
 * @param {{ remoteAccess: boolean }} options
 * @returns {Promise<Array<{name: string, configDir: string, token: string, expiresAt: string}>>}
 */
export async function getAuthenticatedAccounts(accounts, { remoteAccess }) {
  let accountsWithCreds = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token, expiresAt: creds.expiresAt };
  });

  const expiredPreFlight = accountsWithCreds.filter(a =>
    !a.token || (a.expiresAt && isTokenExpired({ expiresAt: a.expiresAt }))
  );

  if (expiredPreFlight.length > 0 && !remoteAccess) {
    const refreshed = await reauthExpiredAccounts(expiredPreFlight);
    if (refreshed.length > 0) {
      accountsWithCreds = accounts.map(a => {
        const creds = readCredentials(a.configDir);
        return { ...a, token: creds.token, expiresAt: creds.expiresAt };
      });
    }
  }

  return accountsWithCreds.filter(a => a.token);
}

/**
 * Select the best account from authenticated accounts.
 *
 * Handles three cases:
 * 1. Explicit --account flag: use that account directly
 * 2. Single authenticated account: use it (skip usage check)
 * 3. Multiple accounts: check usage API, pick lowest utilization
 *
 * @param {Array<{name: string, configDir: string, token: string}>} authenticated
 * @param {Array<{name: string, configDir: string}>} allAccounts
 * @param {{ requestedAccount: string|null, remoteAccess: boolean }} options
 * @returns {Promise<{name: string, configDir: string, token: string}>}
 */
export async function selectAccount(authenticated, allAccounts, { requestedAccount, remoteAccess }) {
  if (requestedAccount) {
    const selected = authenticated.find(a => a.name === requestedAccount);
    if (!selected) {
      console.error(`Error: Account "${requestedAccount}" not found or not authenticated.`);
      console.error(`Authenticated accounts: ${authenticated.map(a => a.name).join(', ')}`);
      process.exit(1);
    }
    console.error(`[claude-nonstop] Using requested account "${selected.name}"`);
    return selected;
  }

  if (authenticated.length === 1) {
    console.error(`[claude-nonstop] Using account "${authenticated[0].name}"`);
    return authenticated[0];
  }

  // Multiple accounts — check usage and pick best
  console.error('[claude-nonstop] Checking usage across accounts...');
  const withUsage = await checkAllUsage(authenticated);

  const apiExpired = withUsage.filter(a =>
    a.usage?.error === 'HTTP 401' || a.usage?.error === 'HTTP 403'
  );
  if (apiExpired.length > 0 && !remoteAccess) {
    const refreshed = await reauthExpiredAccounts(apiExpired);
    if (refreshed.length > 0) {
      const updatedAccounts = allAccounts.map(a => {
        const creds = readCredentials(a.configDir);
        return { ...a, token: creds.token };
      }).filter(a => a.token);
      const updatedUsage = await checkAllUsage(updatedAccounts);
      for (const updated of updatedUsage) {
        const idx = withUsage.findIndex(a => a.name === updated.name);
        if (idx !== -1) withUsage[idx] = updated;
        else withUsage.push(updated);
      }
    }
  }

  const best = pickBestAccount(withUsage);

  if (best) {
    console.error(`[claude-nonstop] Selected "${best.account.name}" (${best.reason})`);
    return best.account;
  }

  // Fallback to first authenticated account
  console.error(`[claude-nonstop] Defaulting to "${authenticated[0].name}"`);
  return authenticated[0];
}
