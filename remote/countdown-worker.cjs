#!/usr/bin/env node

/**
 * Detached countdown worker — updates a Slack message every 5 minutes
 * with remaining time until wake. Spawned by hook-notify.cjs on sleep-until-reset.
 *
 * Usage: node countdown-worker.cjs <channelId> <messageTs> <wakeAtIso>
 *
 * Exits when wake time is reached or the message is deleted.
 */

require('./load-env.cjs');

const { WebClient } = require('@slack/web-api');

const UPDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function formatCountdown(ms) {
    if (ms <= 0) return 'now';
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function buildCountdownText(wakeAt) {
    const now = Date.now();
    const remaining = wakeAt - now;
    if (remaining <= 0) {
        return ':sunrise: Waking up now...';
    }
    const wakeTime = new Date(wakeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `:zzz: All accounts exhausted. Waking at ${wakeTime} (${formatCountdown(remaining)} remaining)`;
}

async function main() {
    const [,, channelId, messageTs, wakeAtIso] = process.argv;
    if (!channelId || !messageTs || !wakeAtIso) {
        process.exit(1);
    }

    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
        process.exit(1);
    }

    const wakeAt = new Date(wakeAtIso).getTime();
    if (isNaN(wakeAt)) {
        process.exit(1);
    }

    const client = new WebClient(botToken);

    while (Date.now() < wakeAt) {
        const remaining = wakeAt - Date.now();
        const waitMs = Math.min(UPDATE_INTERVAL_MS, remaining);
        await new Promise(resolve => setTimeout(resolve, waitMs));

        try {
            const text = buildCountdownText(wakeAt);
            await client.chat.update({
                channel: channelId,
                ts: messageTs,
                text,
            });
        } catch (error) {
            if (error.data?.error === 'message_not_found') {
                // Message was deleted (wake already happened), exit
                return;
            }
            // Other errors: continue trying
        }
    }
}

if (require.main === module) {
    main().catch(() => process.exit(1));
}

module.exports = { formatCountdown, buildCountdownText, UPDATE_INTERVAL_MS };
