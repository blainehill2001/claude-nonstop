/**
 * Structured JSON Lines logger with rotation.
 *
 * Each log entry is a single-line JSON object (JSONL format).
 * Rotates at 10MB, keeps 3 rotated files (.1, .2, .3).
 * No external dependencies.
 */

const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('./paths.cjs');

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED = 3;

/**
 * Rotate a log file if it exceeds MAX_LOG_SIZE.
 * Shifts .1 → .2, .2 → .3, removes .3, renames current → .1.
 */
function rotateIfNeeded(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        const stats = fs.statSync(filePath);
        if (stats.size < MAX_LOG_SIZE) return;

        // Shift existing rotated files
        for (let i = MAX_ROTATED; i >= 1; i--) {
            const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
            const to = `${filePath}.${i}`;
            try {
                if (i === MAX_ROTATED && fs.existsSync(to)) {
                    fs.unlinkSync(to);
                }
                if (fs.existsSync(from)) {
                    fs.renameSync(from, to);
                }
            } catch { /* best effort */ }
        }
    } catch { /* non-fatal */ }
}

/**
 * Create a logger for a given component.
 *
 * @param {string} component - Logger name (e.g. 'runner', 'webhook', 'hooks')
 * @returns {{ info: function, warn: function, error: function }}
 */
function createLogger(component) {
    const logFile = path.join(LOG_DIR, `${component}.jsonl`);

    function write(level, event, data = {}) {
        try {
            const dir = path.dirname(logFile);
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
        } catch { /* logging should never crash the process */ }
    }

    return {
        info: (event, data) => write('info', event, data),
        warn: (event, data) => write('warn', event, data),
        error: (event, data) => write('error', event, data),
    };
}

module.exports = { createLogger, rotateIfNeeded, MAX_LOG_SIZE, MAX_ROTATED, LOG_DIR };
