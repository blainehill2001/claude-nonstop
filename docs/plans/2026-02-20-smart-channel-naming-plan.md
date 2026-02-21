# Smart Slack Channel Naming — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace meaningless UUID-based Slack channel names with timestamp-based names that auto-rename to Haiku-generated descriptive slugs after the first user prompt.

**Architecture:** Two-phase naming. Phase 1: `_generateChannelName()` in `channel-manager.cjs` uses timestamps (`cn-myproject-feb20-2021`). Phase 2: `hook-notify.cjs` user-prompt handler spawns `claude -p` with Haiku to generate a slug, then calls a new `renameChannel()` method on the channel manager. A `CN_SLUG_GENERATION=1` env var prevents recursive hook processing.

**Tech Stack:** Node.js CJS (remote/ modules), `@slack/web-api` (conversations.rename), `child_process.execFile` (spawning claude CLI safely — no shell injection), `node:test` (testing).

---

### Task 1: Update `_generateChannelName()` to use timestamps

**Files:**
- Modify: `remote/channel-manager.cjs:51-60` (`_generateChannelName`)
- Test: `test/unit/remote/channel-manager.test.cjs`

**Step 1: Write the failing tests**

Replace the existing `_generateChannelName` tests in `test/unit/remote/channel-manager.test.cjs`. Find the `describe('SlackChannelManager._generateChannelName'` block (lines 50-93) and replace all its test cases:

```javascript
describe('SlackChannelManager._generateChannelName', () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = createTempDir();
    const { client } = createMockSlackClient();
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(tempDir, 'data', 'channel-map.json'),
      channelPrefix: 'cn',
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('generates name with timestamp suffix instead of UUID', () => {
    const name = manager._generateChannelName('myproject');
    // Should NOT contain any 8-char hex UUID
    assert.ok(!name.match(/[0-9a-f]{8}$/), 'should not end with UUID');
    // Should contain month abbreviation and time digits
    assert.ok(name.match(/^cn-myproject-[a-z]{3}\d{2}-\d{4}$/), `unexpected format: ${name}`);
  });

  it('uses 3-letter lowercase month abbreviation', () => {
    const name = manager._generateChannelName('proj');
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const monthPart = name.match(/-([a-z]{3})\d{2}-/);
    assert.ok(monthPart, 'should contain month abbreviation');
    assert.ok(months.includes(monthPart[1]), `${monthPart[1]} is not a valid month`);
  });

  it('sanitizes special characters in project name', () => {
    const name = manager._generateChannelName('my project!@#');
    assert.ok(name.startsWith('cn-my-project-'));
  });

  it('truncates to 80 chars', () => {
    const longProject = 'a'.repeat(100);
    const name = manager._generateChannelName(longProject);
    assert.ok(name.length <= 80);
  });

  it('removes leading/trailing hyphens from project', () => {
    const name = manager._generateChannelName('-proj-');
    assert.ok(name.startsWith('cn-proj-'));
  });

  it('collapses multiple hyphens', () => {
    const name = manager._generateChannelName('a--b');
    assert.ok(name.startsWith('cn-a-b-'));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm test 2>&1 | head -80`
Expected: FAIL — current `_generateChannelName` requires 2 args and produces UUID format

**Step 3: Implement the timestamp-based `_generateChannelName`**

In `remote/channel-manager.cjs`, replace the `_generateChannelName` method (lines 51-60):

```javascript
_generateChannelName(project) {
    const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const now = new Date();
    const mon = MONTHS[now.getMonth()];
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const timestamp = `${mon}${day}-${hour}${min}`;

    const safeProject = project
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    const name = `${this.channelPrefix}-${safeProject}-${timestamp}`;
    return name.substring(0, 80);
}
```

**Step 4: Update the call site in `getOrCreateChannel`**

In `remote/channel-manager.cjs` line 190, change:
```javascript
const channelName = this._generateChannelName(project, sessionId);
```
to:
```javascript
const channelName = this._generateChannelName(project);
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm test`
Expected: ALL PASS

**Step 6: Run syntax check**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm run check`
Expected: No errors

**Step 7: Commit**

```bash
cd /Users/blainehill/Developer/claude-nonstop
git add remote/channel-manager.cjs test/unit/remote/channel-manager.test.cjs
git commit -m "feat: use timestamp-based Slack channel names instead of UUIDs

Replace _generateChannelName to produce cn-project-feb20-2021 format
instead of cn-project-8a1b94b6. More human-readable at a glance."
```

---

### Task 2: Add `renameChannel()` method to channel manager

**Files:**
- Modify: `remote/channel-manager.cjs` (add method after `getOrCreateChannel`)
- Modify: `test/helpers/mock-slack.cjs` (add `conversations.rename` mock)
- Modify: `test/unit/remote/channel-manager.test.cjs` (add tests)

**Step 1: Add `conversations.rename` to mock Slack client**

In `test/helpers/mock-slack.cjs`, inside the `conversations` object (after the `archive` method), add:

```javascript
rename: async (opts) => {
    record('conversations.rename', opts);
    return { ok: true, channel: { id: opts.channel, name: opts.name } };
},
```

**Step 2: Write failing tests for `renameChannel`**

Add this new describe block to `test/unit/remote/channel-manager.test.cjs` (after the `reuseChannelForTmuxSession` block, before the end of file):

```javascript
describe('SlackChannelManager.renameChannel', () => {
  let tempDir;
  let manager;
  let mockCalls;

  beforeEach(() => {
    tempDir = createTempDir();
    const mapDir = path.join(tempDir, 'data');
    fs.mkdirSync(mapDir, { recursive: true });
    const { client, calls } = createMockSlackClient();
    mockCalls = calls;
    manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath: path.join(mapDir, 'channel-map.json'),
      channelPrefix: 'cn',
    });
    manager.client = client;
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('renames channel and sets renamed flag', async () => {
    const data = {
      'sess-1': { channelId: 'C001', channelName: 'cn-proj-feb20-2021', active: true, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = await manager.renameChannel('sess-1', 'cn-proj-fix-auth-bug');
    assert.equal(result, true);

    const renameCalls = mockCalls.filter(c => c.method === 'conversations.rename');
    assert.equal(renameCalls.length, 1);
    assert.equal(renameCalls[0].args.channel, 'C001');
    assert.equal(renameCalls[0].args.name, 'cn-proj-fix-auth-bug');

    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.equal(map['sess-1'].channelName, 'cn-proj-fix-auth-bug');
    assert.equal(map['sess-1'].renamed, true);
  });

  it('returns false for unknown session', async () => {
    fs.writeFileSync(manager.channelMapPath, JSON.stringify({}));
    const result = await manager.renameChannel('unknown', 'new-name');
    assert.equal(result, false);
  });

  it('returns false for inactive session', async () => {
    const data = {
      'sess-1': { channelId: 'C001', channelName: 'cn-proj-old', active: false, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = await manager.renameChannel('sess-1', 'new-name');
    assert.equal(result, false);
  });

  it('returns false on Slack API error', async () => {
    const data = {
      'sess-1': { channelId: 'C001', channelName: 'cn-proj-old', active: true, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    manager.client.conversations.rename = async () => {
      throw new Error('name_taken');
    };

    const result = await manager.renameChannel('sess-1', 'taken-name');
    assert.equal(result, false);

    // channelName should NOT be updated on failure
    const map = JSON.parse(fs.readFileSync(manager.channelMapPath, 'utf8'));
    assert.equal(map['sess-1'].channelName, 'cn-proj-old');
    assert.equal(map['sess-1'].renamed, undefined);
  });

  it('skips if already renamed', async () => {
    const data = {
      'sess-1': { channelId: 'C001', channelName: 'cn-proj-fix-bug', active: true, renamed: true, createdAt: new Date().toISOString() },
    };
    fs.writeFileSync(manager.channelMapPath, JSON.stringify(data));

    const result = await manager.renameChannel('sess-1', 'different-name');
    assert.equal(result, false);

    // No API call should have been made
    const renameCalls = mockCalls.filter(c => c.method === 'conversations.rename');
    assert.equal(renameCalls.length, 0);
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm test 2>&1 | tail -20`
Expected: FAIL — `renameChannel` is not defined

**Step 4: Implement `renameChannel`**

In `remote/channel-manager.cjs`, add this method after `getOrCreateChannel` (after line 294, before `postToSessionChannel`):

```javascript
/**
 * Rename a session's Slack channel.
 * Sets `renamed: true` so it only happens once.
 * @returns {boolean} true if renamed successfully
 */
async renameChannel(sessionId, newName) {
    const map = this._readChannelMap();
    const entry = map[sessionId];
    if (!entry || !entry.active) return false;
    if (entry.renamed) return false;

    try {
        await this.client.conversations.rename({
            channel: entry.channelId,
            name: newName,
        });
    } catch (error) {
        console.warn('Failed to rename channel:', error.message);
        return false;
    }

    // Re-read to avoid clobbering concurrent writes
    const freshMap = this._readChannelMap();
    const freshEntry = freshMap[sessionId];
    if (freshEntry) {
        freshEntry.channelName = newName;
        freshEntry.renamed = true;
        this._writeChannelMap(freshMap);
    }

    console.log(`Renamed channel to #${newName} for session ${sessionId}`);
    return true;
}
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm test`
Expected: ALL PASS

**Step 6: Commit**

```bash
cd /Users/blainehill/Developer/claude-nonstop
git add remote/channel-manager.cjs test/unit/remote/channel-manager.test.cjs test/helpers/mock-slack.cjs
git commit -m "feat: add renameChannel() method to SlackChannelManager

Calls conversations.rename on Slack API, updates channel-map entry,
and sets renamed=true to prevent duplicate renames."
```

---

### Task 3: Add slug generation utility and recursion guard to hook-notify

**Files:**
- Modify: `remote/hook-notify.cjs` (add `generateSlugName` function + recursion guard)
- Modify: `test/unit/remote/hook-notify.test.cjs` (add tests)

**Step 1: Write failing tests for the recursion guard and slug generation**

Add these test blocks to the end of `test/unit/remote/hook-notify.test.cjs`:

```javascript
describe('slug generation', () => {
  it('is exported from hook-notify', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    assert.equal(typeof mod.generateSlugName, 'function');
  });

  it('converts slug output to Slack-safe channel name segment', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    assert.equal(mod.generateSlugName('Fix Auth Bug'), 'fix-auth-bug');
  });

  it('strips non-alphanumeric characters', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    assert.equal(mod.generateSlugName('fix: the "auth" bug!'), 'fix-the-auth-bug');
  });

  it('collapses multiple hyphens', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    assert.equal(mod.generateSlugName('fix---auth---bug'), 'fix-auth-bug');
  });

  it('strips leading/trailing hyphens', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    assert.equal(mod.generateSlugName('-fix-bug-'), 'fix-bug');
  });

  it('truncates to maxLength', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    const long = 'a-very-long-slug-that-exceeds-the-max-length-allowed';
    const result = mod.generateSlugName(long, 20);
    assert.ok(result.length <= 20);
    assert.ok(!result.endsWith('-'));
  });

  it('returns null for empty input', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    assert.equal(mod.generateSlugName(''), null);
    assert.equal(mod.generateSlugName('   '), null);
    assert.equal(mod.generateSlugName(null), null);
  });
});

describe('CN_SLUG_GENERATION recursion guard', () => {
  it('isSlugGeneration returns true when env is set', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    const orig = process.env.CN_SLUG_GENERATION;
    try {
      process.env.CN_SLUG_GENERATION = '1';
      assert.equal(mod.isSlugGeneration(), true);
    } finally {
      if (orig !== undefined) process.env.CN_SLUG_GENERATION = orig;
      else delete process.env.CN_SLUG_GENERATION;
    }
  });

  it('isSlugGeneration returns false when env is not set', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    const orig = process.env.CN_SLUG_GENERATION;
    try {
      delete process.env.CN_SLUG_GENERATION;
      assert.equal(mod.isSlugGeneration(), false);
    } finally {
      if (orig !== undefined) process.env.CN_SLUG_GENERATION = orig;
      else delete process.env.CN_SLUG_GENERATION;
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm test 2>&1 | tail -30`
Expected: FAIL — `generateSlugName` and `isSlugGeneration` not exported

**Step 3: Implement the slug utility and recursion guard**

In `remote/hook-notify.cjs`, add these functions near the top of the file (after existing utility functions, before `main()`).

Add the recursion guard function:

```javascript
/**
 * Check if we're inside a slug generation subprocess.
 * When true, all hook processing should be skipped.
 */
function isSlugGeneration() {
    return process.env.CN_SLUG_GENERATION === '1';
}
```

Add the slug name sanitizer:

```javascript
/**
 * Convert raw text (e.g. from Haiku output) into a Slack-safe channel name segment.
 * Returns null if input is empty/whitespace.
 */
function generateSlugName(text, maxLength = 50) {
    if (!text || !text.trim()) return null;
    let slug = text
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (slug.length > maxLength) {
        slug = slug.substring(0, maxLength).replace(/-$/, '');
    }
    return slug || null;
}
```

Add the early exit at the very top of `main()`:

```javascript
// Recursion guard: skip all processing when spawned for slug generation
if (isSlugGeneration()) return;
```

Export both functions (add to the existing module.exports block at the bottom):

```javascript
module.exports.generateSlugName = generateSlugName;
module.exports.isSlugGeneration = isSlugGeneration;
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm test`
Expected: ALL PASS

**Step 5: Commit**

```bash
cd /Users/blainehill/Developer/claude-nonstop
git add remote/hook-notify.cjs test/unit/remote/hook-notify.test.cjs
git commit -m "feat: add slug generation utility and recursion guard

generateSlugName sanitizes Haiku output into Slack-safe channel segments.
isSlugGeneration checks CN_SLUG_GENERATION env to prevent recursive hooks."
```

---

### Task 4: Implement the auto-rename in the user-prompt handler

**Files:**
- Modify: `remote/hook-notify.cjs` (user-prompt handler, add `spawnSlug` function)
- Modify: `test/unit/remote/hook-notify.test.cjs` (add tests)

**Step 1: Write failing tests**

Add to `test/unit/remote/hook-notify.test.cjs`:

```javascript
describe('spawnSlug', () => {
  it('is exported from hook-notify', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    assert.equal(typeof mod.spawnSlug, 'function');
  });
});
```

Also add to the existing `describe('user-prompt handler'` block, tests for the rename flow:

```javascript
it('triggers channel rename on first user prompt when not yet renamed', async () => {
    const { client, calls } = createMockSlackClient();
    client.conversations.rename = async (opts) => {
      calls.push({ method: 'conversations.rename', args: opts });
      return { ok: true, channel: { id: opts.channel, name: opts.name } };
    };
    const channelMapPath = path.join(tempDir, 'data', 'channel-map.json');
    const mapDir = path.dirname(channelMapPath);
    fs.mkdirSync(mapDir, { recursive: true });

    const manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath,
      channelPrefix: 'cn',
    });
    manager.client = client;

    const sessionId = 'rename-test-sess';
    fs.writeFileSync(channelMapPath, JSON.stringify({
      [sessionId]: {
        channelId: 'C_RENAME', channelName: 'cn-proj-feb20-2021',
        project: 'proj', active: true,
        createdAt: new Date().toISOString(),
      },
    }));

    // Simulate rename (what the handler does when spawnSlug returns a slug)
    const slug = 'fix-auth-bug';
    const newName = `cn-proj-${slug}`;
    const result = await manager.renameChannel(sessionId, newName);
    assert.equal(result, true);

    const map = JSON.parse(fs.readFileSync(channelMapPath, 'utf8'));
    assert.equal(map[sessionId].renamed, true);
    assert.equal(map[sessionId].channelName, 'cn-proj-fix-auth-bug');
  });

  it('does not rename if already renamed', async () => {
    const { client, calls } = createMockSlackClient();
    client.conversations.rename = async (opts) => {
      calls.push({ method: 'conversations.rename', args: opts });
      return { ok: true, channel: { id: opts.channel, name: opts.name } };
    };
    const channelMapPath = path.join(tempDir, 'data', 'channel-map.json');
    const mapDir = path.dirname(channelMapPath);
    fs.mkdirSync(mapDir, { recursive: true });

    const manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath,
      channelPrefix: 'cn',
    });
    manager.client = client;

    const sessionId = 'already-renamed-sess';
    fs.writeFileSync(channelMapPath, JSON.stringify({
      [sessionId]: {
        channelId: 'C_DONE', channelName: 'cn-proj-fix-bug',
        project: 'proj', active: true, renamed: true,
        createdAt: new Date().toISOString(),
      },
    }));

    const result = await manager.renameChannel(sessionId, 'cn-proj-different');
    assert.equal(result, false);

    const renameCalls = calls.filter(c => c.method === 'conversations.rename');
    assert.equal(renameCalls.length, 0);
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm test 2>&1 | tail -20`
Expected: `spawnSlug` not exported

**Step 3: Implement `spawnSlug` and the rename logic in user-prompt handler**

In `remote/hook-notify.cjs`, add the require at the top (alongside other requires):

```javascript
const { execFile } = require('child_process');
```

Add the `spawnSlug` function (near the other utility functions):

```javascript
/**
 * Spawn `claude -p` with Haiku to generate a short slug from the user's prompt.
 * Uses execFile (not exec) to avoid shell injection per security rules.
 * Returns the slug string, or null on failure/timeout.
 */
function spawnSlug(promptText) {
    return new Promise((resolve) => {
        const truncated = promptText.substring(0, 500);
        const instruction = `Generate a 2-4 word hyphenated slug summarizing this task. Output ONLY the slug, nothing else. Examples: "fix-auth-bug", "add-dark-mode", "refactor-api-client". Task: ${truncated}`;

        const env = { ...process.env, CN_SLUG_GENERATION: '1' };
        // Prevent the spawned claude from triggering hooks or creating channels
        delete env.CLAUDE_REMOTE_ACCESS;

        execFile('claude', ['-p', instruction, '--model', 'haiku', '--output-format', 'text'], {
            env,
            timeout: 15000,
            maxBuffer: 1024,
        }, (error, stdout) => {
            if (error) {
                console.warn('Slug generation failed:', error.message);
                resolve(null);
                return;
            }
            const raw = (stdout || '').trim();
            resolve(raw || null);
        });
    });
}
```

Then modify the `user-prompt` handler in `main()`. After the line `await manager.postToSessionChannel(sessionId, text);`, add the rename logic (before the `return;`):

```javascript
// Auto-rename channel on first user prompt
const mapping = manager.getChannelMapping(sessionId);
if (mapping && !mapping.renamed) {
    try {
        const raw = await spawnSlug(userPrompt);
        const slug = generateSlugName(raw);
        if (slug) {
            const safeProject = mapping.project
                ? generateSlugName(mapping.project) + '-'
                : '';
            const newName = `${manager.channelPrefix}-${safeProject}${slug}`
                .substring(0, 80)
                .replace(/-$/, '');
            await manager.renameChannel(sessionId, newName);
        }
    } catch (err) {
        console.warn('Channel rename failed:', err.message);
    }
}
```

Export `spawnSlug`:

```javascript
module.exports.spawnSlug = spawnSlug;
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm test`
Expected: ALL PASS

**Step 5: Run syntax check**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm run check`
Expected: No errors

**Step 6: Commit**

```bash
cd /Users/blainehill/Developer/claude-nonstop
git add remote/hook-notify.cjs test/unit/remote/hook-notify.test.cjs
git commit -m "feat: auto-rename Slack channels using Haiku-generated slugs

On first user prompt, spawns claude -p with Haiku model to generate a
2-4 word descriptive slug, then renames the channel from timestamp
format to project-slug format (e.g. cn-myproject-fix-auth-bug).
Falls back gracefully if claude CLI unavailable or rename fails."
```

---

### Task 5: Update documentation and run full verification

**Files:**
- Modify: `CLAUDE.md` (update terminology, hook docs)
- Modify: `DESIGN.md` (if it documents channel naming)

**Step 1: Check DESIGN.md for channel naming references**

Read `DESIGN.md` and search for channel naming references. Update any that mention the UUID format.

**Step 2: Update CLAUDE.md terminology**

In the Terminology section, update the Slack channel example:
- Old: `#cn-myproject-abc12345`
- New: `#cn-myproject-feb20-2021` (auto-renames to `#cn-myproject-fix-auth-bug`)

In the `.env.example` comments section, update the channel name format description:
- Old: `<prefix>-<project>-<session-id>`
- New: `<prefix>-<project>-<timestamp>` (auto-renames to `<prefix>-<project>-<slug>`)

**Step 3: Run full test suite**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm run test:all`
Expected: ALL PASS (including integration and security tests)

**Step 4: Run syntax check**

Run: `cd /Users/blainehill/Developer/claude-nonstop && npm run check`
Expected: No errors

**Step 5: Commit**

```bash
cd /Users/blainehill/Developer/claude-nonstop
git add CLAUDE.md DESIGN.md .env.example
git commit -m "docs: update channel naming format in documentation

Channels now use timestamp-based names that auto-rename to descriptive
slugs via Haiku after the first user prompt."
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `remote/channel-manager.cjs` | `_generateChannelName` uses timestamps; new `renameChannel()` method |
| `remote/hook-notify.cjs` | `CN_SLUG_GENERATION` guard; `spawnSlug()` calls Haiku via `execFile`; `generateSlugName()` sanitizer; user-prompt handler triggers rename |
| `test/helpers/mock-slack.cjs` | Add `conversations.rename` mock |
| `test/unit/remote/channel-manager.test.cjs` | Updated `_generateChannelName` tests; new `renameChannel` tests |
| `test/unit/remote/hook-notify.test.cjs` | New `generateSlugName`, `isSlugGeneration`, `spawnSlug` tests; rename flow tests |
| `CLAUDE.md` | Updated channel name examples |
| `DESIGN.md` | Updated channel name format references |
| `.env.example` | Updated channel name format comment |
