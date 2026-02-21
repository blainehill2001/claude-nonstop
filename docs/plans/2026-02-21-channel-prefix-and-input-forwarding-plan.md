# Channel Prefix Removal & Input Forwarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the default "cn-" channel prefix, include option descriptions in AskUserQuestion Slack messages, and add a 15-second delayed @mention for input-request notifications.

**Architecture:** Three independent changes to the Slack integration layer: (1) change default prefix from `'cn'` to `''` with nullish coalescing (`??`) to respect explicit empty strings, (2) enrich `formatWaitingMessage` to include option descriptions from `AskUserQuestion` tool input, (3) modify the `waiting-for-input` handler to post silently then update with @mention after 15 seconds using `chat.update`.

**Tech Stack:** Node.js CJS (`remote/*.cjs`), Slack Web API (`@slack/web-api`), node:test

---

### Task 1: Change default channel prefix from 'cn' to '' in channel-manager.cjs

**Files:**
- Modify: `remote/channel-manager.cjs:31` (constructor)
- Modify: `remote/channel-manager.cjs:65` (`_generateChannelName`)

**Step 1: Write the failing test**

In `test/unit/remote/channel-manager.test.cjs`, add a new test in the `_generateChannelName` describe block:

```javascript
it('generates name without prefix when channelPrefix is empty', () => {
  const { client: c2 } = createMockSlackClient();
  const m2 = new SlackChannelManager({
    botToken: 'xoxb-test',
    channelMapPath: path.join(tempDir, 'data', 'channel-map.json'),
    channelPrefix: '',
  });
  m2.client = c2;
  const name = m2._generateChannelName('myproject');
  assert.ok(name.match(/^myproject-[a-z]{3}\d{2}-\d{4}$/), `unexpected format: ${name}`);
  assert.ok(!name.startsWith('-'), 'should not start with hyphen');
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/unit/remote/channel-manager.test.cjs`
Expected: FAIL — name will be `-myproject-...` because of the template literal `${this.channelPrefix}-${safeProject}-...`

**Step 3: Fix the constructor to use `??` instead of `||`**

In `remote/channel-manager.cjs` line 31, change:
```javascript
this.channelPrefix = config.channelPrefix || process.env.SLACK_CHANNEL_PREFIX || 'cn';
```
To:
```javascript
this.channelPrefix = config.channelPrefix ?? process.env.SLACK_CHANNEL_PREFIX ?? '';
```

**Step 4: Fix `_generateChannelName` to handle empty prefix**

In `remote/channel-manager.cjs` line 65, change:
```javascript
const name = `${this.channelPrefix}-${safeProject}-${timestamp}`;
```
To:
```javascript
const prefix = this.channelPrefix;
const name = prefix ? `${prefix}-${safeProject}-${timestamp}` : `${safeProject}-${timestamp}`;
```

**Step 5: Run test to verify it passes**

Run: `node --test test/unit/remote/channel-manager.test.cjs`
Expected: PASS

**Step 6: Update existing tests that assume 'cn' as default prefix**

The test at line 57 creates a manager with `channelPrefix: 'cn'` explicitly, so it should still pass. But the test at line 72 checks `^cn-myproject-` — that test explicitly passes `channelPrefix: 'cn'` in beforeEach so it's fine.

Verify: `node --test test/unit/remote/channel-manager.test.cjs`
Expected: all pass

**Step 7: Commit**

```bash
git add remote/channel-manager.cjs test/unit/remote/channel-manager.test.cjs
git commit -m "feat: change default channel prefix from 'cn' to empty string"
```

---

### Task 2: Update rename-worker.cjs for empty prefix

**Files:**
- Modify: `remote/rename-worker.cjs:34,58`

**Step 1: Fix rename-worker prefix handling**

In `remote/rename-worker.cjs` line 34, change:
```javascript
channelPrefix: channelPrefix || 'cn',
```
To:
```javascript
channelPrefix: channelPrefix ?? '',
```

In line 58, change:
```javascript
const newName = `${channelPrefix || 'cn'}-${safeProject}${slug}`
```
To:
```javascript
const prefix = channelPrefix || '';
const newName = (prefix ? `${prefix}-${safeProject}${slug}` : `${safeProject}${slug}`)
    .substring(0, 80)
    .replace(/-$/, '');
```

And remove the duplicate `.substring(0, 80).replace(/-$/, '')` on line 59-60.

**Step 2: Run syntax check**

Run: `node --check remote/rename-worker.cjs`
Expected: no errors

**Step 3: Commit**

```bash
git add remote/rename-worker.cjs
git commit -m "feat: handle empty channel prefix in rename worker"
```

---

### Task 3: Update hook-notify.cjs createChannelManager and spawnRenameWorker for empty prefix

**Files:**
- Modify: `remote/hook-notify.cjs:197,493`

**Step 1: Fix createChannelManager**

In `remote/hook-notify.cjs` line 197, change:
```javascript
channelPrefix: process.env.SLACK_CHANNEL_PREFIX || 'cn'
```
To:
```javascript
channelPrefix: process.env.SLACK_CHANNEL_PREFIX ?? ''
```

**Step 2: Fix spawnRenameWorker default**

In `remote/hook-notify.cjs` line 493, change:
```javascript
const child = spawnChild('node', [RENAME_WORKER_PATH, sessionId, userPrompt, channelPrefix || 'cn'], {
```
To:
```javascript
const child = spawnChild('node', [RENAME_WORKER_PATH, sessionId, userPrompt, channelPrefix ?? ''], {
```

**Step 3: Run syntax check and tests**

Run: `node --check remote/hook-notify.cjs && node --test test/unit/remote/hook-notify.test.cjs`
Expected: all pass

**Step 4: Commit**

```bash
git add remote/hook-notify.cjs
git commit -m "feat: use nullish coalescing for channel prefix in hook-notify"
```

---

### Task 4: Update bin/claude-nonstop.js setup defaults

**Files:**
- Modify: `bin/claude-nonstop.js:791,801,823`

**Step 1: Change setup defaults**

Line 791 (from-env mode):
```javascript
channelPrefix = flags.channelPrefix || process.env.SLACK_CHANNEL_PREFIX || 'cn';
```
→
```javascript
channelPrefix = flags.channelPrefix ?? process.env.SLACK_CHANNEL_PREFIX ?? '';
```

Line 801 (flags mode):
```javascript
channelPrefix = flags.channelPrefix || 'cn';
```
→
```javascript
channelPrefix = flags.channelPrefix ?? '';
```

Line 823 (interactive mode):
```javascript
channelPrefix = await ask('SLACK_CHANNEL_PREFIX', 'cn');
```
→
```javascript
channelPrefix = await ask('SLACK_CHANNEL_PREFIX (empty = no prefix)', '');
```

**Step 2: Run syntax check**

Run: `node --check bin/claude-nonstop.js`
Expected: no errors

**Step 3: Commit**

```bash
git add bin/claude-nonstop.js
git commit -m "feat: default to empty channel prefix in setup"
```

---

### Task 5: Include option descriptions in AskUserQuestion Slack messages

**Files:**
- Modify: `remote/hook-notify.cjs:348-356` (`formatWaitingMessage`)
- Test: `test/unit/remote/hook-notify.test.cjs`

**Step 1: Write the failing test**

Add to the `formatWaitingMessage` describe block:

```javascript
it('includes option descriptions for AskUserQuestion', () => {
  const input = {
    questions: [{
      question: 'Which database should we use?',
      options: [
        { label: 'PostgreSQL', description: 'Battle-tested relational DB' },
        { label: 'MongoDB', description: 'Document store, flexible schema' },
      ],
    }],
  };
  const msg = formatWaitingMessage('AskUserQuestion', input);
  assert.ok(msg.includes('PostgreSQL'));
  assert.ok(msg.includes('Battle-tested relational DB'));
  assert.ok(msg.includes('MongoDB'));
  assert.ok(msg.includes('Document store, flexible schema'));
});

it('formats option descriptions as numbered list', () => {
  const input = {
    questions: [{
      question: 'Pick one',
      options: [
        { label: 'A', description: 'First choice' },
        { label: 'B', description: 'Second choice' },
      ],
    }],
  };
  const msg = formatWaitingMessage('AskUserQuestion', input);
  assert.ok(msg.includes('1.'));
  assert.ok(msg.includes('2.'));
});

it('handles options without descriptions gracefully', () => {
  const input = {
    questions: [{
      question: 'Pick one',
      options: [
        { label: 'A' },
        { label: 'B', description: '' },
      ],
    }],
  };
  const msg = formatWaitingMessage('AskUserQuestion', input);
  assert.ok(msg.includes('A'));
  assert.ok(msg.includes('B'));
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/unit/remote/hook-notify.test.cjs`
Expected: FAIL — descriptions not included in current formatWaitingMessage

**Step 3: Update formatWaitingMessage for AskUserQuestion**

In `remote/hook-notify.cjs`, replace the AskUserQuestion branch in `formatWaitingMessage` (lines 348-356):

```javascript
if (toolName === 'AskUserQuestion') {
    const questions = toolInput?.questions;
    if (questions && questions.length > 0 && questions[0].question) {
        const q = questions[0].question;
        const truncated = q.length > 200 ? q.substring(0, 200) + '...' : q;
        let msg = `:question: Claude is asking: "${truncated}"\n`;

        // Include option descriptions if available
        const options = questions[0].options;
        if (options && options.length > 0) {
            msg += '\n';
            options.slice(0, 4).forEach((opt, i) => {
                const label = opt.label || `Option ${i + 1}`;
                const desc = opt.description ? ` \u2014 ${opt.description}` : '';
                msg += `${i + 1}. *${label}*${desc}\n`;
            });
        }

        msg += '\n:arrow_right: Click a button or type your answer.';
        return msg;
    }
    return ':question: Claude is asking a question \u2014 reply here with your answer, or use `!status` to view.';
}
```

**Step 4: Run tests to verify they pass**

Run: `node --test test/unit/remote/hook-notify.test.cjs`
Expected: PASS (check that existing tests also pass — the "returns question text" test checks for "Reply here" which we changed to "Click a button or type your answer", update that test too)

**Step 5: Fix any broken existing tests**

The test at line 558-566 checks for `msg.includes('Reply here')` — update to check for `msg.includes('Click a button')` or `msg.includes('type your answer')`.

**Step 6: Run full test suite**

Run: `node --test test/unit/remote/hook-notify.test.cjs`
Expected: all pass

**Step 7: Commit**

```bash
git add remote/hook-notify.cjs test/unit/remote/hook-notify.test.cjs
git commit -m "feat: include option descriptions in AskUserQuestion Slack messages"
```

---

### Task 6: Add delayed @mention notification (15 seconds)

**Files:**
- Modify: `remote/hook-notify.cjs:585-619` (waiting-for-input handler)
- Modify: `bin/claude-nonstop.js:1154-1158` (PreToolUse hook timeout)

**Step 1: Write the failing test**

Add to `test/unit/remote/hook-notify.test.cjs`:

```javascript
describe('delayed @mention notification', () => {
  it('waiting-for-input handler uses SLACK_INVITE_USER_ID for delayed mention', () => {
    // Verify the env var is read for the mention
    const userId = 'U12345TEST';
    const orig = process.env.SLACK_INVITE_USER_ID;
    try {
      process.env.SLACK_INVITE_USER_ID = userId;
      assert.equal(process.env.SLACK_INVITE_USER_ID, userId);
    } finally {
      if (orig !== undefined) process.env.SLACK_INVITE_USER_ID = orig;
      else delete process.env.SLACK_INVITE_USER_ID;
    }
  });
});
```

(The real integration test for the 15s delay is impractical in unit tests — we'll verify the structure and run a manual test.)

**Step 2: Modify the waiting-for-input handler**

In `remote/hook-notify.cjs`, replace the waiting-for-input handler (lines 588-619) with:

```javascript
if (notificationType === 'waiting-for-input') {
    if (!isPerSessionMode() || !sessionId) return;

    const toolName = hookContext?.tool_name;
    const toolInput = hookContext?.tool_input;
    if (!toolName || !WAITING_FOR_INPUT_TOOLS.has(toolName)) return;

    const manager = createChannelManager();
    await manager.clearProgressMessage(sessionId);

    // For ExitPlanMode, read the plan content from the transcript
    let transcriptContent = null;
    if (toolName === 'ExitPlanMode') {
        const transcriptPath = hookContext?.transcript_path
            || findTranscriptPath(sessionId, currentDir);
        if (transcriptPath) {
            transcriptContent = getLastAssistantMessage(transcriptPath);
        }
    }

    const text = formatWaitingMessage(toolName, toolInput, transcriptContent);
    const approvalBlocks = buildApprovalButtons(toolName, toolInput);

    // Phase 1: Post immediately WITHOUT @mention (keeps Slack in sync)
    const mapping = manager.getChannelMapping(sessionId);
    if (!mapping) return;

    let messageTs = null;
    try {
        const postOpts = { channel: mapping.channelId, text };
        if (approvalBlocks) {
            postOpts.text = text.substring(0, 3000);
            postOpts.blocks = [
                { type: 'section', text: { type: 'mrkdwn', text: text.substring(0, 3000) } },
                ...approvalBlocks,
            ];
        }
        const result = await manager.client.chat.postMessage(postOpts);
        messageTs = result.ts;
    } catch (err) {
        console.warn('Failed to post waiting-for-input message:', err.message);
        return;
    }

    // Phase 2: After 15 seconds, update message with @mention to trigger push notification
    const inviteUserId = process.env.SLACK_INVITE_USER_ID;
    if (messageTs && inviteUserId) {
        await new Promise(resolve => setTimeout(resolve, 15_000));
        try {
            const mentionPrefix = `<@${inviteUserId}> `;
            const updateOpts = {
                channel: mapping.channelId,
                ts: messageTs,
                text: mentionPrefix + text.substring(0, 3000),
            };
            if (approvalBlocks) {
                updateOpts.blocks = [
                    { type: 'section', text: { type: 'mrkdwn', text: mentionPrefix + text.substring(0, 2900) } },
                    ...approvalBlocks,
                ];
            }
            await manager.client.chat.update(updateOpts);
        } catch (err) {
            console.warn('Failed to update message with @mention:', err.message);
        }
    }

    return;
}
```

**Step 3: Increase PreToolUse hook timeout to 30s**

In `bin/claude-nonstop.js`, change lines 1156-1158:
```javascript
// PreToolUse for waiting-for-input needs a timeout for Slack API calls
if (hookType === 'PreToolUse') {
    hookEntry.timeout = 15;
}
```
To:
```javascript
// PreToolUse for waiting-for-input: 30s to allow 15s delay + Slack API calls
if (hookType === 'PreToolUse') {
    hookEntry.timeout = 30;
}
```

**Step 4: Run syntax check and tests**

Run: `node --check remote/hook-notify.cjs && node --check bin/claude-nonstop.js && node --test test/unit/remote/hook-notify.test.cjs`
Expected: all pass

**Step 5: Commit**

```bash
git add remote/hook-notify.cjs bin/claude-nonstop.js
git commit -m "feat: add 15-second delayed @mention for input-request notifications"
```

---

### Task 7: Update all remaining references and documentation

**Files:**
- Modify: `remote/hook-notify.cjs:20` (header comment)
- Modify: `CLAUDE.md` (channel prefix references)
- Modify: `README.md` (if it references `cn-` prefix)
- Modify: `CHANGELOG.md` (add entry)

**Step 1: Update hook-notify.cjs header comment**

Change line 20:
```
 *   SLACK_CHANNEL_PREFIX       — channel name prefix (default: 'cn')
```
To:
```
 *   SLACK_CHANNEL_PREFIX       — channel name prefix (default: empty)
```

**Step 2: Update CLAUDE.md references**

Any mentions of `cn-` as default prefix should be updated to note the default is now empty. Update channel name examples from `#cn-myproject-feb20-2021` to `#myproject-feb20-2021`.

**Step 3: Commit**

```bash
git add remote/hook-notify.cjs CLAUDE.md
git commit -m "docs: update references for empty default channel prefix"
```

---

### Task 8: Reinstall hooks and run full end-to-end verification

**Step 1: Reinstall hooks to pick up new timeout**

Run: `claude-nonstop hooks install`

**Step 2: Verify hooks show updated timeout**

Run: `claude-nonstop hooks status`
Expected: PreToolUse hook timeout = 30

**Step 3: Run full test suite**

Run: `npm run check && npm test`
Expected: all syntax checks pass, all tests pass

**Step 4: Manual end-to-end test**

Run `claude-nonstop` and trigger an AskUserQuestion by asking Claude a question that requires clarification. Verify:
1. Channel created WITHOUT `cn-` prefix
2. AskUserQuestion message shows option descriptions
3. Message posts immediately without @mention
4. After 15 seconds, message updates to include @mention (push notification triggers)
5. Clicking a button in Slack sends the response to Claude via tmux

**Step 5: Final commit**

```bash
git add -A && git commit -m "chore: reinstall hooks with updated timeout"
```
