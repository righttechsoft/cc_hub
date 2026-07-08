import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_MARKER = 'cc-hub-hook.mjs';
const DEFAULT_PERMISSION_WAIT_MS = 30000;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const uninstall = args.includes('--uninstall');

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = join(projectRoot, 'hooks', HOOK_MARKER);
const hookCommand = `node "${hookPath}"`;

// Keep the hook's own fetch-abort timeout, the installed CC-level kill timeout, and the server's
// config.json hooks.permissionWaitMs derived from one source of truth instead of separate
// hardcoded constants that silently drift apart if permissionWaitMs is edited.
function readPermissionWaitMs() {
  const configPath = join(projectRoot, 'config.json');
  if (!existsSync(configPath)) return DEFAULT_PERMISSION_WAIT_MS;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    const raw = parsed?.hooks?.permissionWaitMs;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PERMISSION_WAIT_MS;
  } catch {
    return DEFAULT_PERMISSION_WAIT_MS;
  }
}

const permissionWaitMs = readPermissionWaitMs();
const permissionHookTimeoutMs = permissionWaitMs + 5000;
const permissionCcTimeoutSec = Math.ceil(permissionWaitMs / 1000) + 15;

// No PostToolUse — turn-level events only (user choice).
const EVENTS = [
  { name: 'SessionStart', timeout: 10, command: hookCommand },
  { name: 'UserPromptSubmit', timeout: 10, command: hookCommand },
  { name: 'Notification', timeout: 10, command: hookCommand },
  { name: 'Stop', timeout: 15, command: hookCommand },
  { name: 'PermissionRequest', timeout: permissionCcTimeoutSec, command: `${hookCommand} ${permissionHookTimeoutMs}` },
  { name: 'SessionEnd', timeout: 10, command: hookCommand },
];

const settingsPath = join(homedir(), '.claude', 'settings.json');

function readSettings() {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function backupSettings() {
  if (!existsSync(settingsPath)) return null;
  const backupPath = `${settingsPath}.cc-hub-backup-${Date.now()}`;
  copyFileSync(settingsPath, backupPath);
  return backupPath;
}

function entryHasCcHub(entry) {
  return Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER));
}

function install(settings) {
  const lines = [];
  let changed = false;

  settings.hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};

  for (const { name, timeout, command } of EVENTS) {
    const list = Array.isArray(settings.hooks[name]) ? settings.hooks[name] : [];
    settings.hooks[name] = list;

    if (list.some(entryHasCcHub)) {
      lines.push(`${name}: already installed, skipped`);
      continue;
    }

    list.push({
      matcher: '',
      hooks: [{ type: 'command', command, timeout }],
    });
    lines.push(`${name}: appended cc-hub hook (timeout ${timeout}s)`);
    changed = true;
  }

  return { lines, changed };
}

function uninstallHooks(settings) {
  const lines = [];
  let changed = false;

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    lines.push('no hooks configured, nothing to uninstall');
    return { lines, changed };
  }

  for (const { name } of EVENTS) {
    const list = settings.hooks[name];
    if (!Array.isArray(list)) continue;

    const before = list.length;
    const filtered = list.filter((entry) => !entryHasCcHub(entry));
    const removed = before - filtered.length;

    if (removed > 0) {
      settings.hooks[name] = filtered;
      lines.push(`${name}: removed ${removed} cc-hub entry(ies)`);
      changed = true;
    } else {
      lines.push(`${name}: no cc-hub entry found`);
    }
  }

  return { lines, changed };
}

function main() {
  const settings = readSettings();
  const { lines, changed } = uninstall ? uninstallHooks(settings) : install(settings);

  console.log(uninstall ? 'cc_hub hook uninstall' : 'cc_hub hook install');
  console.log(`settings file: ${settingsPath}`);
  if (!uninstall) {
    console.log(
      `permissionWaitMs: ${permissionWaitMs} (hook timeout ${permissionHookTimeoutMs}ms, CC-level timeout ${permissionCcTimeoutSec}s)`
    );
  }
  for (const line of lines) console.log(`  - ${line}`);

  if (dryRun) {
    console.log('(dry run — no changes written)');
    return;
  }

  if (!changed) {
    console.log('no changes needed, settings.json left untouched');
    return;
  }

  const backupPath = backupSettings();
  if (backupPath) console.log(`backup written: ${backupPath}`);

  const settingsDir = dirname(settingsPath);
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`settings written: ${settingsPath}`);
}

main();
