// Zero-dependency Claude Code hook client. Reads the hook JSON payload from stdin, forwards it
// to the cc_hub server, and prints back any stdout the server wants injected. Fail-silent by
// contract: if cc_hub is down or anything goes wrong, this script must still exit 0 and print
// nothing, so Claude Code behaves exactly as if no hook were installed.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function debugLog(line) {
  if (process.env.CC_HUB_DEBUG !== '1') return;
  try {
    const dir = join(process.env.LOCALAPPDATA || '', 'cc_hub');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'hook.log'), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // best-effort only
  }
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw);

  const url = process.env.CC_HUB_URL || 'http://127.0.0.1:4270';
  // install-hooks.mjs derives this from config.json's hooks.permissionWaitMs (+5s margin) and
  // passes it as argv[2] on the installed PermissionRequest hook command; CC_HUB_PERMISSION_TIMEOUT_MS
  // and the 35000 fallback only apply if the hook was installed by an older/manual setup.
  const permissionTimeoutMs = process.argv[2] ? Number(process.argv[2]) : Number(process.env.CC_HUB_PERMISSION_TIMEOUT_MS || 35000);
  const timeoutMs =
    payload && payload.hook_event_name === 'PermissionRequest' ? permissionTimeoutMs : 1000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url + '/hooks/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
      signal: controller.signal,
    });

    if (res.ok) {
      const body = await res.json();
      if (body && typeof body.stdout === 'string' && body.stdout.length) {
        process.stdout.write(body.stdout);
      }
      await debugLog(`${(payload && payload.hook_event_name) || 'unknown'} -> ${res.status}`);
    } else {
      await debugLog(`${(payload && payload.hook_event_name) || 'unknown'} -> http ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

try {
  await main();
} catch (err) {
  await debugLog(`error: ${err && err.message ? err.message : String(err)}`);
} finally {
  process.exit(0);
}
