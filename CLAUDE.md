# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build / Run / Dev

```bash
npm run build        # tsc (ESM, target ES2022, outDir: dist/)
npm run dev          # tsx src/index.ts (hot-reload dev)
npm start            # node dist/index.js
lportal -p 14554     # CLI after npm link
```

No test suite, no linter configured.

## Architecture

A LAN voice-input relay: phone sends text/files over WebSocket → server writes to PC clipboard. The phone opens a web UI (served as static HTML) that connects back via WebSocket. Terminal CLI provides a REPL with slash-command management.

### Entry & orchestration

- `src/index.ts` — CLI definition (`cac`). Parses `--port`, `--auto-copy`, `--max-history`, `--code`, `--zh/--en` and delegates to `main()`.
- `src/main.ts` — `PortalApp` is the top-level orchestrator. On startup it checks for existing processes, creates `ServerConfig`, starts `Server`, prints banner + QR code, then enters a `readline` REPL. All slash commands route through `CommandHandler`. A background loop drains `server.terminalQueue` to print notifications without breaking the REPL.

### Server & protocol (`src/server.ts`)

The `Server` class owns an HTTP server (serves `static/index.html`, QR page/image, file downloads) and a `WebSocketServer` at `/ws`. WebSocket connection lifecycle:

1. **Auth** — client sends `{ type: "auth", code }`, up to 3 attempts with 10s timeout each
2. **Register** — client sends `{ type: "register", device_name }`, server assigns a persistent `loginId` (reuses if device_name was seen before). Name must be unique among online devices.
3. **Message loop** — client can send `text`, `file_start/chunk/end`, or `command` (set_mode, new_session)
4. **Disconnect** — device's ws is set to null but device info is preserved for reconnection

Text messages are added to `History`, written to clipboard via `clipboardy` (in cover or add/append mode), then broadcast to all verified clients.

The server can also push messages/files to specific devices (`sendServerText`, `sendServerFile`) — used by the `/link` + `/send` flow where the terminal user sends text/files to a phone.

### Config & state (`src/config.ts`)

`ServerConfig` holds all runtime state: `port`, `host`, `autoCopy`, `copyMode` (`"cover"` | `"add"`), `pairingCode` (4 digits, auto-generated), `sessionBuffer` (for append mode), `currentSessionId`, `History`, and `BeautyHistory`. The `qrUrl` embeds the pairing code as a query param so the phone's web UI can auto-submit it.

### History (`src/history.ts`)

`History` is a fixed-size circular buffer (default 10 entries). Each `MessageEntry` stores text, sessionId, device info, and optional file metadata. `list()` returns entries with re-indexed IDs (newest = 1). `BeautyHistory` is the same pattern for LLM beauty results.

### Terminal UI (`src/ui.ts`)

Uses `chalk` for colored output. `printMessage()` handles concurrent REPL input by clearing the current line, printing, then restoring the prompt. Table-formatted lists use CJK-aware `textWidth()` for alignment.

### Slash commands (`src/commands.ts`)

`CommandHandler` maps slash commands to methods. Key commands:
- `/copy [N]` — copy a history entry to clipboard (groups by session)
- `/list` — show history grouped by session
- `/mode [cover|add]` — switch copy mode, broadcasts to all clients
- `/link <device>` — enter session mode; typed text goes directly to that device
- `/send <file>` — send file to linked device (100MB max)
- `/beauty [N]` — run LLM text structuring on a history entry
- `/rq` — regenerate pairing code, disconnects all clients

### File transfer (`src/file-transfer.ts`)

Singleton `FileTransferManager`. Handles incoming chunks from phones (base64-encoded, 64KB each). Saves to `LPORTAL_DOWNLOAD_DIR` or system Downloads. Only allows image/video MIME types from phones. Server→phone file push is handled inline in `Server.sendServerFile()`.

### LLM text beauty (`src/beauty.ts`)

Calls any OpenAI-compatible API with streaming. Config loaded from `.env` in user config dir or CWD. System prompt from `src/prompt/text-beauty.md` (can be overridden by `text-beauty.md` in config dir). Supports `<think>` tags in streaming output (rendered dim in terminal).

### i18n (`src/i18n.ts`)

Auto-detects locale from env vars or `Intl.DateTimeFormat`. Supports `zh` and `en`. All user-facing strings go through the `_()` function with optional `{param}` interpolation. Override with `--zh` or `--en` CLI flags.

### Web client (`static/index.html`)

Single self-contained HTML file (~900 lines JS inline). Dark theme, mobile-first. Handles: auth dialog, device registration, message display (text/images/video/download cards), file upload, copy mode switching, fullscreen input. Persists pairing code and device info in `localStorage` for reconnection. Uses `visualViewport` API for iOS keyboard handling.
