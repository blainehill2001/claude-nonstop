import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickBestAccount, effectiveScore, effectiveUtilization,
  timeWeight, SESSION_MAX_RESET_MS, WEEKLY_MAX_RESET_MS,
} from '../../../lib/scorer.js';

describe('timeWeight', () => {
  it('returns 1.0 when resetsAt is null', () => {
    assert.equal(timeWeight(null, SESSION_MAX_RESET_MS), 1.0);
  });

  it('returns 1.0 when resetsAt is invalid', () => {
    assert.equal(timeWeight('not-a-date', SESSION_MAX_RESET_MS), 1.0);
  });

  it('returns 0.0 when reset is in the past', () => {
    const past = new Date(Date.now() - 60000).toISOString();
    assert.equal(timeWeight(past, SESSION_MAX_RESET_MS), 0.0);
  });

  it('returns fraction of max window remaining', () => {
    const now = Date.now();
    const halfSession = new Date(now + SESSION_MAX_RESET_MS / 2).toISOString();
    const weight = timeWeight(halfSession, SESSION_MAX_RESET_MS, now);
    assert.ok(Math.abs(weight - 0.5) < 0.01, `expected ~0.5, got ${weight}`);
  });

  it('clamps to 1.0 when remaining exceeds max window', () => {
    const now = Date.now();
    const farFuture = new Date(now + SESSION_MAX_RESET_MS * 3).toISOString();
    assert.equal(timeWeight(farFuture, SESSION_MAX_RESET_MS, now), 1.0);
  });

  it('returns near-zero for imminent reset', () => {
    const now = Date.now();
    const soonReset = new Date(now + 60000).toISOString(); // 1 minute
    const weight = timeWeight(soonReset, SESSION_MAX_RESET_MS, now);
    assert.ok(weight < 0.01, `expected near-zero, got ${weight}`);
  });
});

describe('effectiveScore', () => {
  it('returns 100 for null usage', () => {
    assert.equal(effectiveScore(null), 100);
  });

  it('returns 0 for zero utilization', () => {
    const usage = { sessionPercent: 0, weeklyPercent: 0 };
    assert.equal(effectiveScore(usage), 0);
  });

  it('applies time weight to session score', () => {
    const now = Date.now();
    const tenMinutes = new Date(now + 10 * 60 * 1000).toISOString();
    const usage = {
      sessionPercent: 80,
      weeklyPercent: 0,
      sessionResetsAt: tenMinutes,
      weeklyResetsAt: null,
    };
    const score = effectiveScore(usage, now);
    // 80 * (10min / 5h) = 80 * (600000 / 18000000) ≈ 2.67
    assert.ok(score < 5, `expected ~2.67, got ${score}`);
    assert.ok(score > 2, `expected ~2.67, got ${score}`);
  });

  it('applies time weight to weekly score', () => {
    const now = Date.now();
    const oneDay = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const usage = {
      sessionPercent: 0,
      weeklyPercent: 70,
      sessionResetsAt: null,
      weeklyResetsAt: oneDay,
    };
    const score = effectiveScore(usage, now);
    // 70 * (1day / 7day) = 70 * (1/7) = 10
    assert.ok(Math.abs(score - 10) < 1, `expected ~10, got ${score}`);
  });

  it('uses max of session and weekly scores', () => {
    const now = Date.now();
    const usage = {
      sessionPercent: 50,
      weeklyPercent: 50,
      sessionResetsAt: new Date(now + SESSION_MAX_RESET_MS).toISOString(),
      weeklyResetsAt: new Date(now + WEEKLY_MAX_RESET_MS).toISOString(),
    };
    const score = effectiveScore(usage, now);
    assert.equal(score, 50);
  });

  it('uses timeWeight=1.0 when resetsAt is null (conservative)', () => {
    const usage = {
      sessionPercent: 60,
      weeklyPercent: 40,
      sessionResetsAt: null,
      weeklyResetsAt: null,
    };
    const score = effectiveScore(usage);
    // max(60*1.0, 40*1.0) = 60
    assert.equal(score, 60);
  });

  it('design doc example: account A beats account B', () => {
    const now = Date.now();
    // Account A: 80% session, resets in 10min → 80 * (10/300) = 2.67
    const usageA = {
      sessionPercent: 80, weeklyPercent: 0,
      sessionResetsAt: new Date(now + 10 * 60 * 1000).toISOString(),
      weeklyResetsAt: null,
    };
    // Account B: 60% session, resets in 4h → 60 * (240/300) = 48
    const usageB = {
      sessionPercent: 60, weeklyPercent: 0,
      sessionResetsAt: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
      weeklyResetsAt: null,
    };

    const scoreA = effectiveScore(usageA, now);
    const scoreB = effectiveScore(usageB, now);

    assert.ok(scoreA < scoreB, `A (${scoreA}) should beat B (${scoreB})`);
    assert.ok(scoreA < 5, `A should be ~2.67, got ${scoreA}`);
    assert.ok(scoreB > 40, `B should be ~48, got ${scoreB}`);
  });
});

describe('effectiveUtilization (backward compat)', () => {
  it('returns max of session and weekly', () => {
    assert.equal(effectiveUtilization({ sessionPercent: 30, weeklyPercent: 70 }), 70);
    assert.equal(effectiveUtilization({ sessionPercent: 90, weeklyPercent: 20 }), 90);
  });

  it('returns 100 for null usage', () => {
    assert.equal(effectiveUtilization(null), 100);
  });
});

describe('pickBestAccount', () => {
  const makeAccount = (name, sessionPercent, weeklyPercent, opts = {}) => ({
    name,
    configDir: `/tmp/profiles/${name}`,
    token: 'token' in opts ? opts.token : 'sk-ant-oat01-valid',
    usage: opts.error
      ? { error: opts.error }
      : {
          sessionPercent,
          weeklyPercent,
          sessionResetsAt: opts.sessionResetsAt ?? null,
          weeklyResetsAt: opts.weeklyResetsAt ?? null,
        },
  });

  it('picks account with lowest time-weighted score', () => {
    const now = Date.now();
    const accounts = [
      makeAccount('high-but-soon', 80, 0, {
        sessionResetsAt: new Date(now + 10 * 60 * 1000).toISOString(), // 10 min
      }),
      makeAccount('low-but-late', 60, 0, {
        sessionResetsAt: new Date(now + 4 * 60 * 60 * 1000).toISOString(), // 4h
      }),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'high-but-soon');
  });

  it('picks the account with the lowest utilization when no reset times', () => {
    const accounts = [
      makeAccount('high', 80, 50),
      makeAccount('low', 10, 20),
      makeAccount('mid', 40, 30),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'low');
  });

  it('excludes the named account', () => {
    const accounts = [
      makeAccount('best', 0, 0),
      makeAccount('other', 50, 50),
    ];
    const result = pickBestAccount(accounts, 'best');
    assert.equal(result.account.name, 'other');
  });

  it('filters out accounts with no token', () => {
    const accounts = [
      makeAccount('no-token', 0, 0, { token: null }),
      makeAccount('has-token', 50, 50),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'has-token');
  });

  it('filters out accounts with usage errors', () => {
    const accounts = [
      makeAccount('error', 0, 0, { error: 'HTTP 401' }),
      makeAccount('ok', 60, 60),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'ok');
  });

  it('returns null when no candidates remain', () => {
    const accounts = [
      makeAccount('only', 0, 0, { token: null }),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result, null);
  });

  it('returns null for empty array', () => {
    const result = pickBestAccount([]);
    assert.equal(result, null);
  });

  it('returns null when all are excluded or invalid', () => {
    const accounts = [
      makeAccount('excluded', 0, 0),
      makeAccount('error', 0, 0, { error: 'timeout' }),
    ];
    const result = pickBestAccount(accounts, 'excluded');
    assert.equal(result, null);
  });

  it('handles tied scores deterministically (first in input order wins)', () => {
    const accounts = [
      makeAccount('a', 50, 50),
      makeAccount('b', 50, 50),
    ];
    const result = pickBestAccount(accounts);
    assert.ok(result !== null);
    assert.equal(result.account.name, 'a');
    const result2 = pickBestAccount(accounts);
    assert.equal(result2.account.name, 'a');
  });

  it('includes score in reason string', () => {
    const accounts = [makeAccount('test', 25, 30)];
    const result = pickBestAccount(accounts);
    assert.ok(result.reason.includes('25%'));
    assert.ok(result.reason.includes('30%'));
    assert.ok(result.reason.includes('score'));
  });

  it('handles accounts with null usage as score 100', () => {
    const accounts = [
      { name: 'null-usage', configDir: '/tmp/null', token: 'sk-ant-oat01-x', usage: null },
      makeAccount('ok', 50, 50),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'ok');
  });

  it('handles zero utilization', () => {
    const accounts = [makeAccount('zero', 0, 0)];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'zero');
  });

  it('handles 100% utilization', () => {
    const accounts = [makeAccount('full', 100, 100)];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'full');
  });

  it('filters multiple invalid accounts correctly', () => {
    const accounts = [
      makeAccount('err1', 0, 0, { error: 'HTTP 500' }),
      makeAccount('err2', 0, 0, { error: 'timeout' }),
      makeAccount('no-tok', 0, 0, { token: null }),
      makeAccount('valid', 30, 40),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'valid');
  });

  it('prefers account with past reset time (score drops to zero)', () => {
    const now = Date.now();
    const accounts = [
      makeAccount('high-past-reset', 90, 0, {
        sessionResetsAt: new Date(now - 60000).toISOString(), // already reset
      }),
      makeAccount('low-future-reset', 20, 0, {
        sessionResetsAt: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'high-past-reset');
  });
});
