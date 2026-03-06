# CVC Voice Injector

[![Open VSX](https://img.shields.io/open-vsx/v/maflabs38/cvc-voice-injector)](https://open-vsx.org/extension/maflabs38/cvc-voice-injector)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**VS Code extension for code-server** — Bridge between the [Claude Visual Code](https://maflabs38.github.io/claude-visual-code/) mobile app and Claude Code.

This extension runs an HTTP server on port 9001 inside code-server, enabling the mobile app to communicate with Claude Code through a trusted channel.

---

## Why this extension exists

The Claude Code extension runs inside a **cross-origin iframe** in code-server. Browser security prevents the mobile WebView from interacting with the iframe's DOM directly — you cannot inject text into the Claude Code chat input from outside the iframe.

This extension runs in the **VS Code extension host** (Node.js), which is fully trusted and has access to the VS Code API. It can execute commands, read/write files, and interact with any editor or terminal — bypassing the cross-origin restriction entirely.

---

## Features

### Voice injection
Receives transcribed speech from the mobile app via HTTP and inserts it at the cursor position in the active editor.

### Notification relay
Claude Code hooks call this extension on every response. The extension queues notifications that the mobile app polls to show Android notifications (e.g., "Claude finished the task"). Notifications are **TTL-based** (60s expiry) so multiple devices can poll independently without stealing each other's notifications.

### HTTP terminal
Provides a full PTY-based terminal session over HTTP. No WebSocket needed — works through the code-server port proxy. The mobile app renders the terminal output using xterm.

### Workspace browsing
Returns the current workspace path and lists directories for the workspace picker in the mobile app.

### Auto-configured hooks
On startup, the extension automatically adds the required Claude Code hooks to `~/.claude/settings.json`. No manual configuration needed — install the extension and it works.

---

## Install

### From Open VSX (recommended)

```bash
code-server --install-extension maflabs38.cvc-voice-injector
sudo systemctl restart code-server@$USER
```

### From source

```bash
git clone https://github.com/MafLabs38/cvc-voice-injector.git
cp -r cvc-voice-injector ~/.local/share/code-server/extensions/cvc-voice-injector
sudo systemctl restart code-server@$USER
```

---

## API Reference

All endpoints are available on port 9001, accessible through the code-server port proxy at `/proxy/9001/`.

### General

| Endpoint | Method | Description |
|---|---|---|
| `/ping` | GET | Health check — returns `pong` |
| `/workspace` | GET | Returns current workspace folder path |
| `/listdir?path=...` | GET | Lists subdirectories for the given path |

### Voice injection

| Endpoint | Method | Description |
|---|---|---|
| `/inject` | POST | Insert text at cursor position. Body: `{"text": "..."}` |

### Notifications

| Endpoint | Method | Description |
|---|---|---|
| `/notify` | POST | Queue a "response" notification (called by Stop hook) |
| `/notify-idle` | POST | Queue a "task done" notification (called by Notification hook) |
| `/poll?since_id=N` | GET | Get all notifications with id > N (TTL 60s, not consumed on read) |

**How notifications work:**

1. Claude Code responds → Stop hook fires → `POST /notify` → "response" notification queued
2. If no new response for 15 seconds → "idle" (task done) notification queued automatically
3. Mobile app polls `/poll?since_id=N` every 4s (foreground) or 10s (background)
4. Notifications expire after 60 seconds — multiple devices can poll independently

### Terminal

| Endpoint | Method | Description |
|---|---|---|
| `/terminal/create?cwd=...&cols=80&rows=24` | POST | Spawn a PTY terminal session |
| `/terminal/input` | POST | Send raw input to terminal (include `\r` for Enter) |
| `/terminal/output` | GET | Read buffered output (long-poll, waits up to 500ms) |
| `/terminal/resize` | POST | Resize terminal. Body: `{"cols": N, "rows": N}` |
| `/terminal/destroy` | POST | Kill the terminal session |

---

## Auto-configured hooks

On startup, the extension reads `~/.claude/settings.json` and adds these hooks if missing:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://localhost:9001/notify >/dev/null 2>&1 &"
      }]
    }],
    "Notification": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST http://localhost:9001/notify-idle >/dev/null 2>&1 &"
      }]
    }]
  }
}
```

Existing settings are preserved — the extension only adds missing hooks.

---

## Verify

```bash
# After connecting to code-server with a browser or the mobile app:
curl http://localhost:9001/ping
# → pong

# Test notification flow:
curl -s -X POST http://localhost:9001/notify
curl -s http://localhost:9001/poll?since_id=0
# → {"notifications":[{"id":1,"type":"response","message":"Claude is responding",...}]}
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Port 9001 already in use | `fuser -k 9001/tcp` then restart code-server |
| Extension not loading | The extension host starts when a client connects — open code-server in a browser first |
| Hooks not firing | Check `~/.claude/settings.json` — restart code-server to trigger auto-config |
| No notifications on mobile | Verify the app can reach `/proxy/9001/poll` through code-server |

---

## Source code

This repository is automatically synced from the private [claude-visual-code](https://github.com/MafLabs38/claude-visual-code) repository. The extension source is a single file: [`extension.js`](extension.js).

## Documentation

Full project documentation: [maflabs38.github.io/claude-visual-code](https://maflabs38.github.io/claude-visual-code/)

## License

[MIT](LICENSE)
