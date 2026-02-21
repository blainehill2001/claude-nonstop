#!/usr/bin/env node

/**
 * claude-nonstop — Multi-account switching + Slack remote access for Claude Code.
 *
 * Commands:
 *   [args...]           Run Claude with best account + auto-switching (default)
 *   resume [id]        Resume a session from any account (finds + migrates)
 *   add <name>         Register a new Claude account and launch login
 *   remove <name>      Remove a registered account
 *   reauth             Re-authenticate accounts with expired tokens
 *   list               List all accounts with auth status
 *   status [--json]    Show detailed usage, scores, and sessions
 *   channels           List/cleanup mapped Slack channels
 *   setup [flags]      Slack remote access setup (interactive or via flags/env)
 *   webhook            Start the Slack webhook (Socket Mode, foreground)
 *   webhook install    Install + start webhook as launchd service
 *   webhook uninstall  Stop + remove webhook launchd service
 *   webhook restart    Restart the webhook service
 *   webhook status     Show webhook service status
 *   webhook logs       Tail the webhook log file
 *   hooks install      Install hooks into all profile settings
 *   hooks status       Show hook installation status
 *   update             Reinstall from local source
 *   uninstall          Remove claude-nonstop completely
 *   help               Show this help message
 */

import { spawn, execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addAccount, removeAccount, getAccounts, ensureDefaultAccount, CONFIG_DIR, DEFAULT_CLAUDE_DIR } from '../lib/config.js';
import { readCredentials, isTokenExpired, deleteKeychainEntry } from '../lib/keychain.js';
import { checkAllUsage, checkUsage, fetchProfile } from '../lib/usage.js';
import { pickBestAccount, effectiveScore } from '../lib/scorer.js';
import { run } from '../lib/runner.js';
import { reauthAccount, silentRefresh } from '../lib/reauth.js';
import { isMacOS } from '../lib/platform.js';
import { installService, uninstallService, restartService, getServiceStatus, isServiceInstalled, LOG_PATH } from '../lib/service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0];

// Auto-detect default account once at startup
ensureDefaultAccount();

try {
  switch (command) {
    case 'add':
      await cmdAdd(args.slice(1));
      break;

    case 'remove':
      await cmdRemove(args.slice(1));
      break;

    case 'list':
      await cmdList();
      break;

    case 'status':
      await cmdStatus(args.slice(1));
      break;

    case 'setup':
      await cmdSetup(args.slice(1));
      break;

    case 'webhook':
      await cmdWebhook(args.slice(1));
      break;

    case 'hooks':
      await cmdHooks(args.slice(1));
      break;

    case 'uninstall':
      await cmdUninstall(args.slice(1));
      break;

    case 'reauth':
      await cmdReauth();
      break;

    case 'update':
      await cmdUpdate();
      break;

    case 'resume':
      await cmdResume(args.slice(1));
      break;

    case 'channels':
      await cmdChannels(args.slice(1));
      break;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;

    case undefined:
      // No command given — default to running Claude
      await cmdRun([]);
      break;

    default:
      // Unknown command — treat as args to run (e.g. `claude-nonstop -p "fix bug"`)
      await cmdRun(args);
      break;
  }
} catch (err) {
  console.error(`[claude-nonstop] Fatal error: ${err.message}`);
  process.exit(1);
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdAdd(args) {
  const name = args[0];
  if (!name) {
    console.error('Usage: claude-nonstop add <name>');
    console.error('Example: claude-nonstop add work');
    process.exit(1);
  }

  try {
    const configDir = addAccount(name);
    console.log(`Account "${name}" registered.`);
    console.log(`Config directory: ${configDir}`);
    console.log('');
    console.log('Opening browser for login...');
    console.log('');

    // Use `claude auth login` for non-interactive browser-based OAuth.
    // Strip CLAUDECODE env var so this works when called from inside a Claude Code session.
    const authEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    delete authEnv.CLAUDECODE;

    await new Promise((resolve) => {
      const child = spawn('claude', ['auth', 'login'], {
        env: authEnv,
        stdio: 'inherit',
      });

      child.on('close', () => resolve());
      child.on('error', (err) => {
        console.error(`Failed to launch Claude Code: ${err.message}`);
        console.error('Make sure "claude" is installed and in your PATH.');
        resolve();
      });
    });

    // Verify credentials were saved
    const creds = readCredentials(configDir);
    if (!creds.token) {
      console.log('');
      console.log(`Warning: No credentials found for "${name}".`);
      console.log(`You can login later by running: CLAUDE_CONFIG_DIR="${configDir}" claude auth login`);
      return;
    }

    console.log('');
    console.log(`Account "${name}" authenticated. Checking for duplicates...`);

    // Duplicate detection: compare profile email against existing accounts
    const newProfile = await fetchProfile(creds.token);
    if (newProfile.email) {
      const existingAccounts = getAccounts().filter(a => a.name !== name);
      const existingProfiles = await Promise.all(existingAccounts.map(async (a) => {
        const existingCreds = readCredentials(a.configDir);
        if (!existingCreds.token) return { ...a, email: null };
        const profile = await fetchProfile(existingCreds.token);
        return { ...a, email: profile.email };
      }));

      const duplicate = existingProfiles.find(a => a.email && a.email === newProfile.email);
      if (duplicate) {
        console.error(`\nError: "${name}" (${newProfile.email}) is the same account as "${duplicate.name}".`);
        console.error('Each account must be a different Claude subscription.');
        console.error(`Removing "${name}"...`);
        removeAccount(name);
        process.exit(1);
      }
    }

    console.log(`Account "${name}" added successfully.`);
    if (newProfile.email) console.log(`Email: ${newProfile.email}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdRemove(args) {
  const name = args[0];
  if (!name) {
    console.error('Usage: claude-nonstop remove <name>');
    process.exit(1);
  }

  try {
    removeAccount(name);
    console.log(`Account "${name}" removed.`);
    console.log('Note: Credentials in Keychain and config directory were not deleted.');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdReauth() {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.log('No accounts registered.');
    return;
  }

  // Check which accounts have expired tokens
  console.log('Checking account credentials...\n');

  const accountsWithTokens = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token, expiresAt: creds.expiresAt, error: creds.error };
  });

  const withTokens = accountsWithTokens.filter(a => a.token);
  const noTokens = accountsWithTokens.filter(a => !a.token);

  // Pre-check: tokens expired per keychain expiresAt
  const localExpired = withTokens.filter(a => isTokenExpired({ expiresAt: a.expiresAt }));

  // Check usage API for remaining accounts that have non-expired tokens
  const toCheck = withTokens.filter(a => !isTokenExpired({ expiresAt: a.expiresAt }));
  let expired = [...noTokens, ...localExpired];
  if (toCheck.length > 0) {
    const withUsage = await checkAllUsage(toCheck);
    for (const a of withUsage) {
      if (a.usage?.error) {
        expired.push(a);
      }
    }
  }

  if (expired.length === 0) {
    console.log('All accounts are authenticated and working.');
    return;
  }

  console.log(`Found ${expired.length} account(s) needing re-authentication:\n`);
  for (const a of expired) {
    const reason = a.token
      ? (isTokenExpired({ expiresAt: a.expiresAt }) ? 'token expired' : `API error (${a.usage?.error || 'unknown'})`)
      : (a.error || 'no credentials');
    console.log(`  ${a.name}: ${reason}`);
  }
  console.log('');

  // First pass: try silent refresh for accounts that have tokens
  let successCount = 0;
  const stillExpired = [];
  const silentCandidates = expired.filter(a => a.token);

  if (silentCandidates.length > 0) {
    console.log('Attempting silent token refresh...');
    for (const account of silentCandidates) {
      if (await silentRefresh(account)) {
        console.log(`  ${account.name}: refreshed`);
        successCount++;
      } else {
        stillExpired.push(account);
      }
    }
    // Add accounts with no token (need browser login)
    stillExpired.push(...expired.filter(a => !a.token));
    console.log('');
  } else {
    stillExpired.push(...expired);
  }

  // Second pass: browser-based re-auth for remaining accounts
  for (let i = 0; i < stillExpired.length; i++) {
    console.log(`[${i + 1}/${stillExpired.length}]`);
    const success = await reauthAccount(stillExpired[i]);
    if (success) successCount++;
    console.log('');
  }

  console.log(`Re-authentication complete. ${successCount}/${expired.length} account(s) refreshed.`);
  console.log('Run "claude-nonstop status" to verify.');
}

async function cmdUpdate() {
  // Find the source git repo. The installed package (e.g. /opt/homebrew/lib/node_modules/...)
  // is not a git repo, so we search common locations for the cloned source.
  function isClaudeNonstopRepo(dir) {
    try {
      if (!existsSync(join(dir, 'package.json'))) return false;
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name !== 'claude-nonstop') return false;
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'pipe' });
      return true;
    } catch { return false; }
  }

  const home = process.env.HOME || '';
  const candidates = [
    join(home, 'code', 'claude-nonstop'),
    join(home, 'src', 'claude-nonstop'),
    join(home, 'projects', 'claude-nonstop'),
    join(home, 'dev', 'claude-nonstop'),
    join(home, 'repos', 'claude-nonstop'),
  ];

  let repoDir = candidates.find(isClaudeNonstopRepo);

  if (!repoDir) {
    console.error('Could not find the claude-nonstop git repo.');
    console.error('Checked: ' + candidates.join(', '));
    console.error('\nClone it first:');
    console.error('  git clone https://github.com/rchaz/claude-nonstop.git ~/code/claude-nonstop');
    process.exit(1);
  }

  console.log(`Updating from ${repoDir}...\n`);

  // 1. Remind user to pull if there's a remote
  try {
    const remotes = execFileSync('git', ['remote'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    if (remotes) {
      console.log(`Tip: Run "cd ${repoDir} && git pull" first to get the latest changes.\n`);
    }
  } catch {}

  // 2. npm pack + install
  console.log('\nReinstalling...');
  try {
    const tgz = execFileSync('npm', ['pack'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    const tgzPath = join(repoDir, tgz);
    execFileSync('npm', ['install', '-g', tgzPath], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' });
    console.log(`  Installed ${tgz}`);
  } catch (err) {
    console.error(`  npm install failed: ${err.message}`);
    process.exit(1);
  }

  // 3. Reinstall hooks to pick up any new/changed hook types
  console.log('\nReinstalling hooks...');
  installHooksToAllProfiles();

  // 4. postinstall handles webhook restart, but verify
  if (isMacOS() && isServiceInstalled()) {
    console.log('\nWebhook service restarted by postinstall.');
  }

  console.log('\nUpdate complete.');
}

async function cmdList() {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.log('No accounts registered.');
    console.log('Run "claude-nonstop add <name>" to register an account.');
    return;
  }

  console.log('Accounts:\n');

  // Read credentials and fetch profiles in parallel
  const enriched = await Promise.all(accounts.map(async (account) => {
    const creds = readCredentials(account.configDir);
    const profile = creds.token ? await fetchProfile(creds.token) : { name: null, email: null };
    return { ...account, creds, profile };
  }));

  for (const { name, configDir, creds, profile } of enriched) {
    const status = creds.token ? 'authenticated' : 'not authenticated';
    const userInfo = formatUserInfo(profile);
    console.log(`  ${name}${userInfo}`);
    console.log(`    Config: ${configDir}`);
    console.log(`    Status: ${status}`);
    console.log('');
  }
}

async function cmdStatus(args = []) {
  const jsonMode = args.includes('--json');
  const accounts = getAccounts();

  if (accounts.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ accounts: [], sessions: [] }));
    } else {
      console.log('No accounts registered.');
    }
    return;
  }

  if (!jsonMode) console.log('Checking usage for all accounts...\n');

  // Read credentials for all accounts
  const accountsWithTokens = accounts.map(a => {
    const creds = readCredentials(a.configDir);
    return { ...a, token: creds.token };
  });

  const authenticated = accountsWithTokens.filter(a => a.token);
  const unauthenticated = accountsWithTokens.filter(a => !a.token);

  let withUsage = [];
  let profileMap = {};

  if (authenticated.length > 0) {
    // Fetch usage and profiles in parallel
    let profiles;
    [withUsage, profiles] = await Promise.all([
      checkAllUsage(authenticated),
      Promise.all(authenticated.map(a => fetchProfile(a.token))),
    ]);

    // Silent refresh: retry accounts with auth errors (401 expired, 403 revoked)
    const rejected = withUsage.filter(a =>
      a.usage?.error === 'HTTP 401' || a.usage?.error === 'HTTP 403'
    );
    if (rejected.length > 0) {
      for (const account of rejected) {
        if (await silentRefresh(account)) {
          const creds = readCredentials(account.configDir);
          if (creds.token) {
            account.token = creds.token;
            account.usage = await checkUsage(creds.token);
            const profile = await fetchProfile(creds.token);
            const idx = authenticated.findIndex(a => a.name === account.name);
            if (idx !== -1) profiles[idx] = profile;
          }
        }
      }
    }

    profileMap = Object.fromEntries(authenticated.map((a, i) => [a.name, profiles[i]]));
  }

  // Read active sessions from channel-map.json
  const channelMapPath = join(CONFIG_DIR, 'data', 'channel-map.json');
  let sessions = [];
  try {
    if (existsSync(channelMapPath)) {
      const raw = readFileSync(channelMapPath, 'utf8');
      const map = JSON.parse(raw || '{}');
      sessions = Object.entries(map)
        .filter(([, entry]) => entry.active)
        .map(([sessionId, entry]) => ({
          sessionId,
          channelName: entry.channelName || null,
          tmuxSession: entry.tmuxSession || null,
          cwd: entry.cwd || null,
          sleeping: !!entry.sleeping,
          paused: !!entry.paused,
          createdAt: entry.createdAt || null,
        }));
    }
  } catch { /* ignore read errors */ }

  // JSON output mode
  if (jsonMode) {
    const now = Date.now();
    const jsonAccounts = withUsage.map(a => ({
      name: a.name,
      profile: profileMap[a.name] || null,
      usage: a.usage,
      score: a.usage?.error ? null : Number(effectiveScore(a.usage, now).toFixed(1)),
    }));
    for (const a of unauthenticated) {
      jsonAccounts.push({ name: a.name, profile: null, usage: null, score: null, error: 'not authenticated' });
    }
    console.log(JSON.stringify({ accounts: jsonAccounts, sessions }, null, 2));
    return;
  }

  // Human-readable output
  const best = pickBestAccount(withUsage);
  const bestName = best?.account?.name;
  const now = Date.now();

  if (withUsage.length > 0 || unauthenticated.length > 0) {
    console.log('Accounts:');

    for (const account of withUsage) {
      const isBest = account.name === bestName;
      const marker = isBest ? '  \u25C4 best' : '';
      const bullet = isBest ? '\u25CF' : '\u25CB';
      const userInfo = formatUserInfo(profileMap[account.name] || {});

      console.log(`  ${bullet} ${account.name}${userInfo}${marker}`);

      if (account.usage.error) {
        console.log(`    error: ${account.usage.error}`);
      } else {
        const sessionScore = (account.usage.sessionPercent * (account.usage.sessionResetsAt
          ? Math.min((new Date(account.usage.sessionResetsAt).getTime() - now) / (5 * 60 * 60 * 1000), 1)
          : 1)).toFixed(0);
        const weeklyScore = (account.usage.weeklyPercent * (account.usage.weeklyResetsAt
          ? Math.min((new Date(account.usage.weeklyResetsAt).getTime() - now) / (7 * 24 * 60 * 60 * 1000), 1)
          : 1)).toFixed(0);
        const totalScore = effectiveScore(account.usage, now).toFixed(1);

        const sessionBar = makeBar(account.usage.sessionPercent, 12);
        const weeklyBar = makeBar(account.usage.weeklyPercent, 12);
        const sessionReset = account.usage.sessionResetsAt ? `  resets ${formatResetTime(account.usage.sessionResetsAt)}` : '';
        const weeklyReset = account.usage.weeklyResetsAt ? `  resets ${formatResetTime(account.usage.weeklyResetsAt)}` : '';

        console.log(`    5-hour:  ${sessionBar} ${String(account.usage.sessionPercent).padStart(3)}%${sessionReset}  (score: ${sessionScore})`);
        console.log(`    7-day:   ${weeklyBar} ${String(account.usage.weeklyPercent).padStart(3)}%${weeklyReset}  (score: ${weeklyScore})`);
        console.log(`    effective score: ${totalScore}`);
      }
      console.log('');
    }

    for (const account of unauthenticated) {
      console.log(`  \u25CB ${account.name} (not authenticated)`);
      console.log('');
    }
  }

  // Show active sessions
  if (sessions.length > 0) {
    console.log('Sessions:');
    for (const s of sessions) {
      const status = s.sleeping ? 'sleeping' : s.paused ? 'paused' : 'running';
      const channel = s.channelName ? `#${s.channelName}` : '';
      const project = s.cwd ? s.cwd.split('/').pop() : '';
      console.log(`  ${project.padEnd(16)} ${channel.padEnd(30)} ${status}`);
    }
    console.log('');
  }
}

async function cmdChannels(args = []) {
  const cleanup = args.includes('--cleanup');
  const channelMapPath = join(CONFIG_DIR, 'data', 'channel-map.json');

  if (!existsSync(channelMapPath)) {
    console.log('No channel mappings found.');
    return;
  }

  let map;
  try {
    const raw = readFileSync(channelMapPath, 'utf8');
    map = JSON.parse(raw || '{}');
  } catch {
    console.log('Could not read channel-map.json.');
    return;
  }

  const entries = Object.entries(map);
  if (entries.length === 0) {
    console.log('No channel mappings found.');
    return;
  }

  if (!cleanup) {
    // List all channels with status
    console.log('Mapped channels:\n');
    for (const [, entry] of entries) {
      const status = entry.active ? '\x1b[32mactive\x1b[0m' :
        entry.archivedAt ? '\x1b[90marchived\x1b[0m' : '\x1b[33minactive\x1b[0m';
      const channel = entry.channelName ? `#${entry.channelName}` : entry.channelId || 'unknown';
      const project = entry.cwd ? entry.cwd.split('/').pop() : '';
      const age = entry.createdAt ? formatResetTime(entry.createdAt).replace('in ', '') + ' ago' : '';
      console.log(`  ${channel.padEnd(35)} ${status.padEnd(20)} ${project.padEnd(20)} ${age}`);
    }
    console.log(`\n  Total: ${entries.length} (${entries.filter(([, e]) => e.active).length} active)`);
    return;
  }

  // Cleanup mode: archive stale channels and purge entries
  console.log('Cleaning up stale channels...\n');

  // Use createRequire to import the CJS channel-manager
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  // Check for Slack tokens
  const envPath = join(CONFIG_DIR, '.env');
  if (!existsSync(envPath)) {
    console.log('No .env file found. Run "claude-nonstop setup" first.');
    return;
  }

  // Load env and create channel manager
  require('../remote/load-env.cjs');
  const SlackChannelManager = require('../remote/channel-manager.cjs');
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.log('SLACK_BOT_TOKEN not found in .env. Run "claude-nonstop setup" first.');
    return;
  }

  const manager = new SlackChannelManager({ botToken });
  const result = await manager.cleanupStaleChannels();
  console.log(`  Archived: ${result.archived} Slack channels`);
  console.log(`  Purged:   ${result.purged} map entries`);
}

async function cmdRun(claudeArgs) {
  // Remote access is on by default; --no-remote-access disables it
  const noRemoteIdx = claudeArgs.indexOf('--no-remote-access');
  let remoteAccess = noRemoteIdx === -1;
  if (noRemoteIdx !== -1) {
    claudeArgs.splice(noRemoteIdx, 1);
  }
  // Also accept legacy --remote-access flag (no-op, already default)
  const legacyIdx = claudeArgs.indexOf('--remote-access');
  if (legacyIdx !== -1) {
    claudeArgs.splice(legacyIdx, 1);
  }

  // Extract --dangerously-skip-permissions (consume it, re-add to claude args later)
  const skipPermsIdx = claudeArgs.indexOf('--dangerously-skip-permissions');
  const skipPermissions = skipPermsIdx !== -1;
  if (skipPermsIdx !== -1) {
    claudeArgs.splice(skipPermsIdx, 1);
  }

  // Extract --account / -a flag (consume it, don't pass to claude)
  const requestedAccount = extractAccountFlag(claudeArgs);

  // Handle tmux bootstrapping for remote access
  if (remoteAccess) {
    const { isInsideTmux, generateSessionName, reexecInTmux } = await import('../lib/tmux.js');

    if (!isInsideTmux()) {
      const sessionName = generateSessionName();
      console.error(`[claude-nonstop] Creating tmux session "${sessionName}"...`);
      reexecInTmux(sessionName, process.argv);
      return;
    }

    // Append formatting instruction for Slack readability
    if (!claudeArgs.includes('--append-system-prompt')) {
      claudeArgs.push(
        '--append-system-prompt',
        'Your responses are relayed to a Slack channel. Structure output for readability: use short paragraphs, bullet points, and bold headers (## Header). Separate sections with blank lines. Keep summaries concise — prefer a few clear bullets over long prose.'
      );
    }
  }

  // Add --dangerously-skip-permissions to claude args if requested
  if (skipPermissions && !claudeArgs.includes('--dangerously-skip-permissions')) {
    claudeArgs.push('--dangerously-skip-permissions');
  }

  const accounts = getAccounts();
  if (accounts.length === 0) {
    console.error('No accounts registered. Run "claude-nonstop add <name>" first.');
    process.exit(1);
  }

  const { getAuthenticatedAccounts, selectAccount } = await import('../lib/launch.js');
  const authenticated = await getAuthenticatedAccounts(accounts, { remoteAccess });
  if (authenticated.length === 0) {
    console.error('No authenticated accounts. Run "claude-nonstop add <name>" to add and authenticate an account.');
    process.exit(1);
  }

  const selectedAccount = await selectAccount(authenticated, accounts, { requestedAccount, remoteAccess });
  await run(claudeArgs, selectedAccount, accounts, { remoteAccess });
}

async function cmdResume(resumeArgs) {
  // Remote access is on by default; --no-remote-access disables it
  const noRemoteIdx = resumeArgs.indexOf('--no-remote-access');
  let remoteAccess = noRemoteIdx === -1;
  if (noRemoteIdx !== -1) {
    resumeArgs.splice(noRemoteIdx, 1);
  }
  // Also accept legacy --remote-access flag (no-op, already default)
  const legacyIdx = resumeArgs.indexOf('--remote-access');
  if (legacyIdx !== -1) {
    resumeArgs.splice(legacyIdx, 1);
  }

  // Extract --dangerously-skip-permissions
  const skipPermsIdx = resumeArgs.indexOf('--dangerously-skip-permissions');
  const skipPermissions = skipPermsIdx !== -1;
  if (skipPermsIdx !== -1) {
    resumeArgs.splice(skipPermsIdx, 1);
  }

  // Extract --account / -a flag (consume it, don't pass to claude)
  const requestedAccount = extractAccountFlag(resumeArgs);

  // Handle tmux bootstrapping for remote access
  if (remoteAccess) {
    const { isInsideTmux, generateSessionName, reexecInTmux } = await import('../lib/tmux.js');

    if (!isInsideTmux()) {
      const sessionName = generateSessionName();
      console.error(`[claude-nonstop] Creating tmux session "${sessionName}"...`);
      reexecInTmux(sessionName, process.argv);
      return;
    }
  }

  const accounts = getAccounts();
  if (accounts.length === 0) {
    console.error('No accounts registered. Run "claude-nonstop add <name>" first.');
    process.exit(1);
  }

  // Find session across all profiles
  const { findSessionAcrossProfiles, findLatestSessionAcrossProfiles, migrateSessionByHash } = await import('../lib/session.js');

  const sessionIdArg = resumeArgs.find(a => !a.startsWith('-'));
  let found;

  if (sessionIdArg) {
    console.error(`[claude-nonstop] Searching for session ${sessionIdArg}...`);
    found = findSessionAcrossProfiles(accounts, sessionIdArg);
    if (!found) {
      console.error(`Error: Session "${sessionIdArg}" not found in any account.`);
      process.exit(1);
    }
  } else {
    console.error('[claude-nonstop] Searching for most recent session...');
    found = findLatestSessionAcrossProfiles(accounts);
    if (!found) {
      console.error('Error: No sessions found in any account.');
      process.exit(1);
    }
  }

  const sessionId = sessionIdArg || found.sessionId;
  console.error(`[claude-nonstop] Found session ${sessionId} in account "${found.account.name}"`);

  // Build claude args — approval prompts preserved for Slack interaction
  const claudeArgs = ['--resume', sessionId];
  if (skipPermissions) {
    claudeArgs.push('--dangerously-skip-permissions');
  }

  const { getAuthenticatedAccounts, selectAccount } = await import('../lib/launch.js');
  const authenticated = await getAuthenticatedAccounts(accounts, { remoteAccess });
  if (authenticated.length === 0) {
    console.error('No authenticated accounts. Run "claude-nonstop add <name>" to add and authenticate an account.');
    process.exit(1);
  }

  let selectedAccount = await selectAccount(authenticated, accounts, { requestedAccount, remoteAccess });

  // Migrate session to selected account if it lives in a different profile
  if (found.account.configDir !== selectedAccount.configDir) {
    console.error(`[claude-nonstop] Migrating session from "${found.account.name}" to "${selectedAccount.name}"...`);
    const result = migrateSessionByHash(found.account.configDir, selectedAccount.configDir, found.cwdHash, sessionId);
    if (!result.success) {
      console.error(`[claude-nonstop] Migration failed: ${result.error}`);
      console.error(`[claude-nonstop] Falling back to source account "${found.account.name}"`);
      selectedAccount = found.account;
    }
  }

  await run(claudeArgs, selectedAccount, accounts, { remoteAccess });
}

// ─── Setup & Hooks Commands ─────────────────────────────────────────────────

async function cmdSetup(setupArgs = []) {
  console.log('claude-nonstop Slack Remote Access Setup\n');

  const { flags, fromEnv } = parseSetupFlags(setupArgs);

  let botToken, appToken, channelId, allowedUsers, inviteUserId, channelPrefix, defaultTmux, geminiKey;

  if (fromEnv || (flags.botToken && flags.appToken)) {
    // Non-interactive mode: read from env vars and/or CLI flags
    if (fromEnv) {
      botToken = flags.botToken || process.env.SLACK_BOT_TOKEN || '';
      appToken = flags.appToken || process.env.SLACK_APP_TOKEN || '';
      channelId = flags.channelId || process.env.SLACK_CHANNEL_ID || '';
      allowedUsers = flags.allowedUsers || process.env.SLACK_ALLOWED_USERS || '';
      inviteUserId = flags.inviteUserId || process.env.SLACK_INVITE_USER_ID || '';
      channelPrefix = flags.channelPrefix ?? process.env.SLACK_CHANNEL_PREFIX ?? '';
      defaultTmux = flags.defaultTmuxSession || process.env.DEFAULT_TMUX_SESSION || '';
      geminiKey = flags.geminiKey || process.env.GEMINI_API_KEY || '';
      console.log('Reading configuration from environment variables...');
    } else {
      botToken = flags.botToken;
      appToken = flags.appToken;
      channelId = flags.channelId || '';
      allowedUsers = flags.allowedUsers || '';
      inviteUserId = flags.inviteUserId || '';
      channelPrefix = flags.channelPrefix ?? '';
      defaultTmux = flags.defaultTmuxSession || '';
      geminiKey = flags.geminiKey || '';
      console.log('Using tokens from CLI flags...');
    }
  } else {
    // Interactive mode (default)
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q, defaultVal = '') => new Promise((resolve) => {
      const prompt = defaultVal ? `${q} [${defaultVal}]: ` : `${q}: `;
      rl.question(prompt, (answer) => resolve(answer.trim() || defaultVal));
    });

    console.log('Enter your Slack app tokens.');
    console.log('Bot Token: Slack app > OAuth & Permissions (starts with xoxb-)');
    console.log('App Token: Slack app > Basic Information > App-Level Tokens (starts with xapp-)\n');

    botToken = await ask('SLACK_BOT_TOKEN (xoxb-...)');
    appToken = await ask('SLACK_APP_TOKEN (xapp-...)');
    channelId = await ask('SLACK_CHANNEL_ID (optional, for single-channel mode)', '');
    allowedUsers = await ask('SLACK_ALLOWED_USERS (comma-separated user IDs, empty = all)', '');
    inviteUserId = await ask('SLACK_INVITE_USER_ID (auto-invite to session channels)', '');
    channelPrefix = await ask('SLACK_CHANNEL_PREFIX (empty = no prefix)', '');
    defaultTmux = await ask('DEFAULT_TMUX_SESSION (for single-channel/DM mode, optional)', '');

    console.log('\nOptional: Gemini API key for AI-powered channel naming.');
    console.log('Get one free at https://aistudio.google.com/apikey');
    geminiKey = await ask('GEMINI_API_KEY (optional, press Enter to skip)', '');

    rl.close();
  }

  // Validate required tokens
  if (!botToken || !botToken.startsWith('xoxb-')) {
    console.error('Invalid bot token. Must start with xoxb-');
    process.exit(1);
  }

  if (!appToken || !appToken.startsWith('xapp-')) {
    console.error('Invalid app token. Must start with xapp-');
    process.exit(1);
  }

  // Validate Gemini API key if provided
  if (geminiKey) {
    console.log('\nValidating Gemini API key...');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Say "ok"' }] }] }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        console.log('  Gemini API key is valid.');
      } else {
        console.warn(`  Warning: Gemini API returned ${res.status}. Key may be invalid.`);
        console.warn('  Channel naming will fall back to text-based slugs.');
      }
    } catch {
      console.warn('  Warning: Could not validate Gemini API key (network error).');
      console.warn('  Channel naming will fall back to text-based slugs.');
    }
  }

  // Write .env
  const envContent = `# claude-nonstop Slack Configuration
SLACK_BOT_TOKEN=${botToken}
SLACK_APP_TOKEN=${appToken}
SLACK_CHANNEL_ID=${channelId}
SLACK_ALLOWED_USERS=${allowedUsers}
SLACK_INVITE_USER_ID=${inviteUserId}
SLACK_CHANNEL_PREFIX=${channelPrefix}
DEFAULT_TMUX_SESSION=${defaultTmux}
GEMINI_API_KEY=${geminiKey || ''}
`;

  const envDir = CONFIG_DIR;
  if (!existsSync(envDir)) mkdirSync(envDir, { recursive: true });
  const envPath = join(envDir, '.env');
  // Atomic write with restrictive permissions (contains Slack tokens)
  const envTmp = join(envDir, `.env.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(envTmp, envContent, { mode: 0o600 });
  renameSync(envTmp, envPath);
  console.log(`\nWrote ${envPath}`);

  // Install hooks
  console.log('\nInstalling Claude Code hooks into all profiles...\n');
  installHooksToAllProfiles();

  // Auto-install launchd service on macOS
  if (isMacOS()) {
    console.log('\nInstalling webhook as launchd service...');
    try {
      installService();
      console.log('  Webhook service installed and started.');
      console.log(`  Logs: ${LOG_PATH}`);
    } catch (err) {
      console.warn(`  Warning: Could not install service: ${err.message}`);
      console.warn('  You can install it manually with: claude-nonstop webhook install');
    }
  }

  console.log('\nSetup complete! Next steps:');
  if (isMacOS()) {
    console.log('  1. Check webhook status: claude-nonstop webhook status');
    console.log('  2. Run:                  claude-nonstop');
  } else {
    console.log('  1. Start the webhook:    claude-nonstop webhook');
    console.log('     (or set up a systemd service for auto-restart)');
    console.log('  2. Run:                  claude-nonstop');
  }
}

async function cmdWebhook(subArgs = []) {
  const subcommand = subArgs[0];

  switch (subcommand) {
    case 'install':
      cmdWebhookInstall();
      break;

    case 'uninstall':
      cmdWebhookUninstall();
      break;

    case 'restart':
      cmdWebhookRestart();
      break;

    case 'status':
      cmdWebhookStatus();
      break;

    case 'logs':
      cmdWebhookLogs();
      break;

    case undefined:
      // No subcommand — show usage
      console.log('Usage:');
      console.log('  claude-nonstop webhook              Run webhook in foreground');
      console.log('  claude-nonstop webhook install      Install as launchd service (macOS)');
      console.log('  claude-nonstop webhook uninstall    Remove launchd service');
      console.log('  claude-nonstop webhook restart      Restart the service');
      console.log('  claude-nonstop webhook status       Show service status');
      console.log('  claude-nonstop webhook logs         Tail the webhook log');
      console.log('');
      console.log('To run in foreground (for debugging): claude-nonstop webhook start');
      break;

    case 'start':
      // Explicit foreground mode
      cmdWebhookForeground();
      break;

    default:
      console.error(`Unknown webhook subcommand: ${subcommand}`);
      console.error('Run "claude-nonstop help" for usage information.');
      process.exit(1);
  }
}

function cmdWebhookForeground() {
  const webhookPath = join(PROJECT_ROOT, 'remote', 'start-webhook.cjs');
  const child = spawn('node', [webhookPath], { stdio: 'inherit' });

  child.on('error', (err) => {
    console.error(`Failed to start webhook: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code || 0);
  });

  // Forward signals
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

function cmdWebhookInstall() {
  if (!isMacOS()) {
    console.error('Service management is only supported on macOS (launchd).');
    console.error('On Linux, use systemd or run "claude-nonstop webhook" in a screen/tmux session.');
    process.exit(1);
  }

  try {
    installService();
    console.log('Webhook service installed and started.');
    console.log(`  Service: claude-nonstop-slack`);
    console.log(`  Logs:    ${LOG_PATH}`);
    console.log('');
    console.log('The webhook will start automatically on login and restart on failure.');
    console.log('Use "claude-nonstop webhook status" to check status.');
  } catch (err) {
    console.error(`Failed to install service: ${err.message}`);
    process.exit(1);
  }
}

function cmdWebhookUninstall() {
  if (!isMacOS()) {
    console.error('Service management is only supported on macOS (launchd).');
    process.exit(1);
  }

  try {
    uninstallService();
    console.log('Webhook service stopped and removed.');
  } catch (err) {
    console.error(`Failed to uninstall service: ${err.message}`);
    process.exit(1);
  }
}

function cmdWebhookRestart() {
  if (!isMacOS()) {
    console.error('Service management is only supported on macOS (launchd).');
    process.exit(1);
  }

  if (!isServiceInstalled()) {
    console.error('Webhook service is not installed. Run "claude-nonstop webhook install" first.');
    process.exit(1);
  }

  try {
    restartService();
    console.log('Webhook service restarted.');
  } catch (err) {
    console.error(`Failed to restart service: ${err.message}`);
    process.exit(1);
  }
}

function cmdWebhookStatus() {
  if (!isMacOS()) {
    console.log('Service management is only supported on macOS (launchd).');
    console.log('Check webhook manually: ps aux | grep start-webhook');
    return;
  }

  const status = getServiceStatus();

  if (!status.installed) {
    console.log('Webhook service: not installed');
    console.log('Run "claude-nonstop webhook install" to install.');
    return;
  }

  console.log(`Webhook service: installed`);
  console.log(`  Status:  ${status.running ? 'running' : 'stopped'}`);
  if (status.pid) {
    console.log(`  PID:     ${status.pid}`);
  }
  console.log(`  Logs:    ${LOG_PATH}`);
}

function cmdWebhookLogs() {
  if (!existsSync(LOG_PATH)) {
    console.error(`No log file found at ${LOG_PATH}`);
    console.error('The webhook service may not have been started yet.');
    process.exit(1);
  }

  const child = spawn('tail', ['-f', LOG_PATH], { stdio: 'inherit' });

  child.on('error', (err) => {
    console.error(`Failed to tail logs: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code || 0);
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

async function cmdHooks(args) {
  const subcommand = args[0];

  if (subcommand === 'install') {
    installHooksToAllProfiles();
  } else if (subcommand === 'status') {
    showHooksStatus();
  } else {
    console.log('Usage:');
    console.log('  claude-nonstop hooks install   Install hooks into all profile settings');
    console.log('  claude-nonstop hooks status    Show hook status for all profiles');
  }
}

function getHookCommand(hookType) {
  const hookScript = join(PROJECT_ROOT, 'remote', 'hook-notify.cjs');
  const typeArg = {
    'Stop': 'completed',
    'SessionStart': 'session-start',
    'PostToolUse': 'tool-use',
    'PreToolUse': 'waiting-for-input',
    'UserPromptSubmit': 'user-prompt',
  }[hookType];
  return `node "${hookScript}" ${typeArg}`;
}

function installHooksToAllProfiles() {
  const accounts = getAccounts();
  const hookScript = join(PROJECT_ROOT, 'remote', 'hook-notify.cjs');

  if (!existsSync(hookScript)) {
    console.error(`Hook script not found: ${hookScript}`);
    process.exit(1);
  }

  const hookTypes = ['Stop', 'SessionStart', 'PostToolUse', 'PreToolUse', 'UserPromptSubmit'];

  for (const account of accounts) {
    const settingsPath = join(account.configDir, 'settings.json');
    let settings = {};

    if (existsSync(settingsPath)) {
      try {
        let raw = readFileSync(settingsPath, 'utf8');
        // Strip ANSI escape codes if present (corrupted by terminal color output)
        raw = raw.replace(/\x1b\[[0-9;]*m/g, '');
        settings = JSON.parse(raw);
      } catch {
        console.warn(`  Warning: Could not parse ${settingsPath}, preserving skipDangerousModePermissionPrompt`);
        settings = { skipDangerousModePermissionPrompt: true };
      }
    }

    if (!settings.hooks) settings.hooks = {};

    for (const hookType of hookTypes) {
      const command = getHookCommand(hookType);
      const hookEntry = {
        type: 'command',
        command,
      };
      // SessionStart needs a timeout since it makes API calls
      if (hookType === 'SessionStart') {
        hookEntry.timeout = 10;
      }
      // PostToolUse runs async so it doesn't block Claude's agentic loop
      if (hookType === 'PostToolUse') {
        hookEntry.timeout = 15;
      }
      // PreToolUse for waiting-for-input needs a timeout for Slack API calls
      if (hookType === 'PreToolUse') {
        hookEntry.timeout = 15;
      }
      // UserPromptSubmit posts user's terminal input to Slack
      if (hookType === 'UserPromptSubmit') {
        hookEntry.timeout = 10;
      }

      const matcher = { matcher: '', hooks: [hookEntry] };
      // PreToolUse only fires for tools that pause Claude for user input
      if (hookType === 'PreToolUse') {
        matcher.matcher = 'ExitPlanMode|AskUserQuestion';
      }
      // PostToolUse, PreToolUse, and UserPromptSubmit must not block Claude Code
      if (hookType === 'PostToolUse' || hookType === 'PreToolUse' || hookType === 'UserPromptSubmit') {
        matcher.async = true;
      }

      // Remove old Claude-Code-Remote hooks and any previous version of our hook
      if (settings.hooks[hookType]) {
        settings.hooks[hookType] = settings.hooks[hookType].filter(m => {
          if (!m.hooks) return true;
          // Remove matchers whose only hook is an old claude-hook-notify or hook-notify
          const isOldHook = m.hooks.every(h =>
            h.command?.includes('claude-hook-notify.js') ||
            h.command?.includes('hook-notify.cjs')
          );
          return !isOldHook;
        });
      }

      // Add our hook
      if (!settings.hooks[hookType]) {
        settings.hooks[hookType] = [];
      }
      settings.hooks[hookType].push(matcher);
    }

    // Ensure the settings directory exists
    const settingsDir = dirname(settingsPath);
    if (!existsSync(settingsDir)) {
      mkdirSync(settingsDir, { recursive: true });
    }

    const tmpSettings = join(settingsDir, `.settings.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmpSettings, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmpSettings, settingsPath);
    console.log(`  Installed hooks: ${account.name} (${settingsPath})`);
  }

  console.log(`\nHooks installed for ${accounts.length} profile(s).`);
}

function showHooksStatus() {
  const accounts = getAccounts();
  const hookTypes = ['Stop', 'SessionStart', 'PostToolUse', 'PreToolUse', 'UserPromptSubmit'];

  for (const account of accounts) {
    console.log(`\n  ${account.name} (${account.configDir})`);
    const settingsPath = join(account.configDir, 'settings.json');

    if (!existsSync(settingsPath)) {
      console.log('    No settings.json found');
      continue;
    }

    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));

      for (const hookType of hookTypes) {
        const hooks = settings.hooks?.[hookType];
        if (!hooks) {
          console.log(`    ${hookType}: not configured`);
          continue;
        }

        const hasOurHook = hooks.some(m =>
          m.hooks?.some(h => h.command?.includes('hook-notify.cjs'))
        );
        console.log(`    ${hookType}: ${hasOurHook ? 'installed' : 'missing (other hooks present)'}`);
      }
    } catch {
      console.log('    Error reading settings.json');
    }
  }
  console.log('');
}

// ─── Uninstall ──────────────────────────────────────────────────────────────────

async function cmdUninstall(uninstallArgs = []) {
  const force = uninstallArgs.includes('--force');

  if (!force) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question('This will remove claude-nonstop completely. Continue? [y/N] ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  // 1. Stop and remove launchd service
  if (isMacOS() && isServiceInstalled()) {
    console.log('Stopping webhook service...');
    try {
      uninstallService();
      console.log('  Webhook service removed.');
    } catch (err) {
      console.warn(`  Warning: ${err.message}`);
    }
  }

  // 2. Remove our hooks from all profiles' settings.json
  console.log('Removing hooks from settings...');
  removeHooksFromAllProfiles();

  // 3. Remove keychain credentials for non-default accounts
  const accounts = getAccounts();
  const keychainAccounts = accounts.filter(a => a.configDir !== DEFAULT_CLAUDE_DIR);
  if (keychainAccounts.length > 0) {
    console.log('Removing keychain credentials...');
    for (const account of keychainAccounts) {
      const result = deleteKeychainEntry(account.configDir);
      if (result.deleted) {
        console.log(`  ${account.name}: removed`);
      } else if (result.error) {
        console.warn(`  ${account.name}: warning: ${result.error}`);
      } else {
        console.log(`  ${account.name}: not found (already clean)`);
      }
    }
  }

  // 4. Remove ~/.claude-nonstop/ directory
  if (existsSync(CONFIG_DIR)) {
    console.log(`Removing ${CONFIG_DIR}...`);
    rmSync(CONFIG_DIR, { recursive: true, force: true });
    console.log('  Config directory removed.');
  }

  // 5. npm unlink
  console.log('Unlinking CLI...');
  try {
    const child = spawn('npm', ['unlink', '--global', 'claude-nonstop'], { stdio: 'pipe' });
    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    if (exitCode === 0) {
      console.log('  CLI unlinked.');
    } else {
      console.warn('  Warning: npm unlink exited with code', exitCode);
      console.warn('  You may need to run "npm unlink -g claude-nonstop" manually.');
    }
  } catch {
    console.warn('  Warning: npm unlink failed. You may need to run "npm unlink -g claude-nonstop" manually.');
  }

  console.log('\nclaude-nonstop has been uninstalled.');
}

function removeHooksFromAllProfiles() {
  // Remove hooks from all known profile settings AND the default ~/.claude
  const accounts = getAccounts();

  // Collect all settings.json paths (profiles + default)
  const settingsPaths = accounts.map(a => join(a.configDir, 'settings.json'));

  // Also check default ~/.claude/settings.json if not already in accounts
  const defaultSettings = join(DEFAULT_CLAUDE_DIR, 'settings.json');
  if (!settingsPaths.includes(defaultSettings)) {
    settingsPaths.push(defaultSettings);
  }

  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) continue;

    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks) continue;

      let modified = false;
      for (const hookType of ['Stop', 'SessionStart', 'PostToolUse', 'PreToolUse', 'UserPromptSubmit']) {
        if (!settings.hooks[hookType]) continue;

        const filtered = settings.hooks[hookType].filter(m => {
          if (!m.hooks) return true;
          const isOurHook = m.hooks.every(h =>
            h.command?.includes('hook-notify.cjs')
          );
          return !isOurHook;
        });

        if (filtered.length !== settings.hooks[hookType].length) {
          settings.hooks[hookType] = filtered;
          modified = true;
        }

        // Remove empty hook arrays
        if (settings.hooks[hookType].length === 0) {
          delete settings.hooks[hookType];
        }
      }

      // Remove empty hooks object
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      if (modified) {
        const settingsDir = dirname(settingsPath);
        const tmpSettings = join(settingsDir, `.settings.${process.pid}.${Date.now()}.tmp`);
        writeFileSync(tmpSettings, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
        renameSync(tmpSettings, settingsPath);
        console.log(`  Removed hooks: ${settingsPath}`);
      }
    } catch {
      // Skip files we can't parse
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseSetupFlags(args) {
  const flags = {};
  let fromEnv = false;

  const flagMap = {
    '--bot-token': 'botToken',
    '--app-token': 'appToken',
    '--channel-id': 'channelId',
    '--allowed-users': 'allowedUsers',
    '--invite-user-id': 'inviteUserId',
    '--channel-prefix': 'channelPrefix',
    '--default-tmux-session': 'defaultTmuxSession',
    '--gemini-key': 'geminiKey',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--from-env') {
      fromEnv = true;
      continue;
    }

    // Handle --flag=value
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      const key = arg.substring(0, eqIdx);
      const value = arg.substring(eqIdx + 1);
      if (flagMap[key]) {
        flags[flagMap[key]] = value;
        continue;
      }
    }

    // Handle --flag value
    if (flagMap[arg] && i + 1 < args.length) {
      flags[flagMap[arg]] = args[i + 1];
      i++;
      continue;
    }
  }

  return { flags, fromEnv };
}

/**
 * Extract --account <name> or -a <name> from args array.
 * Splices the flag and value out of the array in-place.
 * Returns the account name string, or null if not specified.
 */
function extractAccountFlag(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account' || args[i] === '-a') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        console.error(`Error: ${args[i]} requires an account name.`);
        process.exit(1);
      }
      const name = args[i + 1];
      args.splice(i, 2);
      return name;
    }
  }
  return null;
}

function printHelp() {
  console.log(`
claude-nonstop — Multi-account switching + Slack remote access for Claude Code

Usage:
  claude-nonstop [args...]     Run Claude with best account + auto-switching

Commands:
  resume [id]          Resume a session from any account (finds + migrates)
  add <name>           Register a new Claude account and launch login
  remove <name>        Remove a registered account
  reauth               Re-authenticate accounts with expired tokens
  list                 List all accounts with auth status
  status [--json]      Show detailed usage, scores, and sessions
  channels             List all mapped Slack channels with status
  channels --cleanup   Archive stale Slack channels and purge map entries
  setup [flags]        Slack remote access setup (interactive or via flags/env)
  webhook              Show webhook subcommands
  webhook start        Start the Slack webhook in foreground (for debugging)
  webhook install      Install + start webhook as launchd service (macOS)
  webhook uninstall    Stop + remove webhook launchd service
  webhook restart      Restart the webhook service
  webhook status       Show webhook service status (installed/running/PID)
  webhook logs         Tail the webhook log file
  hooks install        Install Claude Code hooks into all profile settings
  hooks status         Show hook installation status
  update               Reinstall from local source (preserves all config)
  uninstall            Remove claude-nonstop completely (service, hooks, config)
  help                 Show this help message

Options:
  --account <name>, -a <name>
                     Use a specific account (skip auto-selection)
  --dangerously-skip-permissions
                     Run Claude without permission prompts (unattended mode)
  --no-remote-access Skip tmux session + Slack channels (local terminal only)

Options for setup:
  --bot-token <tok>  Slack bot token (xoxb-...)
  --app-token <tok>  Slack app token (xapp-...)
  --from-env         Read SLACK_BOT_TOKEN and SLACK_APP_TOKEN from environment
  --channel-id <id>  Slack channel ID for single-channel mode
  --allowed-users <ids>  Comma-separated Slack user IDs
  --invite-user-id <id>  Auto-invite user to session channels
  --channel-prefix <p>   Prefix for channel names (default: cn)

  When --bot-token and --app-token are provided (or --from-env), setup
  runs non-interactively using defaults for omitted optional fields.
  On macOS, setup also installs the webhook as a launchd service.

Options for uninstall:
  --force            Skip confirmation prompt

Examples:
  claude-nonstop                        # Run with best account (tmux + Slack)
  claude-nonstop -a work                # Run with specific account
  claude-nonstop -a work -p "fix bug"   # One-shot with specific account
  claude-nonstop --no-remote-access     # Run without tmux/Slack (local terminal)
  claude-nonstop resume                 # Resume most recent session (any account)
  claude-nonstop resume abc123          # Resume specific session by ID
  claude-nonstop resume -a work         # Resume with specific account
  claude-nonstop -p "fix bug"           # One-shot prompt (args passed to Claude)
  claude-nonstop add work               # Add a second account
  claude-nonstop status                 # Check usage across all accounts
  claude-nonstop setup                  # Configure Slack (interactive)
  claude-nonstop setup --from-env       # Configure Slack from env vars
  claude-nonstop webhook                # Show webhook subcommands
  claude-nonstop webhook install        # Install webhook as background service
  claude-nonstop webhook status         # Check if webhook is running
  claude-nonstop uninstall              # Full cleanup

By default, claude-nonstop runs with remote access:
  1. Creates a tmux session named after the current directory
  2. Each session gets a dedicated Slack channel
  3. Preserves approval prompts (approve/reject via Slack)
  4. Slack webhook relays messages from Slack channels to tmux
  5. Checks usage API, picks best account, auto-switches on rate limit

Use --no-remote-access to skip tmux/Slack and run in local terminal only.

Quick start:
  claude-nonstop add work        # Add account (opens browser for OAuth)
  claude-nonstop setup           # Configure Slack tokens (auto-installs webhook)
  claude-nonstop                 # Run with remote access (default)
`.trim());
}

function formatUserInfo({ name, email }) {
  if (name && email) return ` (${name} — ${email})`;
  if (name) return ` (${name})`;
  if (email) return ` (${email})`;
  return '';
}

function makeBar(percent, width = 20) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

  if (percent >= 95) return `\x1b[31m${bar}\x1b[0m`; // Red
  if (percent >= 70) return `\x1b[33m${bar}\x1b[0m`; // Yellow
  return `\x1b[32m${bar}\x1b[0m`; // Green
}

function formatResetTime(isoString) {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();

    if (diffMs <= 0) return 'now';

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) return `in ${hours}h ${minutes}m`;
    return `in ${minutes}m`;
  } catch {
    return isoString;
  }
}
