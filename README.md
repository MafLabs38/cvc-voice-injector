# CVC Voice Injector

Bridge between the [Claude Visual Code](https://github.com/MafLabs38/claude-visual-code) mobile app and Claude Code running in code-server.

## What it does

This VS Code extension runs an HTTP server on port 9001 inside code-server. It provides:

- **Voice injection** — Insert transcribed speech into the active editor via HTTP POST
- **Notification relay** — Claude Code hooks notify the mobile app when responses arrive and when tasks complete
- **HTTP terminal** — Full PTY terminal accessible over HTTP (no WebSocket needed)
- **Workspace browsing** — List directories and get the current workspace path

## Why it exists

The Claude Code extension runs inside a cross-origin iframe in code-server. Browser security prevents the mobile WebView from interacting with the iframe's DOM directly. This extension runs in the trusted Node.js extension host, bypassing the restriction entirely.

## Install

```bash
# From Open VSX (recommended)
code-server --install-extension maflabs38.cvc-voice-injector

# Or manually from source
cp -r server/extensions/cvc-voice-injector ~/.local/share/code-server/extensions/
sudo systemctl restart code-server@$USER
```

## Auto-configuration

On startup, the extension automatically adds the required Claude Code hooks to `~/.claude/settings.json`:

- **Stop hook** — Fires on every Claude response, sends notification to port 9001
- **Notification hook** — Backup signal for task completion

No manual hook configuration needed.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/ping` | GET | Health check — returns `pong` |
| `/inject` | POST | Insert text at cursor position |
| `/notify` | POST | Queue a "response" notification (called by Stop hook) |
| `/notify-idle` | POST | Queue a "task done" notification (called by Notification hook) |
| `/poll?since_id=N` | GET | Get notifications with id > N (TTL 60s, multi-device safe) |
| `/workspace` | GET | Current workspace folder path |
| `/listdir?path=...` | GET | List subdirectories |
| `/terminal/create` | POST | Spawn a PTY terminal session |
| `/terminal/input` | POST | Send input to terminal |
| `/terminal/output` | GET | Read terminal output (long-poll) |
| `/terminal/resize` | POST | Resize terminal |
| `/terminal/destroy` | POST | Kill terminal session |

## Verify

```bash
curl http://localhost:9001/ping
# → pong
```

## Documentation

Full documentation: [maflabs38.github.io/claude-visual-code](https://maflabs38.github.io/claude-visual-code/)

## License

MIT
