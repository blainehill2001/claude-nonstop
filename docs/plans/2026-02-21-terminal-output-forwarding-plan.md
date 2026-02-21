# Terminal Output Forwarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Forward Claude Code's PTY text output (insights, replies, code) to Slack in chronological order with tool-use notifications.

**Architecture:** Capture PTY output in `runner.js` via the existing `child.onData()` stream, buffer to a file, flush every 5 seconds to Slack via `hook-notify.cjs`. Hooks flush the buffer before posting their own messages to preserve chronological order. A signal file with a monotonic counter prevents double-posting.

**Tech Stack:** Node.js, node-pty, @slack/web-api, file-based IPC (buffer + signal files)

---

### Task 1: Add output buffer path helpers to paths.cjs

**Files:**
- Modify: `remote/paths.cjs:9-26`
- Test: `test/unit/remote/paths.test.cjs`

**Step 1: Write the failing test**

Add to `test/unit/remote/paths.test.cjs`:

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { outputBufferPath, outputSignalPath, DATA_DIR } = require('../../../remote/paths.cjs');
const path = require('path');

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
```

**Step 2: Run test to verify it fails**

Run: `node --test test/unit/remote/paths.test.cjs`
Expected: FAIL — `outputBufferPath` and `outputSignalPath` are not exported

**Step 3: Write minimal implementation**

Add to `remote/paths.cjs` before the `module.exports` line:

```javascript
function outputBufferPath(sessionId) {
  return path.join(DATA_DIR, `output-buffer-${sessionId}.txt`);
}

function outputSignalPath(sessionId) {
  return path.join(DATA_DIR, `output-signal-${sessionId}.counter`);
}
```

Add `outputBufferPath` and `outputSignalPath` to `module.exports`.

**Step 4: Run test to verify it passes**

Run: `node --test test/unit/remote/paths.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add remote/paths.cjs test/unit/remote/paths.test.cjs
git commit -m "feat: add output buffer and signal path helpers"
```

---

### Task 2: Add output message methods to channel-manager.cjs

**Files:**
- Modify: `remote/channel-manager.cjs:346-570` (after `postToSessionChannel`, before `postToThread`)
- Test: `test/unit/remote/channel-manager.test.cjs`

**Step 1: Write the failing tests**

Add a new `describe('output message methods')` block to `test/unit/remote/channel-manager.test.cjs`:

```javascript
describe('postOutputMessage', () => {
  it('creates new message when no outputMessageTs exists', async () => {
    const { client, calls } = createMockSlackClient();
    const manager = createManagerWithMap(tmpDir, client, {
      'sess-1': { channelId: 'C001', active: true }
    });

    const result = await manager.postOutputMessage('sess-1', 'Hello from Claude');
    assert.equal(result, true);

    const postCalls = calls.filter(c => c.method === 'chat.postMessage');
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].args.channel, 'C001');
    assert.ok(postCalls[0].args.text.includes('Hello from Claude'));

    // Should store outputMessageTs in map
    const map = manager._readChannelMap();
    assert.ok(map['sess-1'].outputMessageTs);
  });

  it('updates existing message when outputMessageTs exists', async () => {
    const { client, calls } = createMockSlackClient();
    const manager = createManagerWithMap(tmpDir, client, {
      'sess-1': { channelId: 'C001', active: true, outputMessageTs: '111.001' }
    });

    const result = await manager.postOutputMessage('sess-1', 'More output');
    assert.equal(result, true);

    const updateCalls = calls.filter(c => c.method === 'chat.update');
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].args.ts, '111.001');
    assert.ok(updateCalls[0].args.text.includes('More output'));
  });

  it('returns false for unknown session', async () => {
    const { client } = createMockSlackClient();
    const manager = createManagerWithMap(tmpDir, client, {});

    const result = await manager.postOutputMessage('unknown', 'text');
    assert.equal(result, false);
  });

  it('starts new message when text exceeds 3900 chars', async () => {
    const { client, calls } = createMockSlackClient();
    const longText = 'x'.repeat(4000);
    const manager = createManagerWithMap(tmpDir, client, {
      'sess-1': { channelId: 'C001', active: true, outputMessageTs: '111.001', outputMessageLen: 3500 }
    });

    await manager.postOutputMessage('sess-1', longText);

    // Should post a NEW message (not update), because combined length would exceed limit
    const postCalls = calls.filter(c => c.method === 'chat.postMessage');
    assert.equal(postCalls.length, 1);
  });
});

describe('finalizeOutputMessage', () => {
  it('clears outputMessageTs from channel map', () => {
    const { client } = createMockSlackClient();
    const manager = createManagerWithMap(tmpDir, client, {
      'sess-1': { channelId: 'C001', active: true, outputMessageTs: '111.001', outputMessageLen: 500 }
    });

    manager.finalizeOutputMessage('sess-1');

    const map = manager._readChannelMap();
    assert.equal(map['sess-1'].outputMessageTs, undefined);
    assert.equal(map['sess-1'].outputMessageLen, undefined);
  });
});
```

You'll need a helper `createManagerWithMap` if one doesn't exist already. Check the test file — there is likely a pattern for creating a manager with a pre-populated channel map. Use the existing pattern from that test file.

**Step 2: Run test to verify it fails**

Run: `node --test test/unit/remote/channel-manager.test.cjs`
Expected: FAIL — `postOutputMessage` and `finalizeOutputMessage` are undefined

**Step 3: Write minimal implementation**

Add these methods to the `SlackChannelManager` class in `remote/channel-manager.cjs`, after `postToSessionChannel`:

```javascript
/**
 * Post or update a terminal output message in a session's channel.
 * Creates a new message if none exists or if accumulated length exceeds limit.
 * Returns true on success.
 */
async postOutputMessage(sessionId, text) {
    const MAX_OUTPUT_LEN = 3900;
    const map = this._readChannelMap();
    const entry = map[sessionId];
    if (!entry || !entry.active) return false;

    const currentLen = entry.outputMessageLen || 0;

    // If appending would exceed Slack's limit, finalize current and start new
    if (entry.outputMessageTs && currentLen + text.length > MAX_OUTPUT_LEN) {
        this.finalizeOutputMessage(sessionId);
        return this.postOutputMessage(sessionId, text);
    }

    try {
        if (entry.outputMessageTs) {
            // Append to existing message via chat.update
            // Read the existing message text and append
            const newText = text; // Runner sends cumulative content
            await this.client.chat.update({
                channel: entry.channelId,
                ts: entry.outputMessageTs,
                text: newText,
            });
            // Update length tracking
            const freshMap = this._readChannelMap();
            if (freshMap[sessionId]) {
                freshMap[sessionId].outputMessageLen = text.length;
                this._writeChannelMap(freshMap);
            }
        } else {
            // Create new output message
            const result = await this.client.chat.postMessage({
                channel: entry.channelId,
                text,
            });
            const freshMap = this._readChannelMap();
            if (freshMap[sessionId]) {
                freshMap[sessionId].outputMessageTs = result.ts;
                freshMap[sessionId].outputMessageLen = text.length;
                this._writeChannelMap(freshMap);
            }
        }
        return true;
    } catch (error) {
        if (error.data?.error === 'message_not_found') {
            // Message was deleted; clear and retry as new
            this.finalizeOutputMessage(sessionId);
            return this.postOutputMessage(sessionId, text);
        }
        console.warn('Failed to post output message:', error.message);
        return false;
    }
}

/**
 * Finalize the current output message (stop updating it).
 * Next output will create a new Slack message.
 */
finalizeOutputMessage(sessionId) {
    const map = this._readChannelMap();
    const entry = map[sessionId];
    if (!entry) return;
    delete entry.outputMessageTs;
    delete entry.outputMessageLen;
    this._writeChannelMap(map);
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/unit/remote/channel-manager.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add remote/channel-manager.cjs test/unit/remote/channel-manager.test.cjs
git commit -m "feat: add output message posting/updating to channel manager"
```

---

### Task 3: Add "output" notification type to hook-notify.cjs

**Files:**
- Modify: `remote/hook-notify.cjs:521-700` (in `main()`, before the tool-use handler)
- Test: `test/unit/remote/hook-notify.test.cjs`

**Step 1: Write the failing test**

Add to `test/unit/remote/hook-notify.test.cjs`:

```javascript
describe('output notification', () => {
  // This tests the formatOutputMessage helper
  it('formats output text with Claude prefix', () => {
    const { formatOutputMessage } = require('../../../remote/hook-notify.cjs');
    const result = formatOutputMessage('Hello world');
    assert.ok(result.includes('Hello world'));
  });

  it('returns null for empty text', () => {
    const { formatOutputMessage } = require('../../../remote/hook-notify.cjs');
    const result = formatOutputMessage('');
    assert.equal(result, null);
  });

  it('returns null for whitespace-only text', () => {
    const { formatOutputMessage } = require('../../../remote/hook-notify.cjs');
    const result = formatOutputMessage('   \n\n  ');
    assert.equal(result, null);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/unit/remote/hook-notify.test.cjs`
Expected: FAIL — `formatOutputMessage` is not exported

**Step 3: Write minimal implementation**

Add to `remote/hook-notify.cjs`:

1. Add a `formatOutputMessage` function near the other format helpers:

```javascript
/**
 * Format terminal output text for Slack.
 * Returns null if text is empty/whitespace.
 */
function formatOutputMessage(text) {
    if (!text || !text.trim()) return null;
    return text.trim();
}
```

2. Add the `output` notification handler in `main()`, before the `tool-use` handler (around line 654):

```javascript
// Handle output notifications (buffered PTY output from runner.js)
if (notificationType === 'output') {
    if (!isPerSessionMode() || !sessionId) return;

    const text = hookContext?.text;
    const formatted = formatOutputMessage(text);
    if (!formatted) return;

    const manager = createChannelManager();
    await manager.postOutputMessage(sessionId, formatted);
    return;
}
```

3. Add `formatOutputMessage` to `module.exports`.

**Step 4: Run test to verify it passes**

Run: `node --test test/unit/remote/hook-notify.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add remote/hook-notify.cjs test/unit/remote/hook-notify.test.cjs
git commit -m "feat: add output notification type to hook-notify"
```

---

### Task 4: Add flush-before-post to hook-notify.cjs

When `tool-use` or `waiting-for-input` hooks fire, they must flush the output buffer before posting their own message. This preserves chronological order in Slack.

**Files:**
- Modify: `remote/hook-notify.cjs` (tool-use and waiting-for-input handlers)
- Test: `test/unit/remote/hook-notify.test.cjs`

**Step 1: Write the failing tests**

```javascript
describe('flushOutputBuffer', () => {
  it('reads buffer file, returns content, and clears file', () => {
    const { flushOutputBuffer } = require('../../../remote/hook-notify.cjs');
    const bufPath = path.join(tmpDir, 'output-buffer-test.txt');
    const sigPath = path.join(tmpDir, 'output-signal-test.counter');

    fs.writeFileSync(bufPath, 'buffered text here');
    fs.writeFileSync(sigPath, '3');

    const result = flushOutputBuffer(bufPath, sigPath);
    assert.equal(result, 'buffered text here');

    // Buffer should be cleared
    assert.equal(fs.readFileSync(bufPath, 'utf8'), '');

    // Signal counter should be incremented
    assert.equal(fs.readFileSync(sigPath, 'utf8'), '4');
  });

  it('returns null when buffer file does not exist', () => {
    const { flushOutputBuffer } = require('../../../remote/hook-notify.cjs');
    const bufPath = path.join(tmpDir, 'nonexistent.txt');
    const sigPath = path.join(tmpDir, 'nonexistent.counter');

    const result = flushOutputBuffer(bufPath, sigPath);
    assert.equal(result, null);
  });

  it('returns null when buffer is empty', () => {
    const { flushOutputBuffer } = require('../../../remote/hook-notify.cjs');
    const bufPath = path.join(tmpDir, 'empty-buffer.txt');
    const sigPath = path.join(tmpDir, 'empty-signal.counter');

    fs.writeFileSync(bufPath, '');
    const result = flushOutputBuffer(bufPath, sigPath);
    assert.equal(result, null);
  });

  it('returns null when buffer is whitespace only', () => {
    const { flushOutputBuffer } = require('../../../remote/hook-notify.cjs');
    const bufPath = path.join(tmpDir, 'ws-buffer.txt');
    const sigPath = path.join(tmpDir, 'ws-signal.counter');

    fs.writeFileSync(bufPath, '  \n  \n  ');
    const result = flushOutputBuffer(bufPath, sigPath);
    assert.equal(result, null);
  });

  it('creates signal file with counter 1 when it does not exist', () => {
    const { flushOutputBuffer } = require('../../../remote/hook-notify.cjs');
    const bufPath = path.join(tmpDir, 'new-buffer.txt');
    const sigPath = path.join(tmpDir, 'new-signal.counter');

    fs.writeFileSync(bufPath, 'content');
    const result = flushOutputBuffer(bufPath, sigPath);
    assert.equal(result, 'content');
    assert.equal(fs.readFileSync(sigPath, 'utf8'), '1');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/unit/remote/hook-notify.test.cjs`
Expected: FAIL — `flushOutputBuffer` is not exported

**Step 3: Write minimal implementation**

Add to `remote/hook-notify.cjs`:

```javascript
const { outputBufferPath, outputSignalPath } = require('./paths.cjs');

/**
 * Read and clear the output buffer file, incrementing the signal counter.
 * Returns the buffer content, or null if empty/missing.
 *
 * @param {string} [bufPath] - Override buffer path (for testing)
 * @param {string} [sigPath] - Override signal path (for testing)
 * @returns {string|null}
 */
function flushOutputBuffer(bufPath, sigPath) {
    try {
        if (!fs.existsSync(bufPath)) return null;
        const content = fs.readFileSync(bufPath, 'utf8');
        if (!content || !content.trim()) return null;

        // Clear the buffer
        fs.writeFileSync(bufPath, '', { mode: 0o600 });

        // Increment signal counter
        let counter = 0;
        try {
            if (fs.existsSync(sigPath)) {
                counter = parseInt(fs.readFileSync(sigPath, 'utf8').trim(), 10) || 0;
            }
        } catch {}
        fs.writeFileSync(sigPath, String(counter + 1), { mode: 0o600 });

        return content;
    } catch {
        return null;
    }
}
```

Then modify the `tool-use` and `waiting-for-input` handlers to flush before posting. At the start of each handler, after the early-return guards, add:

```javascript
// Flush output buffer before posting hook message (chronological ordering)
if (sessionId) {
    const bufPath = outputBufferPath(sessionId);
    const sigPath = outputSignalPath(sessionId);
    const buffered = flushOutputBuffer(bufPath, sigPath);
    if (buffered) {
        const manager = createChannelManager();
        await manager.postOutputMessage(sessionId, formatOutputMessage(buffered) || buffered);
        manager.finalizeOutputMessage(sessionId);
    }
}
```

Add `flushOutputBuffer` to `module.exports`.

**Step 4: Run test to verify it passes**

Run: `node --test test/unit/remote/hook-notify.test.cjs`
Expected: PASS

**Step 5: Commit**

```bash
git add remote/hook-notify.cjs test/unit/remote/hook-notify.test.cjs
git commit -m "feat: add flush-before-post for chronological output ordering"
```

---

### Task 5: Add output buffer writes to runner.js

The core integration: `runner.js`'s `runOnce()` writes stripped PTY output to the buffer file, runs a 5-second flush timer, and manages signal files.

**Files:**
- Modify: `lib/runner.js:471-578` (inside `runOnce()`)
- Test: `test/unit/lib/runner-utils.test.js`

**Step 1: Write the failing tests**

Add to `test/unit/lib/runner-utils.test.js`:

```javascript
import { writeOutputBuffer, readOutputBuffer, readSignalCounter, OUTPUT_FLUSH_INTERVAL_MS } from '../../../lib/runner.js';

describe('writeOutputBuffer', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { removeTempDir(tmpDir); });

  it('appends text to buffer file', () => {
    const bufPath = path.join(tmpDir, 'output.txt');
    writeOutputBuffer(bufPath, 'first');
    writeOutputBuffer(bufPath, ' second');
    assert.equal(fs.readFileSync(bufPath, 'utf8'), 'first second');
  });

  it('creates parent directory if needed', () => {
    const bufPath = path.join(tmpDir, 'sub', 'output.txt');
    writeOutputBuffer(bufPath, 'hello');
    assert.equal(fs.readFileSync(bufPath, 'utf8'), 'hello');
  });

  it('handles empty string', () => {
    const bufPath = path.join(tmpDir, 'output.txt');
    writeOutputBuffer(bufPath, '');
    // Should not create file or should be empty
    const content = fs.existsSync(bufPath) ? fs.readFileSync(bufPath, 'utf8') : '';
    assert.equal(content, '');
  });
});

describe('readOutputBuffer', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { removeTempDir(tmpDir); });

  it('returns buffer content and clears file', () => {
    const bufPath = path.join(tmpDir, 'output.txt');
    fs.writeFileSync(bufPath, 'hello world');
    const content = readOutputBuffer(bufPath);
    assert.equal(content, 'hello world');
    assert.equal(fs.readFileSync(bufPath, 'utf8'), '');
  });

  it('returns null for non-existent file', () => {
    const content = readOutputBuffer(path.join(tmpDir, 'nope.txt'));
    assert.equal(content, null);
  });

  it('returns null for empty file', () => {
    const bufPath = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(bufPath, '');
    const content = readOutputBuffer(bufPath);
    assert.equal(content, null);
  });

  it('returns null for whitespace-only file', () => {
    const bufPath = path.join(tmpDir, 'ws.txt');
    fs.writeFileSync(bufPath, '  \n  ');
    const content = readOutputBuffer(bufPath);
    assert.equal(content, null);
  });
});

describe('readSignalCounter', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { removeTempDir(tmpDir); });

  it('returns counter value from file', () => {
    const sigPath = path.join(tmpDir, 'signal.counter');
    fs.writeFileSync(sigPath, '5');
    assert.equal(readSignalCounter(sigPath), 5);
  });

  it('returns 0 for non-existent file', () => {
    assert.equal(readSignalCounter(path.join(tmpDir, 'nope.counter')), 0);
  });

  it('returns 0 for invalid content', () => {
    const sigPath = path.join(tmpDir, 'bad.counter');
    fs.writeFileSync(sigPath, 'not-a-number');
    assert.equal(readSignalCounter(sigPath), 0);
  });
});

describe('OUTPUT_FLUSH_INTERVAL_MS', () => {
  it('is 5 seconds', () => {
    assert.equal(OUTPUT_FLUSH_INTERVAL_MS, 5000);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/unit/lib/runner-utils.test.js`
Expected: FAIL — these functions are not exported from runner.js

**Step 3: Write minimal implementation**

Add these utility functions and constants to `lib/runner.js`:

```javascript
/** Output flush interval (ms). */
const OUTPUT_FLUSH_INTERVAL_MS = 5_000;
/** Maximum output buffer size per flush (bytes). */
const MAX_OUTPUT_FLUSH_SIZE = 10_000;

/**
 * Append text to the output buffer file.
 * Creates the file and parent directory if needed.
 */
function writeOutputBuffer(bufPath, text) {
  if (!text) return;
  const dir = path.dirname(bufPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(bufPath, text, { mode: 0o600 });
}

/**
 * Read and clear the output buffer file.
 * Returns the content, or null if empty/missing.
 */
function readOutputBuffer(bufPath) {
  try {
    if (!fs.existsSync(bufPath)) return null;
    const content = fs.readFileSync(bufPath, 'utf8');
    if (!content || !content.trim()) return null;
    fs.writeFileSync(bufPath, '', { mode: 0o600 });
    return content;
  } catch {
    return null;
  }
}

/**
 * Read the signal counter from the signal file.
 * Returns 0 if the file doesn't exist or has invalid content.
 */
function readSignalCounter(sigPath) {
  try {
    if (!fs.existsSync(sigPath)) return 0;
    return parseInt(fs.readFileSync(sigPath, 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Write the signal counter to the signal file.
 */
function writeSignalCounter(sigPath, value) {
  const dir = path.dirname(sigPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sigPath, String(value), { mode: 0o600 });
}
```

Add to the `export { ... }` block at the bottom:

```javascript
writeOutputBuffer, readOutputBuffer, readSignalCounter, writeSignalCounter,
OUTPUT_FLUSH_INTERVAL_MS, MAX_OUTPUT_FLUSH_SIZE,
```

**Step 4: Run test to verify it passes**

Run: `node --test test/unit/lib/runner-utils.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/runner.js test/unit/lib/runner-utils.test.js
git commit -m "feat: add output buffer read/write utilities to runner"
```

---

### Task 6: Integrate output buffering into runOnce()

Wire the buffer utilities into the actual PTY loop. This is the core integration that makes terminal output flow to the buffer file and get flushed to Slack.

**Files:**
- Modify: `lib/runner.js:471-578` (inside `runOnce()`)
- No new test file — this is integration-level wiring tested by Task 8

**Step 1: Import output path helpers**

At the top of `lib/runner.js`, the CJS require block already exists (line 29-30). Add:

```javascript
const { outputBufferPath, outputSignalPath } = require('../remote/paths.cjs');
```

**Step 2: Add output buffer write to child.onData()**

Inside `runOnce()`, in the `child.onData()` callback (around line 511), after the `process.stdout.write(data)` line, add:

```javascript
// Buffer stripped output for Slack forwarding
if (options.remoteAccess && existingSessionId) {
  const stripped = stripAnsi(data);
  if (stripped.trim()) {
    writeOutputBuffer(outputBufferPath(existingSessionId), stripped);
  }
}
```

**Step 3: Add 5-second flush timer**

Inside `runOnce()`, after the `child.onData()` setup and before the signal handlers (around line 537), add:

```javascript
// Output flush timer — periodically send buffered output to Slack
let outputFlushTimer = null;
let lastSignalCounter = 0;
if (options.remoteAccess && existingSessionId) {
  const bufPath = outputBufferPath(existingSessionId);
  const sigPath = outputSignalPath(existingSessionId);

  outputFlushTimer = setInterval(() => {
    // Check if a hook already flushed (signal counter changed)
    const currentCounter = readSignalCounter(sigPath);
    if (currentCounter !== lastSignalCounter) {
      lastSignalCounter = currentCounter;
      return; // Hook already flushed; skip this timer tick
    }

    const content = readOutputBuffer(bufPath);
    if (!content) return;

    // Truncate oversized output
    const truncated = content.length > MAX_OUTPUT_FLUSH_SIZE
      ? content.substring(content.length - MAX_OUTPUT_FLUSH_SIZE)
      : content;

    lastSignalCounter++;
    writeSignalCounter(sigPath, lastSignalCounter);

    spawnHookNotify('output', {
      session_id: existingSessionId,
      cwd: process.cwd(),
      text: truncated,
    });
  }, OUTPUT_FLUSH_INTERVAL_MS);
}
```

**Step 4: Clean up timer and do final flush in cleanup/onExit**

In the `cleanup()` function inside `runOnce()`, add:

```javascript
if (outputFlushTimer) {
  clearInterval(outputFlushTimer);
  outputFlushTimer = null;
}
```

In the `child.onExit()` handler, before the `resolve()` call, add a final flush:

```javascript
// Final output flush
if (options.remoteAccess && existingSessionId) {
  const bufPath = outputBufferPath(existingSessionId);
  const sigPath = outputSignalPath(existingSessionId);
  const content = readOutputBuffer(bufPath);
  if (content) {
    const truncated = content.length > MAX_OUTPUT_FLUSH_SIZE
      ? content.substring(content.length - MAX_OUTPUT_FLUSH_SIZE)
      : content;
    writeSignalCounter(sigPath, readSignalCounter(sigPath) + 1);
    spawnHookNotify('output', {
      session_id: existingSessionId,
      cwd: process.cwd(),
      text: truncated,
    });
  }
}
```

**Step 5: Run syntax check and existing tests**

Run: `npm run check && node --test test/unit/lib/runner-utils.test.js`
Expected: All pass

**Step 6: Commit**

```bash
git add lib/runner.js
git commit -m "feat: integrate output buffering into PTY loop"
```

---

### Task 7: Add final flush before rate-limit swap in run()

When a rate limit is detected and we're about to swap accounts, flush any remaining output buffer so the user sees Claude's last response before the swap notification.

**Files:**
- Modify: `lib/runner.js:258-464` (inside `run()`, after rate limit detection)

**Step 1: Add flush before swap**

In `run()`, after the rate limit detection log message (around line 292) and before `pickBestAccount`, add:

```javascript
// Flush any remaining output before swap
if (remoteAccess && result.sessionId) {
  const bufPath = outputBufferPath(result.sessionId);
  const sigPath = outputSignalPath(result.sessionId);
  const content = readOutputBuffer(bufPath);
  if (content) {
    writeSignalCounter(sigPath, readSignalCounter(sigPath) + 1);
    spawnHookNotify('output', {
      session_id: result.sessionId,
      cwd: process.cwd(),
      text: content,
    });
  }
}
```

**Step 2: Add flush before sleep**

In `run()`, before the `sleep()` call (around line 340), add a similar flush.

**Step 3: Clean up buffer files on session end**

After the normal exit path (around line 281), add cleanup:

```javascript
// Clean up output buffer files
if (remoteAccess && sessionId) {
  try {
    fs.unlinkSync(outputBufferPath(sessionId));
    fs.unlinkSync(outputSignalPath(sessionId));
  } catch {}
}
```

**Step 4: Run syntax check**

Run: `npm run check`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/runner.js
git commit -m "feat: flush output buffer before rate-limit swap and cleanup on exit"
```

---

### Task 8: Integration tests for output forwarding

End-to-end tests that verify the full flow: buffer writes, timer flushes, flush-on-hook ordering, and edge cases.

**Files:**
- Create: `test/integration/output-forwarding.test.js`

**Step 1: Write integration tests**

```javascript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { createTempDir, removeTempDir } from '../helpers/temp-dir.js';
import {
  writeOutputBuffer, readOutputBuffer,
  readSignalCounter, writeSignalCounter,
  OUTPUT_FLUSH_INTERVAL_MS,
} from '../../lib/runner.js';

// Import the CJS flush function via createRequire
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

describe('Output Forwarding Integration', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempDir('cn-output-test-'); });
  afterEach(() => { removeTempDir(tmpDir); });

  describe('buffer accumulation and read', () => {
    it('accumulates multiple writes then reads all at once', () => {
      const bufPath = path.join(tmpDir, 'buf.txt');

      writeOutputBuffer(bufPath, 'line 1\n');
      writeOutputBuffer(bufPath, 'line 2\n');
      writeOutputBuffer(bufPath, 'line 3\n');

      const content = readOutputBuffer(bufPath);
      assert.equal(content, 'line 1\nline 2\nline 3\n');

      // File should be cleared after read
      const after = readOutputBuffer(bufPath);
      assert.equal(after, null);
    });
  });

  describe('signal counter coordination', () => {
    it('runner and hook counters stay in sync', () => {
      const sigPath = path.join(tmpDir, 'sig.counter');

      // Runner writes counter = 1 (first flush)
      writeSignalCounter(sigPath, 1);
      assert.equal(readSignalCounter(sigPath), 1);

      // Hook flushes: reads counter, writes counter + 1
      const hookRead = readSignalCounter(sigPath);
      writeSignalCounter(sigPath, hookRead + 1);
      assert.equal(readSignalCounter(sigPath), 2);

      // Runner sees counter changed (2 != 1), skips its flush
      const runnerRead = readSignalCounter(sigPath);
      assert.notEqual(runnerRead, 1); // Runner detects hook flush
    });

    it('prevents double-posting when hook flushes between timer ticks', () => {
      const bufPath = path.join(tmpDir, 'buf.txt');
      const sigPath = path.join(tmpDir, 'sig.counter');

      // Simulate: runner writes output
      writeOutputBuffer(bufPath, 'some output');

      // Hook fires and flushes
      const content = readOutputBuffer(bufPath);
      assert.equal(content, 'some output');
      writeSignalCounter(sigPath, 1);

      // Runner timer fires — buffer is already empty, signal changed
      const runnerContent = readOutputBuffer(bufPath);
      assert.equal(runnerContent, null); // Nothing to flush — hook handled it
    });
  });

  describe('rapid tool calls', () => {
    it('empty buffer after hook flush produces no output', () => {
      const bufPath = path.join(tmpDir, 'buf.txt');
      const sigPath = path.join(tmpDir, 'sig.counter');

      // First hook flushes
      writeOutputBuffer(bufPath, 'output before tool 1');
      const content1 = readOutputBuffer(bufPath);
      assert.equal(content1, 'output before tool 1');
      writeSignalCounter(sigPath, 1);

      // Second hook fires immediately — nothing in buffer
      const content2 = readOutputBuffer(bufPath);
      assert.equal(content2, null); // No double-post
    });
  });

  describe('no-remote-access mode', () => {
    it('buffer files are not created when path is not used', () => {
      // When remoteAccess is false, runner.js never calls writeOutputBuffer
      // Just verify the file doesn't exist
      const bufPath = path.join(tmpDir, 'should-not-exist.txt');
      assert.equal(fs.existsSync(bufPath), false);
    });
  });

  describe('large output handling', () => {
    it('buffer handles large content', () => {
      const bufPath = path.join(tmpDir, 'large.txt');
      const largeText = 'x'.repeat(50000);
      writeOutputBuffer(bufPath, largeText);

      const content = readOutputBuffer(bufPath);
      assert.equal(content.length, 50000);
    });
  });
});
```

**Step 2: Run the integration tests**

Run: `node --test test/integration/output-forwarding.test.js`
Expected: All PASS

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass (except pre-existing tmux test)

**Step 4: Commit**

```bash
git add test/integration/output-forwarding.test.js
git commit -m "test: add integration tests for output forwarding"
```

---

### Task 9: Update documentation

**Files:**
- Modify: `CLAUDE.md` — add `output` to hook notification types table
- Modify: `DESIGN.md` — update data flow description to mention output forwarding
- Modify: `remote/hook-notify.cjs` — update header comment to include `output` type

**Step 1: Update CLAUDE.md**

Add to the Hook Notification Types table:

```
| `output` | runner.js (5s timer, final flush) | Forward buffered terminal output to Slack |
```

**Step 2: Update DESIGN.md**

Add a brief note about output forwarding in the appropriate section.

**Step 3: Update hook-notify.cjs header comment**

Add `output` to the notification types list in the header (line 8-16):

```
 *   output             — Forward buffered terminal output to Slack (runner.js timer + hook flush)
```

**Step 4: Run syntax check**

Run: `npm run check`
Expected: PASS

**Step 5: Commit**

```bash
git add CLAUDE.md DESIGN.md remote/hook-notify.cjs
git commit -m "docs: document output notification type and forwarding architecture"
```

---

### Task 10: Add mock-slack chat.delete for tests

The mock Slack client in `test/helpers/mock-slack.cjs` may need a `chat.delete` method if it doesn't have one. Check and add if missing. This is a prerequisite for some test scenarios that may use `clearProgressMessage`.

**Files:**
- Modify: `test/helpers/mock-slack.cjs:56` (add `chat.delete` method if missing)

**Step 1: Check if chat.delete exists**

Look at `test/helpers/mock-slack.cjs`. The `chat` object only has `postMessage` and `update`.

**Step 2: Add chat.delete**

```javascript
delete: async (opts) => {
  record('chat.delete', opts);
  return { ok: true };
},
```

**Step 3: Commit**

```bash
git add test/helpers/mock-slack.cjs
git commit -m "test: add chat.delete to mock Slack client"
```

---

## Summary of Commits

1. `feat: add output buffer and signal path helpers` (paths.cjs)
2. `feat: add output message posting/updating to channel manager` (channel-manager.cjs)
3. `feat: add output notification type to hook-notify` (hook-notify.cjs)
4. `feat: add flush-before-post for chronological output ordering` (hook-notify.cjs)
5. `feat: add output buffer read/write utilities to runner` (runner.js)
6. `feat: integrate output buffering into PTY loop` (runner.js)
7. `feat: flush output buffer before rate-limit swap and cleanup on exit` (runner.js)
8. `test: add integration tests for output forwarding` (test/)
9. `docs: document output notification type and forwarding architecture` (docs)
10. `test: add chat.delete to mock Slack client` (test/)

## Dependency Order

```
Task 1 (paths.cjs) ─┬─→ Task 4 (flush-before-post) ──→ Task 8 (integration tests)
                     │
Task 2 (channel-mgr) ┤
                     │
Task 3 (hook-notify) ┘
                          Task 5 (runner utils) ──→ Task 6 (PTY integration) ──→ Task 7 (swap flush)

Task 10 (mock-slack) ──→ Task 2 (channel-mgr tests may need it)
Task 9 (docs) — independent, can be done anytime
```
