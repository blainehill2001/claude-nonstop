const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDir, removeTempDir } = require('../../helpers/temp-dir.cjs');

const {
  getLastAssistantMessage, parseCurrentTurn, isPerSessionMode, markdownToMrkdwn,
  extractToolDetail, formatProgressMessage, formatWaitingMessage, findTranscriptPath,
  readProgressBuffer, writeProgressBuffer, appendToProgressBuffer, progressBufferPath,
  FLUSH_INTERVAL_MS, WAITING_FOR_INPUT_TOOLS, USER_RESPONSE_TOOLS,
  formatUserResponse,
  generateSlugName, isSlugGeneration, spawnSlug, spawnRenameWorker, RENAME_WORKER_PATH,
  buildApprovalButtons,
} = require('../../../remote/hook-notify.cjs');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'fixtures', 'transcripts');

describe('getLastAssistantMessage', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('extracts text from simple session', () => {
    const result = getLastAssistantMessage(path.join(FIXTURES_DIR, 'simple-session.jsonl'));
    assert.ok(result.includes('happy to help'));
  });

  it('returns null for missing file', () => {
    assert.equal(getLastAssistantMessage('/nonexistent/file.jsonl'), null);
  });

  it('truncates at maxLength', () => {
    const result = getLastAssistantMessage(path.join(FIXTURES_DIR, 'simple-session.jsonl'), 10);
    assert.ok(result.length <= 13); // 10 + '...'
    assert.ok(result.endsWith('...'));
  });

  it('does not truncate when text is shorter than maxLength', () => {
    const result = getLastAssistantMessage(path.join(FIXTURES_DIR, 'simple-session.jsonl'), 1000);
    assert.ok(!result.endsWith('...'));
  });

  it('returns null for empty file', () => {
    const emptyFile = path.join(tempDir, 'empty.jsonl');
    fs.writeFileSync(emptyFile, '');
    assert.equal(getLastAssistantMessage(emptyFile), null);
  });

  it('returns the last assistant message from multi-turn', () => {
    const result = getLastAssistantMessage(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    assert.ok(result.includes('update the value'));
  });
});

describe('parseCurrentTurn', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('extracts tool_use entries', () => {
    const result = parseCurrentTurn(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    assert.ok(result.toolUses.length > 0);
    assert.equal(result.toolUses[0].tool, 'Edit');
  });

  it('extracts file path from input', () => {
    const result = parseCurrentTurn(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    const editTool = result.toolUses.find(t => t.tool === 'Edit');
    assert.ok(editTool);
    assert.equal(editTool.file, '/tmp/config.json');
  });

  it('extracts summary text from last assistant text block', () => {
    const result = parseCurrentTurn(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    assert.equal(result.summary, "I'll update the value in the config file.");
  });

  it('stops at user message boundary', () => {
    // The multi-turn transcript has a user message in the middle
    // parseCurrentTurn should only get the last turn
    const result = parseCurrentTurn(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    // Should only have the Edit tool from the last turn, not the Read from the first
    const tools = result.toolUses.map(t => t.tool);
    assert.ok(tools.includes('Edit'));
    assert.ok(!tools.includes('Read'));
  });

  it('returns empty result for missing file', () => {
    const result = parseCurrentTurn('/nonexistent/file.jsonl');
    assert.deepEqual(result.toolUses, []);
    assert.equal(result.summary, null);
  });

  it('returns empty result for empty file', () => {
    const emptyFile = path.join(tempDir, 'empty.jsonl');
    fs.writeFileSync(emptyFile, '');
    const result = parseCurrentTurn(emptyFile);
    assert.deepEqual(result.toolUses, []);
  });
});

describe('isPerSessionMode', () => {
  let origRemote;
  let origToken;

  beforeEach(() => {
    origRemote = process.env.CLAUDE_REMOTE_ACCESS;
    origToken = process.env.SLACK_BOT_TOKEN;
  });

  afterEach(() => {
    if (origRemote !== undefined) process.env.CLAUDE_REMOTE_ACCESS = origRemote;
    else delete process.env.CLAUDE_REMOTE_ACCESS;
    if (origToken !== undefined) process.env.SLACK_BOT_TOKEN = origToken;
    else delete process.env.SLACK_BOT_TOKEN;
  });

  it('returns true when both env vars set', () => {
    process.env.CLAUDE_REMOTE_ACCESS = 'true';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    assert.equal(isPerSessionMode(), true);
  });

  it('returns false when CLAUDE_REMOTE_ACCESS not set', () => {
    delete process.env.CLAUDE_REMOTE_ACCESS;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    assert.equal(isPerSessionMode(), false);
  });

  it('returns false when SLACK_BOT_TOKEN not set', () => {
    process.env.CLAUDE_REMOTE_ACCESS = 'true';
    delete process.env.SLACK_BOT_TOKEN;
    assert.equal(isPerSessionMode(), false);
  });

  it('returns false when CLAUDE_REMOTE_ACCESS is not "true"', () => {
    process.env.CLAUDE_REMOTE_ACCESS = 'false';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    assert.equal(isPerSessionMode(), false);
  });
});

describe('markdownToMrkdwn (re-exported)', () => {
  it('is the same function as from channel-manager', () => {
    const { markdownToMrkdwn: fromCm } = require('../../../remote/channel-manager.cjs');
    assert.equal(markdownToMrkdwn, fromCm);
  });
});

describe('extractToolDetail', () => {
  it('extracts file_path', () => {
    assert.equal(extractToolDetail('Read', { file_path: '/src/app.js' }), '/src/app.js');
  });

  it('extracts command', () => {
    assert.equal(extractToolDetail('Bash', { command: 'npm test' }), 'npm test');
  });

  it('truncates long commands to 120 chars', () => {
    const long = 'a'.repeat(200);
    assert.equal(extractToolDetail('Bash', { command: long }).length, 120);
  });

  it('extracts pattern', () => {
    assert.equal(extractToolDetail('Grep', { pattern: '*.js' }), '*.js');
  });

  it('extracts query', () => {
    assert.equal(extractToolDetail('WebSearch', { query: 'node.js streams' }), 'node.js streams');
  });

  it('extracts path', () => {
    assert.equal(extractToolDetail('Glob', { path: '/src' }), '/src');
  });

  it('extracts url', () => {
    assert.equal(extractToolDetail('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  });

  it('extracts prompt', () => {
    const result = extractToolDetail('Task', { prompt: 'Search for files' });
    assert.equal(result, 'Search for files');
  });

  it('truncates long prompts to 80 chars', () => {
    const long = 'a'.repeat(200);
    assert.equal(extractToolDetail('Task', { prompt: long }).length, 80);
  });

  it('returns null for empty input', () => {
    assert.equal(extractToolDetail('Read', {}), null);
  });

  it('returns null for null input', () => {
    assert.equal(extractToolDetail('Read', null), null);
  });

  it('returns null for non-object input', () => {
    assert.equal(extractToolDetail('Read', 'string'), null);
  });

  it('prefers file_path over command', () => {
    assert.equal(extractToolDetail('Edit', { file_path: '/file.js', command: 'echo' }), '/file.js');
  });
});

describe('formatProgressMessage', () => {
  it('returns default message for empty events', () => {
    assert.equal(formatProgressMessage([]), ':hourglass_flowing_sand: Working...');
  });

  it('returns default message for null events', () => {
    assert.equal(formatProgressMessage(null), ':hourglass_flowing_sand: Working...');
  });

  it('formats single event', () => {
    const now = Date.now();
    const result = formatProgressMessage([{ type: 'Read', detail: '/file.js', ts: now }]);
    assert.ok(result.includes(':hourglass_flowing_sand: Working...'));
    assert.ok(result.includes('Read'));
    assert.ok(result.includes('`/file.js`'));
    assert.ok(!result.includes('_Updated'));
  });

  it('formats event without detail', () => {
    const now = Date.now();
    const result = formatProgressMessage([{ type: 'Bash', detail: null, ts: now }]);
    assert.ok(result.includes('Bash'));
    assert.ok(!result.includes('`'));
  });

  it('deduplicates consecutive same events', () => {
    const now = Date.now();
    const events = [
      { type: 'Read', detail: '/file.js', ts: now },
      { type: 'Read', detail: '/file.js', ts: now },
      { type: 'Read', detail: '/file.js', ts: now },
    ];
    const result = formatProgressMessage(events);
    const readMatches = result.match(/Read/g);
    assert.equal(readMatches.length, 1);
  });

  it('keeps different consecutive events', () => {
    const now = Date.now();
    const events = [
      { type: 'Read', detail: '/a.js', ts: now },
      { type: 'Edit', detail: '/a.js', ts: now },
      { type: 'Read', detail: '/b.js', ts: now },
    ];
    const result = formatProgressMessage(events);
    assert.ok(result.includes('Read'));
    assert.ok(result.includes('Edit'));
  });

  it('limits to 8 recent events', () => {
    const now = Date.now();
    const events = [];
    for (let i = 0; i < 15; i++) {
      events.push({ type: `Tool${i}`, detail: `/file${i}.js`, ts: now });
    }
    const result = formatProgressMessage(events);
    // Should only show last 8 distinct events
    const bulletCount = (result.match(/\u2022/g) || []).length;
    assert.ok(bulletCount <= 8);
  });

});

describe('FLUSH_INTERVAL_MS', () => {
  it('is 3 seconds', () => {
    assert.equal(FLUSH_INTERVAL_MS, 3000);
  });
});

describe('progressBufferPath', () => {
  it('returns a path containing the session ID', () => {
    const p = progressBufferPath('abc-123');
    assert.ok(p.includes('progress-abc-123.json'));
    assert.ok(p.includes('progress'));
  });

  it('returns different paths for different sessions', () => {
    assert.notEqual(progressBufferPath('sess-1'), progressBufferPath('sess-2'));
  });
});

describe('readProgressBuffer / writeProgressBuffer', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('returns empty buffer for nonexistent file with lastFlushTs=0 for immediate flush', () => {
    const buf = readProgressBuffer(path.join(tempDir, 'nope.json'));
    assert.deepEqual(buf.events, []);
    assert.strictEqual(buf.lastFlushTs, 0, 'lastFlushTs should be 0 so first event flushes immediately');
  });

  it('returns empty buffer for empty file with current timestamp', () => {
    const p = path.join(tempDir, 'empty.json');
    fs.writeFileSync(p, '');
    const before = Date.now();
    const buf = readProgressBuffer(p);
    assert.deepEqual(buf.events, []);
    assert.ok(buf.lastFlushTs >= before);
  });

  it('returns empty buffer for corrupt JSON with current timestamp', () => {
    const p = path.join(tempDir, 'bad.json');
    fs.writeFileSync(p, '{not json');
    const before = Date.now();
    const buf = readProgressBuffer(p);
    assert.deepEqual(buf.events, []);
    assert.ok(buf.lastFlushTs >= before);
  });

  it('round-trips buffer through write and read', () => {
    const p = path.join(tempDir, 'buf.json');
    const buf = {
      events: [{ type: 'Read', detail: '/f.js', ts: 1000 }],
      lastFlushTs: 500,
    };
    writeProgressBuffer(p, buf);
    const result = readProgressBuffer(p);
    assert.deepEqual(result, buf);
  });

  it('creates parent directories if missing', () => {
    const p = path.join(tempDir, 'sub', 'dir', 'buf.json');
    writeProgressBuffer(p, { events: [], lastFlushTs: 0 });
    assert.ok(fs.existsSync(p));
  });

  it('writes atomically (no .tmp left behind)', () => {
    const p = path.join(tempDir, 'buf.json');
    writeProgressBuffer(p, { events: [], lastFlushTs: 0 });
    const files = fs.readdirSync(tempDir);
    assert.ok(!files.some(f => f.endsWith('.tmp')));
  });
});

describe('appendToProgressBuffer', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('creates buffer file on first event', () => {
    const p = path.join(tempDir, 'buf.json');
    const buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: 1000 });
    assert.equal(buf.events.length, 1);
    assert.equal(buf.events[0].type, 'Read');
    assert.ok(fs.existsSync(p));
  });

  it('appends to existing buffer', () => {
    const p = path.join(tempDir, 'buf.json');
    appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: 1000 });
    const buf = appendToProgressBuffer(p, { type: 'Edit', detail: '/a.js', ts: 2000 });
    assert.equal(buf.events.length, 2);
    assert.equal(buf.events[0].type, 'Read');
    assert.equal(buf.events[1].type, 'Edit');
  });

  it('preserves lastFlushTs', () => {
    const p = path.join(tempDir, 'buf.json');
    writeProgressBuffer(p, { events: [], lastFlushTs: 5000 });
    const buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: 6000 });
    assert.equal(buf.lastFlushTs, 5000);
  });

  it('caps events at 100', () => {
    const p = path.join(tempDir, 'buf.json');
    for (let i = 0; i < 110; i++) {
      appendToProgressBuffer(p, { type: `Tool${i}`, detail: null, ts: i });
    }
    const buf = readProgressBuffer(p);
    assert.equal(buf.events.length, 100);
    // Should keep the last 100 (Tool10..Tool109)
    assert.equal(buf.events[0].type, 'Tool10');
    assert.equal(buf.events[99].type, 'Tool109');
  });
});

describe('flush timing logic', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('first event SHOULD flush (lastFlushTs starts at 0 for immediate progress)', () => {
    const p = path.join(tempDir, 'buf.json');
    const buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: Date.now() });
    // New buffer gets lastFlushTs=0, so now - 0 >= FLUSH_INTERVAL_MS
    const now = Date.now();
    assert.ok(now - buf.lastFlushTs >= FLUSH_INTERVAL_MS, 'first event should flush immediately');
  });

  it('should not flush when interval has not elapsed', () => {
    const p = path.join(tempDir, 'buf.json');
    const now = Date.now();
    // Simulate a recent flush
    writeProgressBuffer(p, { events: [], lastFlushTs: now });
    const buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: now + 100 });
    const checkTime = now + 100;
    assert.ok(checkTime - buf.lastFlushTs < FLUSH_INTERVAL_MS);
  });

  it('should flush when interval has elapsed', () => {
    const p = path.join(tempDir, 'buf.json');
    const now = Date.now();
    // Simulate an old flush
    const oldFlush = now - FLUSH_INTERVAL_MS - 1;
    writeProgressBuffer(p, { events: [], lastFlushTs: oldFlush });
    const buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: now });
    assert.ok(now - buf.lastFlushTs >= FLUSH_INTERVAL_MS);
  });

  it('simulates rapid tool calls with correct flush decisions', () => {
    const p = path.join(tempDir, 'buf.json');
    const t0 = Date.now();

    // Event 1 at t=0: SHOULD flush (new buffer, lastFlushTs=0)
    let buf = appendToProgressBuffer(p, { type: 'Read', detail: '/a.js', ts: t0 });
    assert.ok(t0 - buf.lastFlushTs >= FLUSH_INTERVAL_MS, 'first event should flush immediately');

    // Simulate that flush happened: set lastFlushTs to t0
    buf.lastFlushTs = t0;
    writeProgressBuffer(p, buf);

    // Event 2 at t+500ms: should NOT flush
    buf = appendToProgressBuffer(p, { type: 'Edit', detail: '/a.js', ts: t0 + 500 });
    assert.ok((t0 + 500) - buf.lastFlushTs < FLUSH_INTERVAL_MS, 'event at +500ms should not flush');

    // Event 3 at t+1s: should NOT flush
    buf = appendToProgressBuffer(p, { type: 'Bash', detail: 'npm test', ts: t0 + 1000 });
    assert.ok((t0 + 1000) - buf.lastFlushTs < FLUSH_INTERVAL_MS, 'event at +1s should not flush');
    assert.equal(buf.events.length, 3, 'buffer should have 3 unflushed events');

    // Event 4 at t+3.5s: should flush (>3s since last flush at t0)
    buf = appendToProgressBuffer(p, { type: 'Read', detail: '/b.js', ts: t0 + 3500 });
    assert.ok((t0 + 3500) - buf.lastFlushTs >= FLUSH_INTERVAL_MS, 'event at +3.5s should flush');
    assert.equal(buf.events.length, 4, 'buffer should have 4 events to flush');

    // Simulate flush: clear events, update lastFlushTs
    buf.events = [];
    buf.lastFlushTs = t0 + 3500;
    writeProgressBuffer(p, buf);

    // Verify buffer is clean after flush
    buf = readProgressBuffer(p);
    assert.equal(buf.events.length, 0);
    assert.equal(buf.lastFlushTs, t0 + 3500);
  });
});

describe('WAITING_FOR_INPUT_TOOLS', () => {
  it('includes ExitPlanMode', () => {
    assert.ok(WAITING_FOR_INPUT_TOOLS.has('ExitPlanMode'));
  });

  it('includes AskUserQuestion', () => {
    assert.ok(WAITING_FOR_INPUT_TOOLS.has('AskUserQuestion'));
  });

  it('does not include regular tools', () => {
    assert.ok(!WAITING_FOR_INPUT_TOOLS.has('Read'));
    assert.ok(!WAITING_FOR_INPUT_TOOLS.has('Bash'));
    assert.ok(!WAITING_FOR_INPUT_TOOLS.has('Edit'));
  });
});

describe('formatWaitingMessage', () => {
  it('returns generic plan message for ExitPlanMode without transcript content', () => {
    const msg = formatWaitingMessage('ExitPlanMode', {});
    assert.ok(msg.includes(':clipboard:'));
    assert.ok(msg.includes('Plan ready'));
    assert.ok(msg.includes('!status'));
  });

  it('returns generic plan message when transcriptContent is null', () => {
    const msg = formatWaitingMessage('ExitPlanMode', {}, null);
    assert.ok(msg.includes('Plan ready'));
    assert.ok(msg.includes('!status'));
  });

  it('includes plan content when transcriptContent is provided', () => {
    const plan = '## Plan\n\n1. **Add Redis** - Create cache layer\n2. **Update routes** - Add middleware';
    const msg = formatWaitingMessage('ExitPlanMode', {}, plan);
    assert.ok(msg.includes(':clipboard:'));
    assert.ok(msg.includes('*Plan ready'));
    assert.ok(msg.includes('waiting for approval'));
    assert.ok(msg.includes('Add Redis'));
    assert.ok(msg.includes('Update routes'));
    // Should include reply instructions
    assert.ok(msg.includes('Reply here'));
    assert.ok(msg.includes('yes'));
  });

  it('converts markdown to Slack mrkdwn in plan content', () => {
    const plan = '**Bold text** and [a link](https://example.com)';
    const msg = formatWaitingMessage('ExitPlanMode', {}, plan);
    // **bold** becomes *bold* in mrkdwn
    assert.ok(msg.includes('*Bold text*'));
    // [text](url) becomes <url|text> in mrkdwn
    assert.ok(msg.includes('<https://example.com|a link>'));
  });

  it('truncates very long plan content to 39000 chars', () => {
    const longPlan = 'x'.repeat(40000);
    const msg = formatWaitingMessage('ExitPlanMode', {}, longPlan);
    // Plan content truncated, but instructions appended after
    assert.ok(msg.includes('x'.repeat(100)));
    assert.ok(msg.includes('Reply here'));
  });

  it('does not truncate plan content under 39000 chars', () => {
    const plan = 'Short plan content';
    const msg = formatWaitingMessage('ExitPlanMode', {}, plan);
    assert.ok(msg.includes('Short plan content'));
    assert.ok(msg.includes('Reply here'));
  });

  it('ignores toolInput for ExitPlanMode', () => {
    const msg = formatWaitingMessage('ExitPlanMode', { something: 'irrelevant' });
    assert.ok(msg.includes('Plan ready'));
  });

  it('returns question text for AskUserQuestion with questions', () => {
    const input = {
      questions: [{ question: 'Which database should we use?' }],
    };
    const msg = formatWaitingMessage('AskUserQuestion', input);
    assert.ok(msg.includes(':question:'));
    assert.ok(msg.includes('Which database should we use?'));
    assert.ok(msg.includes('type your answer'));
  });

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

  it('truncates long question text to 200 chars', () => {
    const longQuestion = 'a'.repeat(300);
    const input = {
      questions: [{ question: longQuestion }],
    };
    const msg = formatWaitingMessage('AskUserQuestion', input);
    assert.ok(msg.includes('a'.repeat(200) + '...'));
    assert.ok(!msg.includes('a'.repeat(201)));
  });

  it('returns generic message for AskUserQuestion without questions', () => {
    const msg = formatWaitingMessage('AskUserQuestion', {});
    assert.ok(msg.includes(':question:'));
    assert.ok(msg.includes('asking a question'));
  });

  it('returns generic message for AskUserQuestion with empty questions array', () => {
    const msg = formatWaitingMessage('AskUserQuestion', { questions: [] });
    assert.ok(msg.includes('asking a question'));
  });

  it('returns generic message for AskUserQuestion with null input', () => {
    const msg = formatWaitingMessage('AskUserQuestion', null);
    assert.ok(msg.includes('asking a question'));
  });

  it('uses first question when multiple exist', () => {
    const input = {
      questions: [
        { question: 'First question?' },
        { question: 'Second question?' },
      ],
    };
    const msg = formatWaitingMessage('AskUserQuestion', input);
    assert.ok(msg.includes('First question?'));
    assert.ok(!msg.includes('Second question?'));
  });

  it('returns fallback message for unknown tool', () => {
    const msg = formatWaitingMessage('SomeUnknownTool', {});
    assert.ok(msg.includes(':hourglass:'));
    assert.ok(msg.includes('Waiting for input'));
    assert.ok(msg.includes('reply here'));
  });

  it('ignores transcriptContent for non-ExitPlanMode tools', () => {
    const msg = formatWaitingMessage('AskUserQuestion', null, 'some plan text');
    assert.ok(msg.includes('asking a question'));
    assert.ok(!msg.includes('some plan text'));
  });
});

describe('findTranscriptPath', () => {
  let tempDir;
  let origConfigDir;

  beforeEach(() => {
    tempDir = createTempDir();
    origConfigDir = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    removeTempDir(tempDir);
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    else delete process.env.CLAUDE_CONFIG_DIR;
  });

  it('returns path when transcript file exists', () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const cwd = '/Users/test/myproject';
    const sessionId = 'abc-123-def';
    const cwdHash = cwd.replace(/\//g, '-');
    const projectDir = path.join(tempDir, 'projects', cwdHash);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{}');

    const result = findTranscriptPath(sessionId, cwd);
    assert.ok(result);
    assert.ok(result.endsWith(`${sessionId}.jsonl`));
    assert.ok(result.includes('projects'));
  });

  it('returns null when transcript file does not exist', () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const result = findTranscriptPath('nonexistent-session', '/some/path');
    assert.equal(result, null);
  });

  it('returns null when CLAUDE_CONFIG_DIR is not set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const result = findTranscriptPath('abc-123', '/some/path');
    assert.equal(result, null);
  });

  it('returns null when sessionId is null', () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const result = findTranscriptPath(null, '/some/path');
    assert.equal(result, null);
  });

  it('returns null when cwd is null', () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const result = findTranscriptPath('abc-123', null);
    assert.equal(result, null);
  });

  it('computes correct cwdHash from cwd', () => {
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    const cwd = '/Users/rc/code/claude-nonstop';
    const sessionId = 'test-session';
    const expectedHash = '-Users-rc-code-claude-nonstop';
    const projectDir = path.join(tempDir, 'projects', expectedHash);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{}');

    const result = findTranscriptPath(sessionId, cwd);
    assert.ok(result);
    assert.ok(result.includes(expectedHash));
  });
});

describe('plan mode transcript integration', () => {
  it('getLastAssistantMessage extracts plan text from plan-mode transcript', () => {
    const transcriptPath = path.join(FIXTURES_DIR, 'plan-mode.jsonl');
    const result = getLastAssistantMessage(transcriptPath);
    assert.ok(result, 'should find plan text in transcript');
    assert.ok(result.includes('Implementation Plan'));
    assert.ok(result.includes('Add Redis client'));
    assert.ok(result.includes('cache middleware'));
  });

  it('parseCurrentTurn finds ExitPlanMode tool use in plan-mode transcript', () => {
    const transcriptPath = path.join(FIXTURES_DIR, 'plan-mode.jsonl');
    const result = parseCurrentTurn(transcriptPath);
    const exitPlan = result.toolUses.find(t => t.tool === 'ExitPlanMode');
    assert.ok(exitPlan, 'should find ExitPlanMode tool use');
  });

  it('parseCurrentTurn extracts plan summary from plan-mode transcript', () => {
    const transcriptPath = path.join(FIXTURES_DIR, 'plan-mode.jsonl');
    const result = parseCurrentTurn(transcriptPath);
    assert.ok(result.summary);
    assert.ok(result.summary.includes('plan'));
  });

  it('formatWaitingMessage with real transcript content produces complete plan message', () => {
    const transcriptPath = path.join(FIXTURES_DIR, 'plan-mode.jsonl');
    const planContent = getLastAssistantMessage(transcriptPath);
    const msg = formatWaitingMessage('ExitPlanMode', {}, planContent);
    assert.ok(msg.includes(':clipboard:'));
    assert.ok(msg.includes('*Plan ready'));
    assert.ok(msg.includes('Add Redis client'));
    assert.ok(msg.includes('cache middleware'));
    assert.ok(msg.includes('Files to modify'));
  });
});

describe('user-prompt handler', () => {
  const SlackChannelManager = require('../../../remote/channel-manager.cjs');
  const { createMockSlackClient } = require('../../helpers/mock-slack.cjs');
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  /**
   * Replicate the user-prompt formatting logic from main() so we can test
   * the exact message that would be posted to Slack.
   */
  function formatUserPromptMessage(userPrompt) {
    const MAX_PROMPT_DISPLAY = 3900;
    let displayText = userPrompt.trim();
    if (displayText.length > MAX_PROMPT_DISPLAY) {
      displayText = displayText.substring(0, MAX_PROMPT_DISPLAY) + '...';
    }
    return `:bust_in_silhouette: *You:*\n>>> ${displayText}`;
  }

  it('formats short prompt with user icon and block quote', () => {
    const msg = formatUserPromptMessage('Hello Claude');
    assert.ok(msg.startsWith(':bust_in_silhouette: *You:*'));
    assert.ok(msg.includes('>>> Hello Claude'));
  });

  it('trims whitespace from prompt before formatting', () => {
    const msg = formatUserPromptMessage('  padded text  ');
    assert.ok(msg.includes('>>> padded text'));
    assert.ok(!msg.includes('  padded text  '));
  });

  it('truncates prompts longer than 3900 characters', () => {
    const longPrompt = 'x'.repeat(5000);
    const msg = formatUserPromptMessage(longPrompt);
    // Should contain exactly 3900 x's plus '...'
    const afterPrefix = msg.split('>>> ')[1];
    assert.equal(afterPrefix, 'x'.repeat(3900) + '...');
  });

  it('does not truncate prompts at exactly 3900 characters', () => {
    const exactPrompt = 'y'.repeat(3900);
    const msg = formatUserPromptMessage(exactPrompt);
    const afterPrefix = msg.split('>>> ')[1];
    assert.equal(afterPrefix, 'y'.repeat(3900));
    assert.ok(!afterPrefix.endsWith('...'));
  });

  it('does not truncate prompts shorter than 3900 characters', () => {
    const shortPrompt = 'z'.repeat(100);
    const msg = formatUserPromptMessage(shortPrompt);
    const afterPrefix = msg.split('>>> ')[1];
    assert.equal(afterPrefix, 'z'.repeat(100));
  });

  it('empty or whitespace-only prompts are detected', () => {
    // The handler guards with: if (!userPrompt || !userPrompt.trim()) return;
    // Test the same condition
    const emptyValues = [null, undefined, '', '   ', '\n\t'];
    for (const val of emptyValues) {
      const shouldSkip = !val || !val.trim();
      assert.ok(shouldSkip, `Should skip prompt: ${JSON.stringify(val)}`);
    }
    // Non-empty prompts should NOT be skipped
    const validValues = ['hello', '  hello  ', 'a'];
    for (const val of validValues) {
      const shouldSkip = !val || !val.trim();
      assert.ok(!shouldSkip, `Should NOT skip prompt: ${JSON.stringify(val)}`);
    }
  });

  it('isPerSessionMode gates the handler', () => {
    const origRemote = process.env.CLAUDE_REMOTE_ACCESS;
    const origToken = process.env.SLACK_BOT_TOKEN;
    try {
      // Without per-session mode, handler would return early
      delete process.env.CLAUDE_REMOTE_ACCESS;
      delete process.env.SLACK_BOT_TOKEN;
      assert.equal(isPerSessionMode(), false);

      // With per-session mode enabled
      process.env.CLAUDE_REMOTE_ACCESS = 'true';
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      assert.equal(isPerSessionMode(), true);
    } finally {
      if (origRemote !== undefined) process.env.CLAUDE_REMOTE_ACCESS = origRemote;
      else delete process.env.CLAUDE_REMOTE_ACCESS;
      if (origToken !== undefined) process.env.SLACK_BOT_TOKEN = origToken;
      else delete process.env.SLACK_BOT_TOKEN;
    }
  });

  it('posts formatted message to session channel via channel manager', async () => {
    const { client, calls } = createMockSlackClient();
    const channelMapPath = path.join(tempDir, 'data', 'channel-map.json');
    const manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath,
      channelPrefix: 'cn',
    });
    manager.client = client;

    // Set up a channel mapping for the session
    const sessionId = 'test-session-123';
    const channelId = 'C000001';
    const mapDir = path.dirname(channelMapPath);
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(channelMapPath, JSON.stringify({
      [sessionId]: { channelId, channelName: 'cn-test', active: true },
    }));

    // Simulate what the user-prompt handler does
    const userPrompt = 'Fix the login bug';
    const text = formatUserPromptMessage(userPrompt);
    const result = await manager.postToSessionChannel(sessionId, text);

    assert.equal(result, true);
    const postCall = calls.find(c => c.method === 'chat.postMessage');
    assert.ok(postCall, 'Should have called chat.postMessage');
    assert.equal(postCall.args.channel, channelId);
    assert.ok(postCall.args.text.includes(':bust_in_silhouette: *You:*'));
    assert.ok(postCall.args.text.includes('>>> Fix the login bug'));
  });

  it('clearProgressMessage is called before posting', async () => {
    const { client, calls } = createMockSlackClient();
    // Add a chat.delete method to the mock (clearProgressMessage uses it)
    client.chat.delete = async (opts) => {
      calls.push({ method: 'chat.delete', args: opts });
      return { ok: true };
    };
    const channelMapPath = path.join(tempDir, 'data', 'channel-map.json');
    const manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath,
      channelPrefix: 'cn',
    });
    manager.client = client;

    const sessionId = 'test-session-456';
    const channelId = 'C000002';
    const mapDir = path.dirname(channelMapPath);
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(channelMapPath, JSON.stringify({
      [sessionId]: {
        channelId, channelName: 'cn-test', active: true,
        progressMessageTs: '1234.5678',
      },
    }));

    // Simulate the handler sequence: clear progress, then post
    await manager.clearProgressMessage(sessionId);
    const text = formatUserPromptMessage('Hello');
    await manager.postToSessionChannel(sessionId, text);

    // Verify clear happened before post
    const deleteIdx = calls.findIndex(c => c.method === 'chat.delete');
    const postIdx = calls.findIndex(c => c.method === 'chat.postMessage');
    assert.ok(deleteIdx >= 0, 'Should have called chat.delete for progress message');
    assert.ok(postIdx >= 0, 'Should have called chat.postMessage');
    assert.ok(deleteIdx < postIdx, 'chat.delete should happen before chat.postMessage');
  });

  it('channel lookup returns null for unknown session', () => {
    const { client } = createMockSlackClient();
    const channelMapPath = path.join(tempDir, 'data', 'channel-map.json');
    const manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath,
      channelPrefix: 'cn',
    });
    manager.client = client;

    const mapDir = path.dirname(channelMapPath);
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(channelMapPath, JSON.stringify({}));

    const mapping = manager.getChannelMapping('nonexistent-session');
    assert.equal(mapping, null);
  });

  it('postToSessionChannel returns false when no channel mapping exists', async () => {
    const { client } = createMockSlackClient();
    const channelMapPath = path.join(tempDir, 'data', 'channel-map.json');
    const manager = new SlackChannelManager({
      botToken: 'xoxb-test',
      channelMapPath,
      channelPrefix: 'cn',
    });
    manager.client = client;

    const mapDir = path.dirname(channelMapPath);
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(channelMapPath, JSON.stringify({}));

    const text = formatUserPromptMessage('Hello');
    const result = await manager.postToSessionChannel('no-such-session', text);
    assert.equal(result, false);
  });
});

describe('slug generation', () => {
  it('is exported from hook-notify', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    assert.equal(typeof mod.generateSlugName, 'function');
  });

  it('converts slug output to Slack-safe channel name segment', () => {
    assert.equal(generateSlugName('Fix Auth Bug'), 'fix-auth-bug');
  });

  it('strips non-alphanumeric characters', () => {
    assert.equal(generateSlugName('fix: the "auth" bug!'), 'fix-the-auth-bug');
  });

  it('collapses multiple hyphens', () => {
    assert.equal(generateSlugName('fix---auth---bug'), 'fix-auth-bug');
  });

  it('strips leading/trailing hyphens', () => {
    assert.equal(generateSlugName('-fix-bug-'), 'fix-bug');
  });

  it('truncates to maxLength', () => {
    const long = 'a-very-long-slug-that-exceeds-the-max-length-allowed';
    const result = generateSlugName(long, 20);
    assert.ok(result.length <= 20);
    assert.ok(!result.endsWith('-'));
  });

  it('returns null for empty input', () => {
    assert.equal(generateSlugName(''), null);
    assert.equal(generateSlugName('   '), null);
    assert.equal(generateSlugName(null), null);
  });
});

describe('CN_SLUG_GENERATION recursion guard', () => {
  it('isSlugGeneration returns true when env is set', () => {
    const orig = process.env.CN_SLUG_GENERATION;
    try {
      process.env.CN_SLUG_GENERATION = '1';
      assert.equal(isSlugGeneration(), true);
    } finally {
      if (orig !== undefined) process.env.CN_SLUG_GENERATION = orig;
      else delete process.env.CN_SLUG_GENERATION;
    }
  });

  it('isSlugGeneration returns false when env is not set', () => {
    const orig = process.env.CN_SLUG_GENERATION;
    try {
      delete process.env.CN_SLUG_GENERATION;
      assert.equal(isSlugGeneration(), false);
    } finally {
      if (orig !== undefined) process.env.CN_SLUG_GENERATION = orig;
      else delete process.env.CN_SLUG_GENERATION;
    }
  });
});

describe('spawnSlug', () => {
  it('is exported from hook-notify', () => {
    const mod = require('../../../remote/hook-notify.cjs');
    assert.equal(typeof mod.spawnSlug, 'function');
  });

  it('returns null when GEMINI_API_KEY is not set', async () => {
    const orig = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      const result = await spawnSlug('fix the auth bug');
      assert.equal(result, null);
    } finally {
      if (orig !== undefined) process.env.GEMINI_API_KEY = orig;
      else delete process.env.GEMINI_API_KEY;
    }
  });

  it('is an async function', () => {
    // spawnSlug returns a promise
    const orig = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const result = spawnSlug('test');
    assert.ok(result instanceof Promise);
    if (orig !== undefined) process.env.GEMINI_API_KEY = orig;
  });
});

describe('USER_RESPONSE_TOOLS', () => {
  it('includes AskUserQuestion', () => {
    assert.ok(USER_RESPONSE_TOOLS.has('AskUserQuestion'));
  });

  it('includes ExitPlanMode', () => {
    assert.ok(USER_RESPONSE_TOOLS.has('ExitPlanMode'));
  });

  it('does not include regular tools', () => {
    assert.ok(!USER_RESPONSE_TOOLS.has('Read'));
    assert.ok(!USER_RESPONSE_TOOLS.has('Bash'));
    assert.ok(!USER_RESPONSE_TOOLS.has('Edit'));
  });
});

describe('formatUserResponse', () => {
  // ── AskUserQuestion ──

  it('extracts answer from structured answers object', () => {
    const resp = { answers: { 'Which database?': 'PostgreSQL' } };
    const result = formatUserResponse('AskUserQuestion', {}, resp);
    assert.equal(result, 'PostgreSQL');
  });

  it('joins multiple answers with newlines', () => {
    const resp = { answers: { 'Database?': 'PostgreSQL', 'Cache?': 'Redis' } };
    const result = formatUserResponse('AskUserQuestion', {}, resp);
    assert.equal(result, 'PostgreSQL\nRedis');
  });

  it('extracts answer from JSON string with answers field', () => {
    const resp = JSON.stringify({ answers: { 'Color?': 'Blue' } });
    const result = formatUserResponse('AskUserQuestion', {}, resp);
    assert.equal(result, 'Blue');
  });

  it('extracts result string from object', () => {
    const resp = { result: 'User chose option A' };
    const result = formatUserResponse('AskUserQuestion', {}, resp);
    assert.equal(result, 'User chose option A');
  });

  it('returns plain string response as-is', () => {
    const result = formatUserResponse('AskUserQuestion', {}, 'Option B');
    assert.equal(result, 'Option B');
  });

  it('returns null for empty string response', () => {
    const result = formatUserResponse('AskUserQuestion', {}, '');
    assert.equal(result, null);
  });

  it('returns null for whitespace-only string response', () => {
    const result = formatUserResponse('AskUserQuestion', {}, '   ');
    assert.equal(result, null);
  });

  it('returns null for null response', () => {
    const result = formatUserResponse('AskUserQuestion', null, null);
    assert.equal(result, null);
  });

  it('returns null for undefined response', () => {
    const result = formatUserResponse('AskUserQuestion', null, undefined);
    assert.equal(result, null);
  });

  it('returns null for empty answers object', () => {
    const resp = { answers: {} };
    const result = formatUserResponse('AskUserQuestion', {}, resp);
    assert.equal(result, null);
  });

  // ── ExitPlanMode ──

  it('returns string response for ExitPlanMode', () => {
    const result = formatUserResponse('ExitPlanMode', {}, 'yes');
    assert.equal(result, 'yes');
  });

  it('trims ExitPlanMode string response', () => {
    const result = formatUserResponse('ExitPlanMode', {}, '  approved  ');
    assert.equal(result, 'approved');
  });

  it('extracts result from ExitPlanMode object response', () => {
    const resp = { result: 'Plan approved' };
    const result = formatUserResponse('ExitPlanMode', {}, resp);
    assert.equal(result, 'Plan approved');
  });

  it('extracts result from ExitPlanMode JSON string', () => {
    const resp = JSON.stringify({ result: 'Looks good' });
    const result = formatUserResponse('ExitPlanMode', {}, resp);
    assert.equal(result, 'Looks good');
  });

  it('returns null for empty ExitPlanMode response', () => {
    const result = formatUserResponse('ExitPlanMode', {}, '');
    assert.equal(result, null);
  });

  it('returns null for null ExitPlanMode response', () => {
    const result = formatUserResponse('ExitPlanMode', null, null);
    assert.equal(result, null);
  });

  // ── Unknown tools ──

  it('returns null for unknown tool names', () => {
    const result = formatUserResponse('Read', {}, 'some response');
    assert.equal(result, null);
  });

  it('returns null for unknown tool with object response', () => {
    const result = formatUserResponse('Bash', {}, { output: 'hello' });
    assert.equal(result, null);
  });
});

describe('spawnSlug Gemini API', () => {
  it('uses Gemini REST API endpoint', () => {
    const src = spawnSlug.toString();
    assert.ok(src.includes('generativelanguage.googleapis.com'), 'should use Gemini API');
  });

  it('uses gemini-2.0-flash model', () => {
    const src = spawnSlug.toString();
    assert.ok(src.includes('gemini-2.0-flash'), 'should use gemini-2.0-flash model');
  });

  it('checks for GEMINI_API_KEY env var', () => {
    const src = spawnSlug.toString();
    assert.ok(src.includes('GEMINI_API_KEY'), 'should check GEMINI_API_KEY');
  });
});

describe('rename worker', () => {
  it('RENAME_WORKER_PATH points to rename-worker.cjs', () => {
    assert.ok(RENAME_WORKER_PATH.endsWith('rename-worker.cjs'));
  });

  it('rename-worker.cjs exists on disk', () => {
    assert.ok(fs.existsSync(RENAME_WORKER_PATH));
  });

  it('rename-worker.cjs has valid syntax', () => {
    // Requiring the module validates syntax
    const worker = require(RENAME_WORKER_PATH);
    assert.ok(worker !== undefined);
  });

  it('spawnRenameWorker is exported and callable', () => {
    assert.equal(typeof spawnRenameWorker, 'function');
  });

  it('spawnRenameWorker does not throw with valid args', () => {
    // This spawns a real detached process, but it will exit immediately
    // because there's no SLACK_BOT_TOKEN in the test environment
    assert.doesNotThrow(() => {
      spawnRenameWorker('test-session-nonexistent', 'fix auth bug', 'cn');
    });
  });
});

describe('buildApprovalButtons', () => {
  it('returns Approve button for ExitPlanMode', () => {
    const blocks = buildApprovalButtons('ExitPlanMode', {});
    assert.ok(blocks);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'actions');
    assert.equal(blocks[0].elements[0].text.text, 'Approve');
    assert.equal(blocks[0].elements[0].value, 'yes');
    assert.equal(blocks[0].elements[0].style, 'primary');
  });

  it('returns option buttons for AskUserQuestion', () => {
    const input = {
      questions: [{
        question: 'Which DB?',
        options: [
          { label: 'PostgreSQL', description: 'Relational' },
          { label: 'MongoDB', description: 'Document' },
        ],
      }],
    };
    const blocks = buildApprovalButtons('AskUserQuestion', input);
    assert.ok(blocks);
    assert.equal(blocks[0].elements.length, 2);
    assert.equal(blocks[0].elements[0].text.text, 'PostgreSQL');
    assert.equal(blocks[0].elements[0].value, 'PostgreSQL');
    assert.equal(blocks[0].elements[0].action_id, 'cn_option_0');
    assert.equal(blocks[0].elements[0].style, 'primary');
    assert.equal(blocks[0].elements[1].text.text, 'MongoDB');
    assert.equal(blocks[0].elements[1].action_id, 'cn_option_1');
    assert.ok(!blocks[0].elements[1].style);
  });

  it('limits to 4 options max', () => {
    const input = {
      questions: [{
        question: 'Pick one',
        options: [
          { label: 'A' }, { label: 'B' }, { label: 'C' },
          { label: 'D' }, { label: 'E' }, { label: 'F' },
        ],
      }],
    };
    const blocks = buildApprovalButtons('AskUserQuestion', input);
    assert.equal(blocks[0].elements.length, 4);
  });

  it('returns null for AskUserQuestion with no options', () => {
    assert.equal(buildApprovalButtons('AskUserQuestion', { questions: [{ question: 'Q?' }] }), null);
    assert.equal(buildApprovalButtons('AskUserQuestion', { questions: [{ question: 'Q?', options: [] }] }), null);
  });

  it('returns null for AskUserQuestion with no questions', () => {
    assert.equal(buildApprovalButtons('AskUserQuestion', {}), null);
    assert.equal(buildApprovalButtons('AskUserQuestion', { questions: [] }), null);
  });

  it('returns null for unknown tool', () => {
    assert.equal(buildApprovalButtons('Read', {}), null);
  });

  it('truncates long option labels to 75 chars', () => {
    const longLabel = 'x'.repeat(100);
    const input = {
      questions: [{
        question: 'Pick',
        options: [{ label: longLabel }],
      }],
    };
    const blocks = buildApprovalButtons('AskUserQuestion', input);
    assert.equal(blocks[0].elements[0].text.text.length, 75);
  });
});

describe('formatOutputMessage', () => {
    it('formats output text by trimming', () => {
        const { formatOutputMessage } = require('../../../remote/hook-notify.cjs');
        const result = formatOutputMessage('  Hello world  ');
        assert.equal(result, 'Hello world');
    });

    it('returns null for empty text', () => {
        const { formatOutputMessage } = require('../../../remote/hook-notify.cjs');
        assert.equal(formatOutputMessage(''), null);
    });

    it('returns null for null', () => {
        const { formatOutputMessage } = require('../../../remote/hook-notify.cjs');
        assert.equal(formatOutputMessage(null), null);
    });

    it('returns null for whitespace-only text', () => {
        const { formatOutputMessage } = require('../../../remote/hook-notify.cjs');
        assert.equal(formatOutputMessage('   \n\n  '), null);
    });

    it('preserves newlines in content', () => {
        const { formatOutputMessage } = require('../../../remote/hook-notify.cjs');
        const result = formatOutputMessage('line 1\nline 2\nline 3');
        assert.equal(result, 'line 1\nline 2\nline 3');
    });
});

