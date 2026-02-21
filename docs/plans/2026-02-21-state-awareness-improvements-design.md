# State Awareness & Reliability Improvements

**Date:** 2026-02-21
**Status:** Design

## Overview

Seven improvements to address the biggest gaps in claude-nonstop: blind Slack relay, scoring ignoring reset timing, limited status visibility, stale channel entries, lack of structured logging, and missing interactive controls.

## 1. Gemini-Powered Channel Naming

**Problem:** Current slug generation spawns `claude -p` with Haiku, consuming Claude credits and failing when Claude env vars leak into subprocess.

**Solution:** Replace Claude CLI call with direct HTTP `fetch()` to Gemini REST API (`generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`).

- **API key storage:** In `.env` file as `GEMINI_API_KEY`
- **Setup:** Added to `claude-nonstop setup` wizard with validation test call
- **Model:** `gemini-2.0-flash` (free tier, ~500ms response)
- **Fallback:** If Gemini fails, use existing `generateSlugName()` text-processing function (no AI, just first words of prompt)
- **No SDK dependency** — raw `fetch()` to REST endpoint

## 2. Time-Weighted Scoring Algorithm

**Problem:** `effectiveUtilization = max(sessionPercent, weeklyPercent)` ignores when accounts reset. An account at 80% resetting in 10 minutes is better than one at 60% resetting in 4 hours.

**Formula:**
```
timeWeight = timeUntilReset / MAX_RESET_WINDOW  (clamped 0.0 to 1.0)
adjustedUtil = utilization * timeWeight

sessionScore = sessionPercent * (sessionTimeUntilReset / 5h)
weeklyScore  = weeklyPercent  * (weeklyTimeUntilReset / 7d)
effectiveScore = max(sessionScore, weeklyScore)
```

- `MAX_RESET_WINDOW`: 5 hours (session), 7 days (weekly)
- When reset time is unknown/null, use `timeWeight = 1.0` (conservative)
- Lowest `effectiveScore` wins

**Example:**
- Account A: 80% session, resets in 10min → `80 * (10/300) = 2.6`
- Account B: 60% session, resets in 4h → `60 * (240/300) = 48`
- Winner: Account A (score 2.6)

## 3. Sleep Mode with Message Queue & Slack Countdown

**Problem:** Messages sent during sleep are lost. No visibility into when accounts free up.

### Message Queue
- **Storage:** `~/.claude-nonstop/data/message-queue.json`
- **Format:** `[{text, channelId, userId, timestamp}]`
- Webhook writes to queue when runner is sleeping
- On wake: replay queued messages in order via tmux, then clear queue
- Max queue size: 50 messages (oldest dropped)

### Slack Countdown
- Post rich message when entering sleep: "All accounts exhausted. Waking at {time} ({countdown})"
- Update message every 5 minutes with remaining time via `chat.update`
- Auto-delete countdown message on wake
- Include "Wake Early" button (Block Kit action)

## 4. Interactive Slack Buttons (Control + Approval)

**Implementation:** All via `app.action()` handlers in Socket Mode (already connected). No new HTTP endpoints.

### Control Buttons (on status/progress messages)
- **Stop** — sends SIGTERM / Ctrl+C to tmux
- **Pause** — sets flag in channel-map entry, webhook blocks relay until resumed
- **Resume** — clears pause flag, replays any messages queued during pause
- **Switch Account** — force triggers account swap flow
- **Archive** — archives Slack channel and deactivates map entry

### Approval Buttons (on AskUserQuestion prompts)
- Dynamic buttons generated from question options in hook output
- Clicking sends selected option text to tmux
- "Other" button opens Slack modal for custom text input
- Buttons disabled after selection (prevent double-click)

## 5. Enhanced Status Command

### CLI: `claude-nonstop status`
```
Accounts:
  ● myaccount (Blaine — blaine@example.com)  ◄ active
    5-hour:  ████████░░░░ 42%  resets in 2h 15m  (score: 34)
    7-day:   ██████░░░░░░ 28%  resets in 5d 3h   (score: 27)

  ○ personal (error: HTTP 401)

Sessions:
  myproject  #cn-myproject-fix-auth  running  swaps: 2
  other-proj #cn-other-proj-feb20    idle     swaps: 0

Swap History (last 24h): 3 swaps across 2 sessions
```

### `--json` flag
Full structured JSON output for scripts and dashboards.

### Slack `!status` command
Enhanced to show same info as CLI, formatted with Block Kit.

## 6. Structured Logging

**Approach:** Custom lightweight JSON logger (no external dependencies).

### Format (JSON Lines)
```json
{"ts":"2025-02-20T22:15:00Z","level":"info","component":"runner","event":"rate_limit_detected","account":"myaccount","swap":1}
```

### Log Files
- `~/.claude-nonstop/logs/runner.jsonl` — main process events
- `~/.claude-nonstop/logs/webhook.jsonl` — Slack webhook events
- `~/.claude-nonstop/logs/hooks.jsonl` — hook-notify events

### Rotation
- Rotate at 10MB
- Keep 3 rotated files (`.1`, `.2`, `.3`)
- Built into logger, no external tool

### Events Logged
- `session_start`, `session_end`, `rate_limit_detected`, `account_switch`, `sleep_start`, `sleep_wake`
- `message_received`, `message_relayed`, `command_executed`
- `channel_created`, `channel_renamed`, `channel_archived`
- `slug_generated`, `slug_fallback`
- `error` (any component)

## 7. Channel Lifecycle Cleanup

**Problems:** Stale inactive entries accumulate for 7 days. No way to inspect or clean manually.

**Changes:**
1. Archive Slack channels when pruning entries (not just delete from map)
2. `claude-nonstop channels` command — list all mapped channels with status
3. `claude-nonstop channels --cleanup` — archive stale Slack channels and purge map entries
4. Reduce prune age from 7 days to 24 hours for inactive entries (archived Slack channels still browsable)

## 8. Setup Wizard Enhancement

Add Gemini API key to `claude-nonstop setup`:
1. Prompt: "Enter your Google AI Studio Gemini API key (for smart channel naming):"
2. Validate with test API call to Gemini
3. On success: write `GEMINI_API_KEY=xxx` to `.env`
4. On failure: show error, allow skip (channel naming falls back to text-based slugs)
5. Mark as optional — Slack tokens remain required

## Dependencies Between Components

```
Structured Logging (6) ← foundation, implement first
    ↓
Time-Weighted Scoring (2) ← uses logger
    ↓
Sleep Mode + Queue (3) ← uses scoring, logger
    ↓
Interactive Buttons (4) ← uses queue, logger
    ↓
Setup Wizard (8) + Gemini Naming (1) ← independent
    ↓
Enhanced Status (5) ← shows scoring, sessions, swap history
    ↓
Channel Cleanup (7) ← uses logger, channel manager
```
