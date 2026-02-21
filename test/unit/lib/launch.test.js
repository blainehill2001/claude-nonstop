import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const launchSource = readFileSync(join(PROJECT_ROOT, 'lib', 'launch.js'), 'utf-8');

describe('lib/launch.js module structure', () => {
  it('exports getAuthenticatedAccounts', () => {
    assert.ok(
      launchSource.includes('export async function getAuthenticatedAccounts'),
      'Should export getAuthenticatedAccounts'
    );
  });

  it('exports selectAccount', () => {
    assert.ok(
      launchSource.includes('export async function selectAccount'),
      'Should export selectAccount'
    );
  });

  it('imports readCredentials from keychain.js', () => {
    assert.ok(
      launchSource.includes("import { readCredentials, isTokenExpired } from './keychain.js'"),
      'Should import readCredentials and isTokenExpired'
    );
  });

  it('imports checkAllUsage from usage.js', () => {
    assert.ok(
      launchSource.includes("import { checkAllUsage } from './usage.js'"),
      'Should import checkAllUsage'
    );
  });

  it('imports pickBestAccount from scorer.js', () => {
    assert.ok(
      launchSource.includes("import { pickBestAccount } from './scorer.js'"),
      'Should import pickBestAccount'
    );
  });

  it('imports reauthExpiredAccounts from reauth.js', () => {
    assert.ok(
      launchSource.includes("import { reauthExpiredAccounts } from './reauth.js'"),
      'Should import reauthExpiredAccounts'
    );
  });
});

describe('getAuthenticatedAccounts logic', () => {
  it('filters accounts with no token', () => {
    assert.ok(
      launchSource.includes('.filter(a => a.token)'),
      'Should filter out accounts without tokens'
    );
  });

  it('checks for expired tokens via isTokenExpired', () => {
    assert.ok(
      launchSource.includes('isTokenExpired({ expiresAt: a.expiresAt })'),
      'Should check expiration'
    );
  });

  it('skips reauth in remote access mode', () => {
    assert.ok(
      launchSource.includes('!remoteAccess'),
      'Should skip reauth when remoteAccess is true'
    );
  });

  it('re-reads credentials after successful reauth', () => {
    // After reauthExpiredAccounts returns, the function re-maps accounts
    // to get fresh credentials from disk
    const reauthBlock = launchSource.match(/if \(refreshed\.length > 0\) \{[\s\S]*?readCredentials/);
    assert.ok(reauthBlock, 'Should re-read credentials after reauth');
  });
});

describe('selectAccount logic', () => {
  it('returns explicit account when --account flag is used', () => {
    assert.ok(
      launchSource.includes('if (requestedAccount)'),
      'Should check for requestedAccount first'
    );
    assert.ok(
      launchSource.includes("authenticated.find(a => a.name === requestedAccount)"),
      'Should find account by name'
    );
  });

  it('returns single account without usage check', () => {
    assert.ok(
      launchSource.includes('if (authenticated.length === 1)'),
      'Should shortcut when only one account'
    );
  });

  it('calls checkAllUsage for multiple accounts', () => {
    assert.ok(
      launchSource.includes('await checkAllUsage(authenticated)'),
      'Should check usage across accounts'
    );
  });

  it('handles API auth errors (401/403) with reauth', () => {
    assert.ok(
      launchSource.includes("a.usage?.error === 'HTTP 401'"),
      'Should detect 401 errors'
    );
    assert.ok(
      launchSource.includes("a.usage?.error === 'HTTP 403'"),
      'Should detect 403 errors'
    );
  });

  it('calls pickBestAccount and falls back to first', () => {
    assert.ok(
      launchSource.includes('pickBestAccount(withUsage)'),
      'Should use pickBestAccount'
    );
    assert.ok(
      launchSource.includes('return authenticated[0]'),
      'Should fallback to first account'
    );
  });

  it('exits with error if requested account not found', () => {
    assert.ok(
      launchSource.includes('process.exit(1)'),
      'Should exit on missing requested account'
    );
  });
});

describe('selectAccount functional tests', () => {
  // Dynamic import so we test the real module
  let selectAccount;

  it('returns the only authenticated account directly', async () => {
    const mod = await import('../../../lib/launch.js');
    selectAccount = mod.selectAccount;

    const accounts = [{ name: 'solo', configDir: '/tmp/solo', token: 'sk-test' }];
    const result = await selectAccount(accounts, accounts, { requestedAccount: null, remoteAccess: false });
    assert.equal(result.name, 'solo');
  });

  it('returns explicit account when requested', async () => {
    const mod = await import('../../../lib/launch.js');
    selectAccount = mod.selectAccount;

    const accounts = [
      { name: 'alpha', configDir: '/tmp/a', token: 'sk-a' },
      { name: 'beta', configDir: '/tmp/b', token: 'sk-b' },
    ];
    const result = await selectAccount(accounts, accounts, { requestedAccount: 'beta', remoteAccess: false });
    assert.equal(result.name, 'beta');
  });
});
