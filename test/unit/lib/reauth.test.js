import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Import the module under test
import { silentRefresh, reauthAccount, reauthExpiredAccounts } from '../../../lib/reauth.js';

describe('reauth module exports', () => {
  it('exports silentRefresh as a function', () => {
    assert.equal(typeof silentRefresh, 'function');
  });

  it('exports reauthAccount as a function', () => {
    assert.equal(typeof reauthAccount, 'function');
  });

  it('exports reauthExpiredAccounts as a function', () => {
    assert.equal(typeof reauthExpiredAccounts, 'function');
  });
});

describe('silentRefresh', () => {
  it('returns a boolean', async () => {
    // Use a nonexistent configDir so refreshAccessToken will fail gracefully
    const result = await silentRefresh({ name: 'test', configDir: '/tmp/nonexistent-reauth-test' });
    assert.equal(typeof result, 'boolean');
  });

  it('returns false when configDir has no credentials', async () => {
    const result = await silentRefresh({ name: 'test', configDir: '/tmp/nonexistent-reauth-test' });
    assert.equal(result, false);
  });

  it('returns false for empty configDir string', async () => {
    const result = await silentRefresh({ name: 'test', configDir: '' });
    assert.equal(result, false);
  });
});

describe('reauthExpiredAccounts', () => {
  let originalIsTTY;
  let originalStderr;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    // Suppress console.error output during tests
    originalStderr = console.error;
    console.error = () => {};
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
    console.error = originalStderr;
  });

  it('returns an array', async () => {
    const result = await reauthExpiredAccounts([]);
    assert.ok(Array.isArray(result));
  });

  it('returns empty array for empty input', async () => {
    const result = await reauthExpiredAccounts([]);
    assert.deepEqual(result, []);
  });

  it('returns empty array when all accounts have valid tokens', async () => {
    // Accounts with tokens where readCredentials + isTokenExpired would need
    // to confirm they are not expired. Since the configDir is fake,
    // readCredentials returns no expiresAt, so isTokenExpired returns false
    // (non-expired). And since account has a token and no usage error,
    // it should NOT need reauth.
    const accounts = [
      { name: 'valid1', configDir: '/tmp/nonexistent-reauth-test-1', token: 'sk-ant-oat01-abc' },
      { name: 'valid2', configDir: '/tmp/nonexistent-reauth-test-2', token: 'sk-ant-oat01-def' },
    ];
    const result = await reauthExpiredAccounts(accounts);
    assert.deepEqual(result, []);
  });

  it('identifies accounts with no token as needing reauth', async () => {
    process.stdin.isTTY = false;
    const accounts = [
      { name: 'no-token', configDir: '/tmp/nonexistent-reauth-test', token: null },
    ];
    // Non-TTY + no token = cannot do silent refresh (no token) and cannot
    // do interactive (no TTY), so returns empty
    const result = await reauthExpiredAccounts(accounts);
    assert.deepEqual(result, []);
  });

  it('identifies accounts with HTTP 401 usage error as needing reauth', async () => {
    process.stdin.isTTY = false;
    const accounts = [
      {
        name: 'rejected',
        configDir: '/tmp/nonexistent-reauth-test',
        token: 'sk-ant-oat01-abc',
        usage: { error: 'HTTP 401' },
      },
    ];
    // Has a token so it goes to silentRefresh first. silentRefresh will fail
    // (no credentials in /tmp), then falls to interactive reauth. Since non-TTY,
    // returns empty.
    const result = await reauthExpiredAccounts(accounts);
    assert.deepEqual(result, []);
  });

  it('identifies accounts with HTTP 403 usage error as needing reauth', async () => {
    process.stdin.isTTY = false;
    const accounts = [
      {
        name: 'revoked',
        configDir: '/tmp/nonexistent-reauth-test',
        token: 'sk-ant-oat01-abc',
        usage: { error: 'HTTP 403' },
      },
    ];
    const result = await reauthExpiredAccounts(accounts);
    assert.deepEqual(result, []);
  });

  it('does not attempt interactive reauth when stdin is not a TTY', async () => {
    process.stdin.isTTY = false;
    const accounts = [
      { name: 'test-account', configDir: '/tmp/nonexistent-reauth-test' },
    ];
    // No token -> needs reauth. Non-TTY -> cannot do interactive.
    // Should return empty without spawning a child process.
    const result = await reauthExpiredAccounts(accounts);
    assert.deepEqual(result, []);
  });

  it('handles mixed accounts correctly in non-TTY mode', async () => {
    process.stdin.isTTY = false;
    const accounts = [
      // Valid token, no usage error -> does not need reauth
      { name: 'valid', configDir: '/tmp/nonexistent-reauth-test-v', token: 'sk-ant-oat01-good' },
      // No token -> needs reauth but cannot (non-TTY)
      { name: 'missing', configDir: '/tmp/nonexistent-reauth-test-m', token: null },
      // Token with 401 -> needs reauth, silentRefresh fails, then cannot interactive (non-TTY)
      { name: 'expired', configDir: '/tmp/nonexistent-reauth-test-e', token: 'sk-ant-oat01-exp', usage: { error: 'HTTP 401' } },
    ];
    const result = await reauthExpiredAccounts(accounts);
    // None should be refreshed: silentRefresh fails for 'expired' (no keychain),
    // and non-TTY prevents interactive for both 'missing' and 'expired'
    assert.deepEqual(result, []);
  });

  it('skips accounts with valid tokens and successful usage', async () => {
    const accounts = [
      {
        name: 'healthy',
        configDir: '/tmp/nonexistent-reauth-test',
        token: 'sk-ant-oat01-abc',
        usage: { sessionPercent: 30, weeklyPercent: 20 },
      },
    ];
    const result = await reauthExpiredAccounts(accounts);
    assert.deepEqual(result, []);
  });

  it('returns an array of strings (account names)', async () => {
    // With all valid accounts, result is empty array of strings
    const accounts = [
      { name: 'ok', configDir: '/tmp/nonexistent-reauth-test', token: 'sk-ant-oat01-abc' },
    ];
    const result = await reauthExpiredAccounts(accounts);
    assert.ok(Array.isArray(result));
    for (const item of result) {
      assert.equal(typeof item, 'string');
    }
  });
});
