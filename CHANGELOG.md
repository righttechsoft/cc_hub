# Changelog

## August 2026

### Added

- **cc-attach transparent console**: wraps `claude` in a pty (ConPTY/winpty), injecting mobile and chat-relay prompts straight into the live terminal instead of running them as invisible headless turns, and mirrors pty output to mobile as a read-only terminal view (`eaf12f7`).
- **Admin page** (`/admin`): browser UI to view, search, edit and delete Athen notes and chat/broadcast messages, served by the hub itself — htmx + Alpine + FlyonUI, no separate server (`38c7c5f`). Messages tab gained All/Broadcast/Direct filters with pagination (`35792db`, `03d6547`); a Sessions tab shows live status, attach state and a working indicator per session, auto-refreshing every 5s (`a584ab4`); a footer lists each instance's running apps as clickable links (`c063cd6`, `23c9a59`).
- **AI one-line summaries** for inter-agent chat messages, generated once via claude-haiku and surfaced in the statusline (`72f36a1`).
- **Actionable permission push notifications**: iOS lock-screen Allow/Deny actions decide a pending tool permission without opening the app; tapping the body opens an in-app popup with the full tool call. Permission pushes bypass the away-detection gate since they're time-critical (`716a9cf`).
- **Mobile image attach**: attach an image to a prompt from the mobile app; it's saved on the host and injected into the live session (`20fcf40`, `28be3ff`).
- **cc-attach smart paste**: Ctrl+V pulls image/file/text straight from the clipboard into the session, with secret redaction and optional code-fencing before the result is shown for review (`7d98b84`, `574a398`).
- **cc-attach prompt snippets**: Ctrl+G then a key expands to a configured snippet (`f5296d8`).
- **cc-attach output triggers**: desktop/mobile toast on build failures and detected local dev-server URLs (`4203b3c`).
- `bin/work` / `bin/resume` shims for launching cc-attach and `cc-attach --resume` (`fc520b0`).

### Fixed

- cc-attach: injected prompts (mobile, chat delivery) stopped submitting under conpty.dll's win32-input-mode, where a raw `\r` no longer registers as Enter; short prompts now submit immediately and multi-line pastes get a short delay before Enter (`28be3ff`, `fc520b0`, `d0e1ad0`).
- cc-attach: Ctrl+V went undetected under that same win32-input-mode encoding, so smart paste silently did nothing; it now triggers on both the raw byte and the encoded key record (`5f675b3`).
- cc-attach: garbled first keystroke and cursor desync under ConPTY, fixed by defaulting to the standalone conpty.dll backend (`CC_HUB_USE_WINPTY=1` still available as a fallback) (`ea0feb6`, `4a83835`, `751e0c6`, `be225c9`, `29d5a1c`).
- cc-attach: connection warnings were bleeding into claude's TUI on the same screen, and two wrappers in one directory would displace each other forever; warnings now go to the debug log only, and a displaced wrapper backs off for 5 minutes instead of fighting for the slot (`84b9354`).
- cc-attach: wouldn't launch on Windows — it ignored `config.json`'s `claudePath` and shelled out to `npx tsx` instead of the repo's own tsx (`2248ec9`).
- admin: broadcasts older than the newest 50 messages were invisible under the Broadcast filter, because the filter ran after the row limit instead of in SQL (`aba9e4f`).
- admin: page was dead on arrival — two of five hand-computed SRI hashes were wrong, so the browser refused to run htmx/Tailwind at all (`9cd95d4`).
- mobile: session transcript stopped opening scrolled to the bottom (`2641101`).

### Changed

- admin: visual redesign (ink-dark theme, single brass accent) and inline confirm toggles in place of native `confirm()` popups for deletes (`f09ca76`, `8a782b9`).
