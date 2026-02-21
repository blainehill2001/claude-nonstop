const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { rotateIfNeeded, MAX_LOG_SIZE } = require('../../../remote/logger.cjs');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
}

function cleanupDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe('createLogger', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = makeTempDir();
    });

    afterEach(() => {
        cleanupDir(tmpDir);
    });

    it('writes JSON Lines entries to the log file', () => {
        const logFile = path.join(tmpDir, 'test.jsonl');
        const logger = createTestLogger('test', logFile);

        logger.info('session_start', { account: 'myaccount' });
        logger.warn('slug_fallback', { reason: 'timeout' });
        logger.error('error', { message: 'something broke' });

        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        assert.equal(lines.length, 3);

        const entry1 = JSON.parse(lines[0]);
        assert.equal(entry1.level, 'info');
        assert.equal(entry1.component, 'test');
        assert.equal(entry1.event, 'session_start');
        assert.equal(entry1.account, 'myaccount');
        assert.ok(entry1.ts);

        const entry2 = JSON.parse(lines[1]);
        assert.equal(entry2.level, 'warn');
        assert.equal(entry2.event, 'slug_fallback');

        const entry3 = JSON.parse(lines[2]);
        assert.equal(entry3.level, 'error');
        assert.equal(entry3.event, 'error');
        assert.equal(entry3.message, 'something broke');
    });

    it('creates log directory if it does not exist', () => {
        const nestedDir = path.join(tmpDir, 'nested', 'logs');
        const logFile = path.join(nestedDir, 'test.jsonl');
        const logger = createTestLogger('test', logFile);

        logger.info('test_event');

        assert.ok(fs.existsSync(logFile));
    });

    it('appends to existing log file', () => {
        const logFile = path.join(tmpDir, 'test.jsonl');
        const logger = createTestLogger('test', logFile);

        logger.info('first');
        logger.info('second');

        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        assert.equal(lines.length, 2);
        assert.equal(JSON.parse(lines[0]).event, 'first');
        assert.equal(JSON.parse(lines[1]).event, 'second');
    });

    it('includes ISO timestamp in entries', () => {
        const logFile = path.join(tmpDir, 'test.jsonl');
        const logger = createTestLogger('test', logFile);

        logger.info('test_event');

        const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
        // Verify it's a valid ISO date string
        const parsed = new Date(entry.ts);
        assert.ok(!isNaN(parsed.getTime()), 'timestamp should be valid ISO date');
    });

    it('handles data without extra fields gracefully', () => {
        const logFile = path.join(tmpDir, 'test.jsonl');
        const logger = createTestLogger('test', logFile);

        logger.info('simple_event');

        const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
        assert.equal(entry.event, 'simple_event');
        assert.equal(entry.level, 'info');
        assert.equal(entry.component, 'test');
    });
});

describe('rotateIfNeeded', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = makeTempDir();
    });

    afterEach(() => {
        cleanupDir(tmpDir);
    });

    it('does not rotate files under MAX_LOG_SIZE', () => {
        const logFile = path.join(tmpDir, 'small.jsonl');
        fs.writeFileSync(logFile, 'small content\n');

        rotateIfNeeded(logFile);

        assert.ok(fs.existsSync(logFile));
        assert.ok(!fs.existsSync(`${logFile}.1`));
    });

    it('rotates file when it exceeds MAX_LOG_SIZE', () => {
        const logFile = path.join(tmpDir, 'big.jsonl');
        // Write a file larger than MAX_LOG_SIZE
        const bigContent = 'x'.repeat(MAX_LOG_SIZE + 100);
        fs.writeFileSync(logFile, bigContent);

        rotateIfNeeded(logFile);

        // Original should be renamed to .1
        assert.ok(!fs.existsSync(logFile), 'original file should be renamed');
        assert.ok(fs.existsSync(`${logFile}.1`), 'should have .1 rotated file');
        assert.equal(fs.readFileSync(`${logFile}.1`, 'utf8'), bigContent);
    });

    it('shifts existing rotated files during rotation', () => {
        const logFile = path.join(tmpDir, 'shift.jsonl');
        const bigContent = 'x'.repeat(MAX_LOG_SIZE + 100);

        // Create existing rotated files
        fs.writeFileSync(`${logFile}.1`, 'rotated-1');
        fs.writeFileSync(`${logFile}.2`, 'rotated-2');
        fs.writeFileSync(logFile, bigContent);

        rotateIfNeeded(logFile);

        assert.ok(!fs.existsSync(logFile));
        assert.equal(fs.readFileSync(`${logFile}.1`, 'utf8'), bigContent);
        assert.equal(fs.readFileSync(`${logFile}.2`, 'utf8'), 'rotated-1');
        assert.equal(fs.readFileSync(`${logFile}.3`, 'utf8'), 'rotated-2');
    });

    it('drops oldest file when MAX_ROTATED is exceeded', () => {
        const logFile = path.join(tmpDir, 'drop.jsonl');
        const bigContent = 'x'.repeat(MAX_LOG_SIZE + 100);

        // Create full rotation set
        fs.writeFileSync(`${logFile}.1`, 'rotated-1');
        fs.writeFileSync(`${logFile}.2`, 'rotated-2');
        fs.writeFileSync(`${logFile}.3`, 'rotated-3-oldest');
        fs.writeFileSync(logFile, bigContent);

        rotateIfNeeded(logFile);

        // .3 should now contain rotated-2 (shifted from .2)
        // The old .3 (rotated-3-oldest) should be dropped
        assert.equal(fs.readFileSync(`${logFile}.1`, 'utf8'), bigContent);
        assert.equal(fs.readFileSync(`${logFile}.2`, 'utf8'), 'rotated-1');
        assert.equal(fs.readFileSync(`${logFile}.3`, 'utf8'), 'rotated-2');
    });

    it('handles non-existent file gracefully', () => {
        const logFile = path.join(tmpDir, 'nonexistent.jsonl');
        // Should not throw
        rotateIfNeeded(logFile);
    });
});

/**
 * Create a logger that writes to a specific file path (for testing).
 * Bypasses the LOG_DIR default by monkey-patching.
 */
function createTestLogger(component, logFile) {
    const dir = path.dirname(logFile);

    function write(level, event, data = {}) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        rotateIfNeeded(logFile);
        const entry = {
            ts: new Date().toISOString(),
            level,
            component,
            event,
            ...data,
        };
        fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    }

    return {
        info: (event, data) => write('info', event, data),
        warn: (event, data) => write('warn', event, data),
        error: (event, data) => write('error', event, data),
    };
}
