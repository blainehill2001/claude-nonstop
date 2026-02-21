/**
 * Slack Webhook Handler
 * Handles incoming messages from Slack via Socket Mode.
 * Relays messages to Claude Code tmux sessions.
 */

const { App } = require('@slack/bolt');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const SlackChannelManager = require('./channel-manager.cjs');
const { enqueueMessage } = SlackChannelManager;

class SlackWebhook {
    constructor(config = {}) {
        this.config = config;
        this.app = null;
        this._channelManager = null;
    }

    _getChannelManager() {
        if (!this._channelManager) {
            this._channelManager = new SlackChannelManager({
                botToken: this.config.botToken,
                inviteUserId: process.env.SLACK_INVITE_USER_ID,
                channelPrefix: process.env.SLACK_CHANNEL_PREFIX ?? ''
            });
        }
        return this._channelManager;
    }

    _isUserAllowed(userId) {
        if (!this.config.allowedUsers || this.config.allowedUsers.length === 0) {
            return true;
        }
        return this.config.allowedUsers.includes(userId);
    }

    async start() {
        if (!this.config.botToken || !this.config.appToken) {
            console.error('Slack Bot Token and App Token are required');
            return;
        }

        this.app = new App({
            token: this.config.botToken,
            appToken: this.config.appToken,
            socketMode: true
        });

        // Handle messages in session channels and DMs
        this.app.message(async ({ message, say }) => {
          try {
            if (message.subtype || message.bot_id) return;

            const text = message.text?.trim() || '';
            if (!text) return;
            console.log(`Received message in channel ${message.channel} (${text.length} chars)`);

            // Per-session channel handling
            const channelManager = this._getChannelManager();
            const sessionInfo = channelManager.getSessionByChannelId(message.channel);
            if (sessionInfo && sessionInfo.active) {
                if (!this._isUserAllowed(message.user)) {
                    await say(':no_entry: You are not authorized to send commands.');
                    return;
                }

                if (text === '!archive') {
                    await say(':file_folder: Archiving this session channel...');
                    await channelManager.archiveChannel(message.channel);
                    return;
                }

                if (text === '!stop') {
                    if (sessionInfo.tmuxSession) {
                        try {
                            await execFileAsync('tmux', ['send-keys', '-t', sessionInfo.tmuxSession, 'C-c'], { timeout: 5000 });
                            await say(':stop_sign: Sent interrupt to Claude');
                        } catch {
                            await say(':warning: Failed to send interrupt — tmux session may have ended');
                        }
                    } else {
                        await say('No tmux session associated with this channel.');
                    }
                    return;
                }

                if (text === '!status') {
                    if (sessionInfo.tmuxSession) {
                        try {
                            // Session metadata header
                            const status = sessionInfo.sleeping ? ':zzz: sleeping' :
                                sessionInfo.paused ? ':double_vertical_bar: paused' : ':green_circle: running';
                            const project = sessionInfo.cwd ? sessionInfo.cwd.split('/').pop() : 'unknown';
                            const header = `*${project}* | ${status} | tmux: \`${sessionInfo.tmuxSession}\``;

                            const { stdout } = await execFileAsync('tmux', ['capture-pane', '-p', '-t', sessionInfo.tmuxSession], {
                                encoding: 'utf8',
                                timeout: 5000,
                            });
                            let paneContent = (stdout || '').trimEnd();
                            if (paneContent.length > 3800) {
                                paneContent = paneContent.substring(paneContent.length - 3800);
                            }
                            await say(header + '\n```\n' + paneContent + '\n```');
                        } catch {
                            await say(':warning: Failed to capture terminal — tmux session may have ended');
                        }
                    } else {
                        await say('No tmux session associated with this channel.');
                    }
                    return;
                }

                if (text === '!help') {
                    await say(':information_source: *Available commands:*\n\u2022 `!stop` \u2014 interrupt Claude (Ctrl+C)\n\u2022 `!status` \u2014 show current terminal output\n\u2022 `!cmd <text>` \u2014 relay text verbatim (e.g. `!cmd /clear`)\n\u2022 `!archive` \u2014 archive this channel\n\u2022 `!help` \u2014 show this help');
                    return;
                }

                if (text.startsWith('!cmd ')) {
                    const cmdText = text.slice(5);
                    if (!cmdText) return;
                    if (sessionInfo.tmuxSession) {
                        const relayOk = await this._executeTmuxCommand(cmdText, { tmuxSession: sessionInfo.tmuxSession });
                        if (!relayOk) {
                            await say(':warning: Failed to relay message \u2014 tmux session may have ended');
                        }
                    } else {
                        await say('No tmux session associated with this channel.');
                    }
                    return;
                }

                // If session is sleeping or paused, queue message for later replay
                if (sessionInfo.sleeping || sessionInfo.paused) {
                    enqueueMessage({
                        text,
                        channelId: message.channel,
                        userId: message.user,
                        timestamp: Date.now(),
                        tmuxSession: sessionInfo.tmuxSession,
                    });
                    await say(':zzz: Queued \u2014 will be sent when session wakes up.');
                    return;
                }

                if (sessionInfo.tmuxSession) {
                    await channelManager.setTypingIndicator(message.channel, message.ts);
                    const relayOk = await this._executeTmuxCommand(text, { tmuxSession: sessionInfo.tmuxSession });
                    if (!relayOk) {
                        await say(':warning: Failed to relay message \u2014 tmux session may have ended');
                    }
                } else {
                    await say('No tmux session associated with this channel.');
                }
                return;
            }

            // Default tmux session fallback (DMs or dedicated channel)
            const defaultTmuxSession = process.env.DEFAULT_TMUX_SESSION;
            const dedicatedChannel = process.env.SLACK_CHANNEL_ID;
            const isAllowedChannel = message.channel_type === 'im' || message.channel === dedicatedChannel;

            if (defaultTmuxSession && text.length > 0 && isAllowedChannel) {
                if (!this._isUserAllowed(message.user)) {
                    await say(':no_entry: You are not authorized to send commands.');
                    return;
                }

                await say(`:rocket: Sending to tmux session \`${defaultTmuxSession}\`...\n\`${text}\``);
                await this._executeTmuxCommand(text, { tmuxSession: defaultTmuxSession });
                return;
            }
          } catch (err) {
            console.error('Message handler error:', err.message);
          }
        });

        // Handle app mentions
        this.app.event('app_mention', async ({ event, say }) => {
          try {
            console.log(`Received app_mention in channel ${event.channel} (${(event.text || '').length} chars)`);
            const text = event.text.replace(/<@[A-Z0-9]+>/gi, '').trim();
            if (!text) return;

            const defaultTmuxSession = process.env.DEFAULT_TMUX_SESSION;
            if (defaultTmuxSession) {
                if (!this._isUserAllowed(event.user)) {
                    await say(':no_entry: You are not authorized to send commands.');
                    return;
                }

                await say(`:rocket: Sending to tmux session \`${defaultTmuxSession}\`...\n\`${text}\``);
                await this._executeTmuxCommand(text, { tmuxSession: defaultTmuxSession });
            }
          } catch (err) {
            console.error('App mention handler error:', err.message);
          }
        });

        // ─── Interactive Button Handlers ────────────────────────────────────

        // Control: Stop button
        this.app.action('cn_stop', async ({ body, ack }) => {
            await ack();
            const channelId = body.channel?.id;
            if (!channelId) return;
            const channelManager = this._getChannelManager();
            const sessionInfo = channelManager.getSessionByChannelId(channelId);
            if (sessionInfo?.tmuxSession) {
                try {
                    await execFileAsync('tmux', ['send-keys', '-t', sessionInfo.tmuxSession, 'C-c'], { timeout: 5000 });
                    await this._updateButtonMessage(body, ':stop_sign: Interrupt sent.');
                } catch {
                    await this._updateButtonMessage(body, ':warning: Failed to send interrupt.');
                }
            }
        });

        // Control: Pause button (sets flag so webhook queues messages)
        this.app.action('cn_pause', async ({ body, ack }) => {
            await ack();
            const channelId = body.channel?.id;
            if (!channelId) return;
            const channelManager = this._getChannelManager();
            const sessionInfo = channelManager.getSessionByChannelId(channelId);
            if (sessionInfo) {
                const map = channelManager._readChannelMap();
                for (const [, entry] of Object.entries(map)) {
                    if (entry.channelId === channelId && entry.active) {
                        entry.paused = true;
                        break;
                    }
                }
                channelManager._writeChannelMap(map);
                await this._updateButtonMessage(body, ':double_vertical_bar: Session paused. Messages will be queued.');
            }
        });

        // Control: Resume button (clears pause, replays queued)
        this.app.action('cn_resume', async ({ body, ack }) => {
            await ack();
            const channelId = body.channel?.id;
            if (!channelId) return;
            const channelManager = this._getChannelManager();
            const sessionInfo = channelManager.getSessionByChannelId(channelId);
            if (sessionInfo) {
                const map = channelManager._readChannelMap();
                for (const [, entry] of Object.entries(map)) {
                    if (entry.channelId === channelId && entry.active) {
                        delete entry.paused;
                        break;
                    }
                }
                channelManager._writeChannelMap(map);
                await this._updateButtonMessage(body, ':arrow_forward: Session resumed.');
            }
        });

        // Control: Archive button
        this.app.action('cn_archive', async ({ body, ack }) => {
            await ack();
            const channelId = body.channel?.id;
            if (!channelId) return;
            const channelManager = this._getChannelManager();
            try {
                await channelManager.archiveChannel(channelId);
                // Channel is archived; no need to update message
            } catch {
                await this._updateButtonMessage(body, ':warning: Failed to archive channel.');
            }
        });

        // Approval: dynamic option buttons from AskUserQuestion
        this.app.action(/^cn_option_\d+$/, async ({ body, action, ack }) => {
            await ack();
            const channelId = body.channel?.id;
            if (!channelId) return;
            const channelManager = this._getChannelManager();
            const sessionInfo = channelManager.getSessionByChannelId(channelId);
            if (sessionInfo?.tmuxSession) {
                const optionText = action.value || '';
                if (optionText) {
                    await this._executeTmuxCommand(optionText, { tmuxSession: sessionInfo.tmuxSession });
                }
                await this._updateButtonMessage(body, `:white_check_mark: Selected: ${optionText}`);
            }
        });

        await this.app.start();
        console.log(':zap: Slack bot is running in Socket Mode');
    }

    /**
     * Replace button message with a text-only confirmation (disables buttons).
     */
    async _updateButtonMessage(body, text) {
        try {
            const channelId = body.channel?.id;
            const messageTs = body.message?.ts;
            if (channelId && messageTs) {
                await this.app.client.chat.update({
                    channel: channelId,
                    ts: messageTs,
                    text,
                    blocks: [],
                });
            }
        } catch { /* best effort */ }
    }

    /**
     * Send a command to a tmux session.
     * @returns {Promise<boolean>} true if the text and Enter were sent successfully
     */
    async _executeTmuxCommand(command, session) {
        const tmuxSession = session.tmuxSession || 'claude';
        const MAX_TMUX_MESSAGE_LENGTH = 4096;

        // Truncate to prevent terminal flooding
        let safeCommand = command;
        if (safeCommand.length > MAX_TMUX_MESSAGE_LENGTH) {
            safeCommand = safeCommand.substring(0, MAX_TMUX_MESSAGE_LENGTH);
        }

        try {
            const baseArgs = ['send-keys', '-t', tmuxSession];

            // Step 1: Send command text (literal mode)
            await execFileAsync('tmux', [...baseArgs, '-l', safeCommand], { timeout: 5000 });

            // Step 2: Send Enter key after delay (Claude Code needs time to process text)
            await new Promise(resolve => setTimeout(resolve, 300));

            await execFileAsync('tmux', [...baseArgs, 'Enter'], { timeout: 5000 });

            return true;
        } catch (error) {
            console.error('tmux command error:', error.message);
            return false;
        }
    }

    async stop() {
        if (this.app) {
            await this.app.stop();
            console.log('Slack bot stopped');
        }
    }
}

module.exports = SlackWebhook;
