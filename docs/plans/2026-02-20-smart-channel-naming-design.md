# Smart Slack Channel Naming

## Problem

Channels are currently named `#cn-{project}-{8-char-uuid}`, e.g. `#cn-blainehill-8a1b94b6`. The UUID suffix is meaningless — you can't tell what a session is about by looking at the channel name.

## Solution

Two-phase naming:

1. **Phase 1 (session-start):** Create channel with a timestamp-based name: `#cn-{project}-{mon}{day}-{hour}{min}` e.g. `#cn-myproject-feb20-2021`
2. **Phase 2 (first user prompt):** Auto-rename with a Haiku-generated slug: `#cn-myproject-fix-auth-bug`

## Design

### Phase 1: Timestamp naming

**File:** `remote/channel-manager.cjs` — `_generateChannelName()`

Replace the UUID-based suffix with a timestamp:
- Format: `{prefix}-{project}-{mon}{day}-{hour}{min}` (24h time)
- Month is 3-letter lowercase abbreviation (jan, feb, mar...)
- Example: `cn-myproject-feb20-2021` (Feb 20, 8:21 PM)
- On `name_taken` collision, append a random 4-char suffix (existing behavior)

### Phase 2: Haiku-powered rename

**File:** `remote/hook-notify.cjs` — in the `user-prompt` handler

When the first `UserPromptSubmit` hook fires for a session:

1. Check `channel-map.json` entry — if `renamed: true`, skip
2. Spawn `claude -p` with Haiku model to generate a 2-4 word slug from the prompt
3. Call Slack `conversations.rename` to rename the channel
4. Set `renamed: true` in channel-map entry

**Slug generation:**
```
claude -p "Generate a 2-4 word hyphenated slug summarizing this task. Output ONLY the slug, nothing else. Task: {first 500 chars of prompt}" --model haiku --output-format text
```

Set `CN_SLUG_GENERATION=1` in the spawned process env to prevent recursive hook processing.

**New channel name:** `{prefix}-{project}-{slug}` truncated to 80 chars.

### Channel Manager changes

**New method:** `renameChannel(sessionId, newName)`
- Calls `conversations.rename` on the Slack API
- Updates `channelName` in the channel-map entry
- Sets `renamed: true`

**Modified:** `_generateChannelName(project, sessionId)` → `_generateChannelName(project)`
- Remove `sessionId` parameter (no longer needed)
- Use timestamp instead of session ID

### Hook-notify changes

**Modified:** Early exit when `CN_SLUG_GENERATION=1` is set — skip all hook processing to prevent recursive loops.

**Modified:** `user-prompt` handler — after posting the user's message, check if this is the first prompt and trigger rename.

### Fallback behavior

If any of these fail, the channel keeps its timestamp name (still better than UUID):
- `claude` CLI not found
- Haiku call fails or times out
- Slack rename API fails (e.g. name collision)
- `CN_SLUG_GENERATION` recursion guard

### Data model change

`channel-map.json` entry gets a new field:
```json
{
  "channelId": "C123",
  "channelName": "cn-myproject-fix-auth-bug",
  "renamed": true,
  ...
}
```

## Not in scope

- Channel renaming via Slack command (`!rename`) — could be added later
- Using API keys instead of CLI — adds config complexity
- Renaming on subsequent prompts — first prompt is sufficient context
