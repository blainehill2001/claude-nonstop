/**
 * Load .env from ~/.claude-nonstop/.env.
 * Simple parser — no dotenv dependency needed.
 * Existing env vars are NOT overwritten.
 */

const path = require('path');
const fs = require('fs');
const { ENV_PATH } = require('./paths.cjs');

// One-time migration: move legacy project-root .env to correct location
const legacyEnvPath = path.join(__dirname, '..', '.env');
if (!fs.existsSync(ENV_PATH) && fs.existsSync(legacyEnvPath)) {
    try {
        const dir = path.dirname(ENV_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(legacyEnvPath, ENV_PATH);
        fs.unlinkSync(legacyEnvPath);
    } catch {
        // Migration failed — continue without legacy file
    }
}

if (fs.existsSync(ENV_PATH)) {
    const envContent = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        let value = trimmed.substring(eqIdx + 1).trim();
        // Strip surrounding quotes (single or double)
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}
