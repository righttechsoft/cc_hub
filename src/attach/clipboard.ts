// Windows-only clipboard reader for cc-attach's "smart paste" (Ctrl+V rebound to byte 0x16 —
// see cli.ts). Shells out to Windows PowerShell (NOT pwsh — 5.1 runs its main thread STA, which
// System.Windows.Forms.Clipboard requires) to read whatever's on the clipboard: an image gets
// saved to a temp PNG, a file-drop returns the first file's path, plain text returns as-is.
// Fail-soft everywhere — any error, timeout, or non-Windows platform returns null; callers must
// never crash the wrapper or block the pty on a clipboard read.
import { spawn } from 'node:child_process';

const TIMEOUT_MS = 8000;

// kind\0value — NUL-separated so multi-line text survives verbatim (a newline-based separator
// would break on it). $ErrorActionPreference='Stop' + try/catch means any failure just prints
// nothing, which parseClipboardOutput treats as "no clipboard content".
const CLIPBOARD_SCRIPT = `
$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
  $cb=[System.Windows.Forms.Clipboard]
  if ($cb::ContainsImage()) {
    $img=$cb::GetImage()
    $p=Join-Path $env:TEMP ('ccpaste_'+[Guid]::NewGuid().ToString('N')+'.png')
    $img.Save($p,[System.Drawing.Imaging.ImageFormat]::Png)
    [Console]::Out.Write('image'); [Console]::Out.Write([char]0); [Console]::Out.Write($p)
  } elseif ($cb::ContainsFileDropList()) {
    $f=$cb::GetFileDropList()[0]
    if ($f) { [Console]::Out.Write('file'); [Console]::Out.Write([char]0); [Console]::Out.Write($f) }
  } elseif ($cb::ContainsText()) {
    [Console]::Out.Write('text'); [Console]::Out.Write([char]0); [Console]::Out.Write($cb::GetText())
  }
} catch {}
`;

export interface ClipboardPaste {
  kind: 'image' | 'file' | 'text';
  value: string;
}

// Pure parse of the PS script's stdout — split into its own function so it's testable on any
// platform (the spawn path only runs on win32). Splits on the FIRST NUL only, since text values
// may legitimately be long and arbitrary (though not contain a real NUL byte in practice).
export function parseClipboardOutput(raw: string): ClipboardPaste | null {
  const sep = raw.indexOf('\0');
  if (sep === -1) return null;
  const kind = raw.slice(0, sep);
  let value = raw.slice(sep + 1);
  if (kind !== 'image' && kind !== 'file' && kind !== 'text') return null;
  if (kind !== 'text') {
    // Paths are single-line — PowerShell's console output may append a trailing CRLF.
    value = value.replace(/[\r\n]+$/, '');
  }
  if (value === '') return null;
  return { kind, value };
}

export async function readClipboardForPaste(): Promise<ClipboardPaste | null> {
  if (process.platform !== 'win32') return null;

  return new Promise<ClipboardPaste | null>((resolve) => {
    let settled = false;
    const done = (result: ClipboardPaste | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', CLIPBOARD_SCRIPT], {
        windowsHide: true,
      });
    } catch {
      done(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore — best-effort cleanup
      }
      done(null);
    }, TIMEOUT_MS);

    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });

    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });

    child.on('exit', () => {
      clearTimeout(timer);
      done(parseClipboardOutput(out));
    });
  });
}
