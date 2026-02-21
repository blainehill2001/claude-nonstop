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

// Import CJS flush function
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { flushOutputBuffer } = require('../../remote/hook-notify.cjs');

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

    it('handles interleaved writes and reads', () => {
      const bufPath = path.join(tmpDir, 'buf.txt');
      writeOutputBuffer(bufPath, 'chunk1');
      const first = readOutputBuffer(bufPath);
      assert.equal(first, 'chunk1');

      writeOutputBuffer(bufPath, 'chunk2');
      writeOutputBuffer(bufPath, 'chunk3');
      const second = readOutputBuffer(bufPath);
      assert.equal(second, 'chunk2chunk3');
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
      assert.notEqual(runnerRead, 1);
    });

    it('prevents double-posting when hook flushes between timer ticks', () => {
      const bufPath = path.join(tmpDir, 'buf.txt');
      const sigPath = path.join(tmpDir, 'sig.counter');

      // Runner writes output
      writeOutputBuffer(bufPath, 'some output');

      // Hook fires and flushes (simulating flushOutputBuffer)
      const content = readOutputBuffer(bufPath);
      assert.equal(content, 'some output');
      writeSignalCounter(sigPath, 1);

      // Runner timer fires — buffer is already empty, signal changed
      const runnerContent = readOutputBuffer(bufPath);
      assert.equal(runnerContent, null); // Nothing to flush
    });

    it('hook flush via flushOutputBuffer reads content and increments counter', () => {
      const bufPath = path.join(tmpDir, 'buf.txt');
      const sigPath = path.join(tmpDir, 'sig.counter');

      writeOutputBuffer(bufPath, 'text before tool');
      writeSignalCounter(sigPath, 3);

      const flushed = flushOutputBuffer(bufPath, sigPath);
      assert.equal(flushed, 'text before tool');
      assert.equal(fs.readFileSync(bufPath, 'utf8'), '');
      assert.equal(readSignalCounter(sigPath), 4);
    });
  });

  describe('rapid tool calls (flush-on-hook)', () => {
    it('empty buffer after hook flush produces no output', () => {
      const bufPath = path.join(tmpDir, 'buf.txt');
      const sigPath = path.join(tmpDir, 'sig.counter');

      // First hook flushes
      writeOutputBuffer(bufPath, 'output before tool 1');
      const content1 = flushOutputBuffer(bufPath, sigPath);
      assert.equal(content1, 'output before tool 1');

      // Second hook fires immediately — nothing in buffer
      const content2 = flushOutputBuffer(bufPath, sigPath);
      assert.equal(content2, null); // No double-post
    });

    it('new output between rapid hooks is captured', () => {
      const bufPath = path.join(tmpDir, 'buf.txt');
      const sigPath = path.join(tmpDir, 'sig.counter');

      // First hook
      writeOutputBuffer(bufPath, 'before tool 1');
      flushOutputBuffer(bufPath, sigPath);

      // New output arrives between hooks
      writeOutputBuffer(bufPath, 'between tools');

      // Second hook
      const content = flushOutputBuffer(bufPath, sigPath);
      assert.equal(content, 'between tools');
    });
  });

  describe('runner-hook coordination sequence', () => {
    it('full sequence: write -> timer flush -> write -> hook flush -> timer skip', () => {
      const bufPath = path.join(tmpDir, 'buf.txt');
      const sigPath = path.join(tmpDir, 'sig.counter');
      let runnerCounter = 0;

      // Step 1: PTY output arrives
      writeOutputBuffer(bufPath, 'hello ');

      // Step 2: Runner timer fires (simulated)
      const timerContent = readOutputBuffer(bufPath);
      assert.equal(timerContent, 'hello ');
      runnerCounter++;
      writeSignalCounter(sigPath, runnerCounter);

      // Step 3: More PTY output
      writeOutputBuffer(bufPath, 'world');

      // Step 4: Hook fires and flushes before its own message
      const hookContent = flushOutputBuffer(bufPath, sigPath);
      assert.equal(hookContent, 'world');

      // Step 5: Runner timer fires again — sees counter changed
      const currentCounter = readSignalCounter(sigPath);
      assert.notEqual(currentCounter, runnerCounter); // Counter was incremented by hook
      // Runner would skip this tick

      // Step 6: More output, runner timer fires normally
      writeOutputBuffer(bufPath, 'more text');
      runnerCounter = currentCounter; // Runner syncs to hook's counter
      const nextContent = readOutputBuffer(bufPath);
      assert.equal(nextContent, 'more text');
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

    it('multiple large writes accumulate', () => {
      const bufPath = path.join(tmpDir, 'large.txt');
      for (let i = 0; i < 10; i++) {
        writeOutputBuffer(bufPath, 'x'.repeat(1000));
      }
      const content = readOutputBuffer(bufPath);
      assert.equal(content.length, 10000);
    });
  });

  describe('edge cases', () => {
    it('flush constants are correct', () => {
      assert.equal(OUTPUT_FLUSH_INTERVAL_MS, 5000);
    });

    it('readOutputBuffer on non-existent file returns null', () => {
      assert.equal(readOutputBuffer(path.join(tmpDir, 'no-such-file.txt')), null);
    });

    it('flushOutputBuffer on non-existent file returns null', () => {
      const result = flushOutputBuffer(
        path.join(tmpDir, 'no.txt'),
        path.join(tmpDir, 'no.counter')
      );
      assert.equal(result, null);
    });

    it('buffer with only whitespace returns null', () => {
      const bufPath = path.join(tmpDir, 'ws.txt');
      writeOutputBuffer(bufPath, '   \n   \n   ');
      // readOutputBuffer returns null for whitespace-only
      assert.equal(readOutputBuffer(bufPath), null);
    });
  });
});
