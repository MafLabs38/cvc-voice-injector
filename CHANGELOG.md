# Changelog

## 0.2.0

- TTL-based notification system (60s expiry, multi-device polling via `since_id`)
- Auto-configure Claude Code hooks in `~/.claude/settings.json` on startup
- HTTP terminal API via node-pty (`/terminal/create`, `input`, `output`, `resize`, `destroy`)
- Workspace browsing endpoint (`/listdir`)
- Idle timer (15s) for automatic task completion detection
- Notification cooldown (5s) to prevent spam

## 0.1.0

- Initial release
- Voice injection via `/inject` endpoint
- Basic notification polling via `/poll`
- Health check endpoint (`/ping`)
