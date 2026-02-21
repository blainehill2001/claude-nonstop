# Terminal Output Forwarding to Slack

## Problem

Claude Code's text responses (insights, explanations, code suggestions) are visible in the terminal but never appear in Slack. Users monitoring sessions remotely only see tool-use notifications and completion messages — they miss the actual conversation content.

No `AssistantResponse` hook exists in Claude Code, so we cannot use the hook system to capture text output. The only viable approach is capturing PTY output directly from the runner.

## Architecture

### Where: runner.js PTY capture

`runner.js` already spawns Claude Code via `node-pty` and receives all terminal output through `child.onData()`. We tap into this existing stream to buffer and forward text to Slack.

### Data Flow

```
Claude Code PTY → child.onData() → stripAnsi() → output buffer file
                                                        ↓
                                              5-second flush timer
                                                        ↓
                                              hook-notify.cjs "output"
                                                        ↓
                                              Slack chat.postMessage / chat.update
```

### Flush-on-Hook Coordination

When a hook fires (PostToolUse, PreToolUse), the buffered output must appear in Slack **before** the hook's message to preserve chronological order.

```
runner.js writes buffer → hook fires → hook reads signal file
                                            ↓
                                    hook calls flush (output type)
                                            ↓
                                    hook posts its own message
```

Signal mechanism:
- **Buffer file**: `~/.claude-nonstop/data/output-buffer-{sessionId}.txt`
- **Signal file**: `~/.claude-nonstop/data/output-flush-{sessionId}.signal`

The signal file contains a monotonic counter. When runner.js flushes, it increments the counter. When a hook fires, it:
1. Reads the buffer file
2. Posts buffered content to Slack as an "output" notification
3. Writes a new counter value to the signal file
4. Clears the buffer file
5. Proceeds with its own notification

Runner.js's periodic timer also watches the signal file to detect hook-initiated flushes and avoid double-posting.

## Key Components

### Output Buffer (runner.js)

- Appends stripped PTY output to the buffer file on each `child.onData()` call
- Runs a 5-second interval timer that:
  1. Reads the buffer file
  2. If non-empty, calls `hook-notify.cjs output` with the content
  3. Clears the buffer file and increments the signal counter
- On session end, performs a final flush

### Flush-on-Hook (hook-notify.cjs)

New `output` notification type:
- Receives buffered text content
- Posts to Slack using `chat.postMessage` (new message) or `chat.update` (append to existing)
- Tracks current output message ID in channel-map entry

Existing hooks (`tool-use`, `waiting-for-input`) gain flush-before-post behavior:
1. Check buffer file — if non-empty, flush it first
2. Then post their own notification

### Message Lifecycle (channel-manager.cjs)

- `postOutputMessage(channelId, text)` — creates or updates an output message
- Output messages accumulate text via `chat.update` until finalized
- Finalization happens on:
  - Flush-on-hook (tool message follows, so start a new output message next time)
  - Message exceeding ~3900 characters (split into new message)
  - Session end

### Message Format

Output messages use a distinct format to differentiate from tool notifications:

```
Claude:
[buffered terminal output here]
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Tool fires mid-stream | Flush-on-hook: buffer flushed before tool message posts |
| Rapid successive tools | Each hook flushes; empty buffers produce no output message |
| Long response (>3900 chars) | Split at ~3900 chars, start new Slack message |
| Rate limit account swap | Final flush before swap; new session picks up fresh buffer |
| Sleep (all accounts exhausted) | Final flush before sleep; timer paused |
| `--no-remote-access` mode | No buffer file created; `child.onData()` path skipped |
| Empty buffer on timer | No-op; no Slack message posted |
| Concurrent flush race | Signal file counter prevents double-posting |
| ANSI escape codes | Already stripped by `stripAnsi()` in runner.js |
| Binary/garbage output | Unlikely from Claude Code; truncate if >10KB per flush |

## File Changes

| File | Change |
|------|--------|
| `lib/runner.js` | Add output buffer writes in `child.onData()`, 5-second flush timer, signal file management |
| `remote/hook-notify.cjs` | Add `output` notification type, flush-before-post logic for existing hooks |
| `remote/channel-manager.cjs` | Add `postOutputMessage()` / `updateOutputMessage()` methods, track output message ID in channel map |
| `remote/paths.cjs` | Add `OUTPUT_BUFFER_PATH` and `OUTPUT_SIGNAL_PATH` helper functions |

## Testing Strategy

### Unit Tests

- **Buffer accumulation**: Verify `child.onData()` appends to buffer file correctly
- **Flush timer**: Verify timer reads buffer, calls notification, clears buffer
- **Empty buffer**: Verify no Slack call on empty buffer
- **Signal counter**: Verify monotonic increment and race prevention
- **Message splitting**: Verify >3900 char content splits correctly
- **ANSI stripping**: Verify clean output in buffer
- **Flush-on-hook**: Verify hook reads and clears buffer before its own post

### Integration Tests

- **Chronological ordering**: Tool notification appears after buffered text
- **Rapid tools**: Multiple tools in succession don't produce empty output messages
- **Account swap**: Buffer flushed before swap, clean state after
- **No remote access**: No buffer files created when remote access disabled
