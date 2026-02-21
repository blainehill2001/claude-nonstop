import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Module-level mocks (requires --experimental-test-module-mocks)
// ---------------------------------------------------------------------------
const mockReadCredentials = mock.fn();
const mockIsTokenExpired = mock.fn();
const mockCheckAllUsage = mock.fn();
const mockPickBestAccount = mock.fn();
const mockReauthExpiredAccounts = mock.fn();

mock.module('../../../lib/keychain.js', {
  namedExports: {
    readCredentials: mockReadCredentials,
    isTokenExpired: mockIsTokenExpired,
  },
});

mock.module('../../../lib/usage.js', {
  namedExports: {
    checkAllUsage: mockCheckAllUsage,
  },
});

mock.module('../../../lib/scorer.js', {
  namedExports: {
    pickBestAccount: mockPickBestAccount,
  },
});

mock.module('../../../lib/reauth.js', {
  namedExports: {
    reauthExpiredAccounts: mockReauthExpiredAccounts,
  },
});

// Import after mocks are registered so the module picks up stubs
const { getAuthenticatedAccounts, selectAccount } = await import('../../../lib/launch.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetMocks() {
  mockReadCredentials.mock.resetCalls();
  mockIsTokenExpired.mock.resetCalls();
  mockCheckAllUsage.mock.resetCalls();
  mockPickBestAccount.mock.resetCalls();
  mockReauthExpiredAccounts.mock.resetCalls();
}

// Silence console.error during tests (launch.js logs account selection info)
let origStderrWrite;

// ---------------------------------------------------------------------------
// getAuthenticatedAccounts
// ---------------------------------------------------------------------------
describe('getAuthenticatedAccounts', () => {
  beforeEach(() => {
    resetMocks();
    origStderrWrite = process.stderr.write;
    process.stderr.write = () => true;
  });

  afterEach(() => {
    process.stderr.write = origStderrWrite;
  });

  it('returns accounts that have valid tokens', async () => {
    mockReadCredentials.mock.mockImplementation((configDir) => {
      if (configDir === '/tmp/a') return { token: 'sk-ant-oat01-aaa', expiresAt: Date.now() + 100000 };
      return { token: null, expiresAt: null };
    });
    mockIsTokenExpired.mock.mockImplementation(() => false);
    mockReauthExpiredAccounts.mock.mockImplementation(async () => []);

    const accounts = [
      { name: 'a', configDir: '/tmp/a' },
      { name: 'b', configDir: '/tmp/b' },
    ];
    const result = await getAuthenticatedAccounts(accounts, { remoteAccess: false });

    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'a');
    assert.equal(result[0].token, 'sk-ant-oat01-aaa');
  });

  it('filters out accounts without tokens', async () => {
    mockReadCredentials.mock.mockImplementation(() => ({ token: null, expiresAt: null }));
    mockIsTokenExpired.mock.mockImplementation(() => false);
    mockReauthExpiredAccounts.mock.mockImplementation(async () => []);

    const accounts = [
      { name: 'a', configDir: '/tmp/a' },
      { name: 'b', configDir: '/tmp/b' },
    ];
    const result = await getAuthenticatedAccounts(accounts, { remoteAccess: false });

    assert.equal(result.length, 0);
  });

  it('calls reauthExpiredAccounts for expired tokens when remoteAccess is false', async () => {
    const pastTime = Date.now() - 100000;
    mockReadCredentials.mock.mockImplementation(() => ({
      token: 'sk-ant-oat01-expired',
      expiresAt: pastTime,
    }));
    mockIsTokenExpired.mock.mockImplementation(({ expiresAt }) => expiresAt < Date.now());
    mockReauthExpiredAccounts.mock.mockImplementation(async () => ['acct1']);

    const accounts = [{ name: 'acct1', configDir: '/tmp/acct1' }];
    await getAuthenticatedAccounts(accounts, { remoteAccess: false });

    assert.equal(mockReauthExpiredAccounts.mock.callCount(), 1, 'should call reauthExpiredAccounts');
  });

  it('skips reauth when remoteAccess is true', async () => {
    const pastTime = Date.now() - 100000;
    mockReadCredentials.mock.mockImplementation(() => ({
      token: 'sk-ant-oat01-expired',
      expiresAt: pastTime,
    }));
    mockIsTokenExpired.mock.mockImplementation(({ expiresAt }) => expiresAt < Date.now());
    mockReauthExpiredAccounts.mock.mockImplementation(async () => []);

    const accounts = [{ name: 'acct1', configDir: '/tmp/acct1' }];
    await getAuthenticatedAccounts(accounts, { remoteAccess: true });

    assert.equal(
      mockReauthExpiredAccounts.mock.callCount(),
      0,
      'should NOT call reauthExpiredAccounts in remote mode'
    );
  });

  it('re-reads credentials after successful reauth', async () => {
    let readCount = 0;
    mockReadCredentials.mock.mockImplementation(() => {
      readCount++;
      // First pass: no token triggers reauth; second pass: fresh token
      if (readCount <= 1) return { token: null, expiresAt: null };
      return { token: 'sk-ant-oat01-fresh', expiresAt: Date.now() + 100000 };
    });
    mockIsTokenExpired.mock.mockImplementation(() => false);
    mockReauthExpiredAccounts.mock.mockImplementation(async () => ['acct1']);

    const accounts = [{ name: 'acct1', configDir: '/tmp/acct1' }];
    const result = await getAuthenticatedAccounts(accounts, { remoteAccess: false });

    // readCredentials called at least twice: initial mapping + re-read after reauth
    assert.ok(mockReadCredentials.mock.callCount() >= 2, 'should re-read credentials after reauth');
    assert.equal(result.length, 1);
    assert.equal(result[0].token, 'sk-ant-oat01-fresh');
  });

  it('calls readCredentials once per account', async () => {
    mockReadCredentials.mock.mockImplementation(() => ({
      token: 'sk-ant-oat01-valid',
      expiresAt: Date.now() + 100000,
    }));
    mockIsTokenExpired.mock.mockImplementation(() => false);

    const accounts = [
      { name: 'a', configDir: '/tmp/a' },
      { name: 'b', configDir: '/tmp/b' },
      { name: 'c', configDir: '/tmp/c' },
    ];
    await getAuthenticatedAccounts(accounts, { remoteAccess: false });

    assert.equal(mockReadCredentials.mock.callCount(), 3);
  });

  it('preserves original account fields alongside credentials', async () => {
    mockReadCredentials.mock.mockImplementation(() => ({
      token: 'sk-ant-oat01-tok',
      expiresAt: 9999999999999,
    }));
    mockIsTokenExpired.mock.mockImplementation(() => false);

    const accounts = [{ name: 'myacct', configDir: '/tmp/myacct', extraField: 'keep-me' }];
    const result = await getAuthenticatedAccounts(accounts, { remoteAccess: false });

    assert.equal(result[0].name, 'myacct');
    assert.equal(result[0].configDir, '/tmp/myacct');
    assert.equal(result[0].extraField, 'keep-me');
    assert.equal(result[0].token, 'sk-ant-oat01-tok');
    assert.equal(result[0].expiresAt, 9999999999999);
  });
});

// ---------------------------------------------------------------------------
// selectAccount
// ---------------------------------------------------------------------------
describe('selectAccount', () => {
  beforeEach(() => {
    resetMocks();
    origStderrWrite = process.stderr.write;
    process.stderr.write = () => true;
  });

  afterEach(() => {
    process.stderr.write = origStderrWrite;
  });

  it('returns the only authenticated account directly', async () => {
    const accounts = [{ name: 'solo', configDir: '/tmp/solo', token: 'sk-test' }];
    const result = await selectAccount(accounts, accounts, {
      requestedAccount: null,
      remoteAccess: false,
    });
    assert.equal(result.name, 'solo');
  });

  it('returns explicit account when requestedAccount matches', async () => {
    const accounts = [
      { name: 'alpha', configDir: '/tmp/a', token: 'sk-a' },
      { name: 'beta', configDir: '/tmp/b', token: 'sk-b' },
    ];
    const result = await selectAccount(accounts, accounts, {
      requestedAccount: 'beta',
      remoteAccess: false,
    });
    assert.equal(result.name, 'beta');
  });

  it('throws Error when requestedAccount is not found', async () => {
    const accounts = [{ name: 'alpha', configDir: '/tmp/a', token: 'sk-a' }];
    await assert.rejects(
      () => selectAccount(accounts, accounts, {
        requestedAccount: 'nope',
        remoteAccess: false,
      }),
      (err) => {
        assert.ok(err instanceof Error, 'should throw an Error');
        assert.ok(err.message.includes('Account "nope" not found'), 'message should name the account');
        return true;
      }
    );
  });

  it('error message lists available authenticated accounts', async () => {
    const accounts = [
      { name: 'alpha', configDir: '/tmp/a', token: 'sk-a' },
      { name: 'beta', configDir: '/tmp/b', token: 'sk-b' },
    ];
    await assert.rejects(
      () => selectAccount(accounts, accounts, {
        requestedAccount: 'gamma',
        remoteAccess: false,
      }),
      (err) => {
        assert.ok(err.message.includes('alpha'), 'should list alpha');
        assert.ok(err.message.includes('beta'), 'should list beta');
        return true;
      }
    );
  });

  it('does not call checkAllUsage for a single account', async () => {
    const accounts = [{ name: 'only', configDir: '/tmp/only', token: 'sk-only' }];
    await selectAccount(accounts, accounts, {
      requestedAccount: null,
      remoteAccess: false,
    });
    assert.equal(mockCheckAllUsage.mock.callCount(), 0);
  });

  it('calls checkAllUsage and pickBestAccount for multiple accounts', async () => {
    const accounts = [
      { name: 'a', configDir: '/tmp/a', token: 'sk-a' },
      { name: 'b', configDir: '/tmp/b', token: 'sk-b' },
    ];
    mockCheckAllUsage.mock.mockImplementation(async (accts) =>
      accts.map(a => ({ ...a, usage: { sessionPercent: 50, weeklyPercent: 30 } }))
    );
    mockPickBestAccount.mock.mockImplementation((accts) => ({
      account: accts[1],
      reason: 'lowest utilization (session: 30%, weekly: 20%)',
    }));

    const result = await selectAccount(accounts, accounts, {
      requestedAccount: null,
      remoteAccess: false,
    });

    assert.equal(mockCheckAllUsage.mock.callCount(), 1, 'should call checkAllUsage');
    assert.equal(mockPickBestAccount.mock.callCount(), 1, 'should call pickBestAccount');
    assert.equal(result.name, 'b');
  });

  it('falls back to first account when pickBestAccount returns null', async () => {
    const accounts = [
      { name: 'first', configDir: '/tmp/first', token: 'sk-first' },
      { name: 'second', configDir: '/tmp/second', token: 'sk-second' },
    ];
    mockCheckAllUsage.mock.mockImplementation(async (accts) =>
      accts.map(a => ({ ...a, usage: { error: 'timeout' } }))
    );
    mockPickBestAccount.mock.mockImplementation(() => null);
    mockReauthExpiredAccounts.mock.mockImplementation(async () => []);

    const result = await selectAccount(accounts, accounts, {
      requestedAccount: null,
      remoteAccess: false,
    });

    assert.equal(result.name, 'first');
  });

  it('triggers reauth for HTTP 401/403 API errors when not remote', async () => {
    const accounts = [
      { name: 'a', configDir: '/tmp/a', token: 'sk-a' },
      { name: 'b', configDir: '/tmp/b', token: 'sk-b' },
    ];
    mockCheckAllUsage.mock.mockImplementation(async (accts) =>
      accts.map(a => ({ ...a, usage: { error: 'HTTP 401' } }))
    );
    mockReauthExpiredAccounts.mock.mockImplementation(async () => []);
    mockPickBestAccount.mock.mockImplementation(() => null);
    mockReadCredentials.mock.mockImplementation(() => ({ token: 'sk-ant-oat01-fresh' }));

    await selectAccount(accounts, accounts, {
      requestedAccount: null,
      remoteAccess: false,
    });

    assert.equal(mockReauthExpiredAccounts.mock.callCount(), 1, 'should call reauthExpiredAccounts for 401');
  });

  it('skips API-error reauth when remoteAccess is true', async () => {
    const accounts = [
      { name: 'a', configDir: '/tmp/a', token: 'sk-a' },
      { name: 'b', configDir: '/tmp/b', token: 'sk-b' },
    ];
    mockCheckAllUsage.mock.mockImplementation(async (accts) =>
      accts.map(a => ({ ...a, usage: { error: 'HTTP 403' } }))
    );
    mockReauthExpiredAccounts.mock.mockImplementation(async () => []);
    mockPickBestAccount.mock.mockImplementation(() => null);

    await selectAccount(accounts, accounts, {
      requestedAccount: null,
      remoteAccess: true,
    });

    assert.equal(
      mockReauthExpiredAccounts.mock.callCount(),
      0,
      'should NOT call reauthExpiredAccounts in remote mode'
    );
  });

  it('does not call checkAllUsage when requestedAccount is specified', async () => {
    const accounts = [
      { name: 'a', configDir: '/tmp/a', token: 'sk-a' },
      { name: 'b', configDir: '/tmp/b', token: 'sk-b' },
    ];
    await selectAccount(accounts, accounts, {
      requestedAccount: 'a',
      remoteAccess: false,
    });
    assert.equal(mockCheckAllUsage.mock.callCount(), 0, 'should skip usage check for explicit account');
  });
});
