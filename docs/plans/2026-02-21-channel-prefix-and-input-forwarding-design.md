# Channel Prefix Removal & Input Forwarding Improvements

**Date:** 2026-02-21
**Status:** Draft

## Problem Statement

Two issues with claude-nonstop's Slack integration:

1. **Unnecessary "cn-" prefix**: Channel names like `#cn-myproject-feb20-1430` have a redundant prefix. The user already knows these are Slack channels.
2. **Input request context**: When Claude Code asks the user for input (AskUserQuestion), the option descriptions are not included in the Slack message — only the bare labels are shown. Additionally, push notifications should be delayed 15 seconds to give the user time to respond locally before being pinged on Slack.

## Design

### Change 1: Remove Default Channel Prefix

**Default prefix changes from `'cn'` to `''` (empty string).**

Channel name format:
- Before: `cn-myproject-feb20-1430` / renamed: `cn-myproject-fix-auth-bug`
- After: `myproject-feb20-1430` / renamed: `myproject-fix-auth-bug`

The `--channel-prefix` flag and `SLACK_CHANNEL_PREFIX` env var remain as escape hatches for users who want a prefix.

**Files affected:**
- `remote/channel-manager.cjs` — `_generateChannelName()`: handle empty prefix (no leading hyphen when prefix is empty)
- `remote/rename-worker.cjs` — `generateSlug()`: handle empty prefix in rename format
- `bin/claude-nonstop.js` — update default in setup flag parsing (remove `|| 'cn'` fallback, use `|| ''`)
- `test/unit/remote/channel-manager.test.cjs` — update regex patterns and expected values

**Edge case**: If prefix is empty and project name starts with a hyphen or number, Slack may reject. The existing sanitization in `_generateChannelName()` already strips leading hyphens, so this is handled.

### Change 2: Include Option Descriptions in Slack Messages

When `AskUserQuestion` options are displayed in Slack, include the description text alongside the label.

**Current Slack message:**
```
❓ Claude is asking: "Which database?"

→ Reply here with your answer.
[PostgreSQL] [MongoDB]
```

**New Slack message:**
```
❓ Claude is asking: "Which database?"

1. *PostgreSQL* — Battle-tested relational DB, good for structured data
2. *MongoDB* — Document store, flexible schema

→ Click a button or type your answer:
[PostgreSQL] [MongoDB]
```

**Files affected:**
- `remote/hook-notify.cjs` — `formatWaitingMessage()`: when tool is AskUserQuestion, iterate over options and include `label` + `description` in the message body
- `test/unit/remote/hook-notify.test.cjs` — update formatWaitingMessage tests

### Change 3: Silent Post + Delayed @mention (15 seconds)

For `waiting-for-input` messages, use a two-phase notification approach:

1. **Phase 1 (immediate)**: Post the input-request message to Slack channel immediately, with NO @mention. This keeps the channel perfectly in sync with Claude's state.
2. **Phase 2 (after 15 seconds)**: Update the message to prepend `<@SLACK_INVITE_USER_ID>` @mention, triggering a push notification. This gives the user 15 seconds to respond locally before being pinged.

**Implementation:**
- In `hook-notify.cjs` `waiting-for-input` handler:
  1. Post message via `postToSessionChannel()` — capture the message timestamp (`ts`)
  2. `await new Promise(resolve => setTimeout(resolve, 15000))`
  3. Call `chat.update` to prepend `<@USER_ID>` to the message text
- Increase PreToolUse hook timeout from 15s to 30s in hook installation code

**Files affected:**
- `remote/hook-notify.cjs` — waiting-for-input handler: add 15s delay + message update
- `remote/channel-manager.cjs` — add `updateSessionMessage(sessionId, ts, newText, newBlocks)` method
- `bin/claude-nonstop.js` — increase PreToolUse hook timeout to 30s
- `test/unit/remote/hook-notify.test.cjs` — test delayed @mention flow

### Change 4: Tests

- Update channel-manager tests for empty default prefix
- Update hook-notify tests for option description formatting
- Add integration test for the 15-second delayed notification flow (mock timers)
- Verify existing tests pass with all changes

## Non-Goals

- No `idle_prompt` Notification hook (not needed)
- No terminal idle detection
- No changes to how text messages in Slack are relayed to tmux
- Existing channels are not retroactively renamed

## Migration

- Existing channels with `cn-` prefix continue to work (channel-map.json stores channel IDs, not names)
- New channels created after this change will have no prefix
- Users who want the old prefix can use `--channel-prefix cn` in setup
