/**
 * Structured JSON Lines logger (ESM wrapper).
 *
 * Re-exports the CJS logger for use in ESM modules (lib/).
 * See remote/logger.cjs for implementation details.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLogger, rotateIfNeeded, MAX_LOG_SIZE, MAX_ROTATED, LOG_DIR } = require('../remote/logger.cjs');

export { createLogger, rotateIfNeeded, MAX_LOG_SIZE, MAX_ROTATED, LOG_DIR };
