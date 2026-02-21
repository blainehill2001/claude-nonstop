/**
 * Shared path constants for CJS remote/ modules.
 * Must stay in sync with lib/config.js CONFIG_DIR.
 */

const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.claude-nonstop');
const ENV_PATH = path.join(CONFIG_DIR, '.env');
const DATA_DIR = path.join(CONFIG_DIR, 'data');
const CHANNEL_MAP_PATH = path.join(DATA_DIR, 'channel-map.json');
const PROGRESS_DIR = path.join(DATA_DIR, 'progress');
const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'webhook.log');

const MESSAGE_QUEUE_PATH = path.join(DATA_DIR, 'message-queue.json');

/**
 * Expand ~ to homedir in a path string.
 */
function expandPath(p) {
  return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
}

function outputBufferPath(sessionId) {
  return path.join(DATA_DIR, `output-buffer-${sessionId}.txt`);
}

function outputSignalPath(sessionId) {
  return path.join(DATA_DIR, `output-signal-${sessionId}.counter`);
}

module.exports = { CONFIG_DIR, ENV_PATH, DATA_DIR, CHANNEL_MAP_PATH, PROGRESS_DIR, LOG_DIR, LOG_PATH, MESSAGE_QUEUE_PATH, expandPath, outputBufferPath, outputSignalPath };
