const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { CONFIG_DIR, ENV_PATH, DATA_DIR, CHANNEL_MAP_PATH, outputBufferPath, outputSignalPath } = require('../../../remote/paths.cjs');

describe('paths.cjs exports', () => {
  it('CONFIG_DIR starts with homedir', () => {
    assert.ok(CONFIG_DIR.startsWith(os.homedir()));
  });

  it('ENV_PATH starts with homedir', () => {
    assert.ok(ENV_PATH.startsWith(os.homedir()));
  });

  it('DATA_DIR starts with homedir', () => {
    assert.ok(DATA_DIR.startsWith(os.homedir()));
  });

  it('CHANNEL_MAP_PATH starts with homedir', () => {
    assert.ok(CHANNEL_MAP_PATH.startsWith(os.homedir()));
  });

  it('all exports are strings', () => {
    assert.equal(typeof CONFIG_DIR, 'string');
    assert.equal(typeof ENV_PATH, 'string');
    assert.equal(typeof DATA_DIR, 'string');
    assert.equal(typeof CHANNEL_MAP_PATH, 'string');
  });

  it('CONFIG_DIR contains .claude-nonstop', () => {
    assert.ok(CONFIG_DIR.includes('.claude-nonstop'));
  });

  it('CHANNEL_MAP_PATH ends with channel-map.json', () => {
    assert.ok(CHANNEL_MAP_PATH.endsWith('channel-map.json'));
  });
});

describe('outputBufferPath', () => {
  it('returns path under DATA_DIR with session ID', () => {
    const p = outputBufferPath('abc-123');
    assert.equal(p, path.join(DATA_DIR, 'output-buffer-abc-123.txt'));
  });
});

describe('outputSignalPath', () => {
  it('returns path under DATA_DIR with session ID', () => {
    const p = outputSignalPath('abc-123');
    assert.equal(p, path.join(DATA_DIR, 'output-signal-abc-123.counter'));
  });
});
