#!/usr/bin/env node

/**
 * Detached rename worker — spawned by hook-notify.cjs to run independently.
 *
 * Usage:  node rename-worker.cjs <sessionId> <userPrompt> <channelPrefix>
 *
 * Generates a slug from the user prompt via Gemini API (or text fallback),
 * then renames the Slack channel. Runs detached so the parent hook process
 * can exit immediately.
 */

require('./load-env.cjs');

const SlackChannelManager = require('./channel-manager.cjs');

// Reuse slug helpers from hook-notify (avoids duplication)
const { spawnSlug, generateSlugName } = require('./hook-notify.cjs');

async function main() {
    const [,, sessionId, userPrompt, channelPrefix] = process.argv;
    if (!sessionId || !userPrompt) {
        process.exit(1);
    }

    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
        process.exit(1);
    }

    const manager = new SlackChannelManager({
        botToken,
        inviteUserId: process.env.SLACK_INVITE_USER_ID,
        channelPrefix: channelPrefix || 'cn',
    });

    const mapping = manager.getChannelMapping(sessionId);
    if (!mapping || mapping.renamed) {
        return; // Already renamed or unknown session
    }

    try {
        // Try AI-generated slug first, fall back to text-processing
        let slug = null;
        const raw = await spawnSlug(userPrompt);
        if (raw) {
            slug = generateSlugName(raw);
        }
        if (!slug) {
            // Fallback: extract slug from first words of prompt
            slug = generateSlugName(userPrompt);
        }
        if (!slug) return;

        const safeProject = mapping.project
            ? generateSlugName(mapping.project) + '-'
            : '';
        const newName = `${channelPrefix || 'cn'}-${safeProject}${slug}`
            .substring(0, 80)
            .replace(/-$/, '');

        const renamed = await manager.renameChannel(sessionId, newName);
        if (renamed) {
            console.log(`Renamed channel to #${newName}`);
        }
    } catch (err) {
        console.warn('Rename worker failed:', err.message);
    }
}

if (require.main === module) {
    main().catch(() => process.exit(1));
}
