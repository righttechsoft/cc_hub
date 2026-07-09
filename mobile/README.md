# cc_hub mobile

Mobile client for [cc_hub](../README.md) — monitor and control Claude Code sessions
running on your machine from your phone: live session list, permission
approvals, inter-instance chat, and knowledge base search. Talks to the hub
over LAN, or from anywhere via an optional Cloudflare Worker relay.

## Setup

```
flutter pub get
flutter run
```

### First-run configuration

On first launch you'll be asked for:

- **LAN URL** — `http://<hub-ip>:4270` (the hub's address on your local network).
- **Worker URL** *(optional)* — `https://<name>.workers.dev`, if you've deployed
  the Cloudflare Worker relay for access from outside your LAN.
- **Token** — the hub's `authToken`, from `config.json` on the machine running
  the hub.

These are stored on-device and can be changed later from the overflow menu
(⋮) → Settings. Saving settings restarts the app's connection from scratch.

## Features

- **Sessions** — live list of Claude Code sessions across all connected
  instances, with status, working directory, and last-activity time. Tap
  through to a session's event timeline, send it a prompt, or toggle
  auto-continue. Start a brand new session remotely.
- **Permissions** — a banner surfaces the oldest pending permission request
  as soon as it comes in, with quick Allow/Deny; the full Permissions screen
  shows every pending request (with tool input and a countdown) plus recent
  decision history.
- **Chat** — direct or broadcast messages between Claude Code instances.
- **Knowledge Base** — search shared notes, read them, or add new ones.
- A connection pill in the app bar shows whether you're on LAN, on the relay,
  or offline; a limit banner appears when the hub reports anything other than
  `ok` for Anthropic usage limits.

## Limitations

- **Foreground-only.** There is no push notification channel — the app has
  to be open (or backgrounded and resumed) to see new activity. Nothing
  wakes it up in the background.
- **Permission window is advisory.** The ~30s countdown shown on a pending
  permission is a client-side estimate of the hook's timeout, not an
  authoritative clock — the server decides when a request actually times out.
- **New Session requires an absolute path** on the machine running the hub
  (e.g. `/home/user/project`), not a path on the phone.

## Build

```
flutter build apk --release
```

iOS builds are not set up locally (this workspace is Windows-only) — planned
via CI later.
