const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { formatCountdown, buildCountdownText, UPDATE_INTERVAL_MS } = require('../../../remote/countdown-worker.cjs');
const { spawnCountdownWorker, COUNTDOWN_WORKER_PATH } = require('../../../remote/hook-notify.cjs');

describe('formatCountdown', () => {
  it('formats hours and minutes', () => {
    assert.equal(formatCountdown(2 * 60 * 60 * 1000 + 15 * 60 * 1000), '2h 15m');
  });

  it('formats minutes only when under 1 hour', () => {
    assert.equal(formatCountdown(45 * 60 * 1000), '45m');
  });

  it('formats zero hours with just minutes', () => {
    assert.equal(formatCountdown(5 * 60 * 1000), '5m');
  });

  it('returns "now" for zero or negative ms', () => {
    assert.equal(formatCountdown(0), 'now');
    assert.equal(formatCountdown(-1000), 'now');
  });

  it('handles exactly 1 hour', () => {
    assert.equal(formatCountdown(60 * 60 * 1000), '1h 0m');
  });
});

describe('buildCountdownText', () => {
  it('includes zzz emoji and remaining time', () => {
    const wakeAt = Date.now() + 2 * 60 * 60 * 1000;
    const text = buildCountdownText(wakeAt);
    assert.ok(text.includes(':zzz:'));
    assert.ok(text.includes('remaining'));
    assert.ok(text.includes('Waking at'));
  });

  it('shows waking up message when time has passed', () => {
    const wakeAt = Date.now() - 1000;
    const text = buildCountdownText(wakeAt);
    assert.ok(text.includes(':sunrise:'));
    assert.ok(text.includes('Waking up now'));
  });
});

describe('UPDATE_INTERVAL_MS', () => {
  it('is 5 minutes', () => {
    assert.equal(UPDATE_INTERVAL_MS, 5 * 60 * 1000);
  });
});

describe('countdown worker integration', () => {
  it('COUNTDOWN_WORKER_PATH points to countdown-worker.cjs', () => {
    assert.ok(COUNTDOWN_WORKER_PATH.endsWith('countdown-worker.cjs'));
  });

  it('countdown-worker.cjs exists on disk', () => {
    assert.ok(fs.existsSync(COUNTDOWN_WORKER_PATH));
  });

  it('countdown-worker.cjs has valid syntax', () => {
    const worker = require(COUNTDOWN_WORKER_PATH);
    assert.ok(worker !== undefined);
  });

  it('spawnCountdownWorker is exported and callable', () => {
    assert.equal(typeof spawnCountdownWorker, 'function');
  });
});
