// CVC Voice Injector — VS Code extension
// Listens on HTTP port 9001 and inserts text at the current cursor position
// using the official VS Code API (fully trusted, no isTrusted workarounds needed).
// Also provides an HTTP-based terminal API via node-pty.

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9001;

// Pending notifications from Claude Code hooks.
// TTL-based: notifications persist for NOTIF_TTL_MS and can be read by multiple consumers.
// Each notification has an auto-incrementing id and a createdAt timestamp.
let _pendingNotifications = [];
let _notifIdCounter = 0;
let _lastResponseNotifyTime = 0;
let _lastIdleNotifyTime = 0;
const NOTIFY_COOLDOWN_MS = 5000;
const NOTIF_TTL_MS = 60000; // 60 seconds

// Timer-based "task done" detection: if no new Stop hook fires within
// IDLE_TIMEOUT_MS after the last one, we infer Claude is done and queue
// an "idle" (task done) notification.
let _idleTimer = null;
const IDLE_TIMEOUT_MS = 15000;

// Try to load node-pty from code-server's node_modules
let pty;
try {
  pty = require('/usr/lib/code-server/lib/vscode/node_modules/node-pty');
  console.log('[CVC] node-pty loaded successfully');
} catch (e) {
  console.warn('[CVC] node-pty not available — terminal feature disabled:', e.message);
}

// ── HTTP Terminal session (singleton) ────────────────────────────────────────

let _ptyProcess = null;
let _outputBuffer = '';
let _ptyExited = false;
let _ptyExitCode = null;
const MAX_BUFFER = 256 * 1024; // 256 KB max buffered output

function destroyTerminal() {
  if (_ptyProcess) {
    try { _ptyProcess.kill(); } catch (_) {}
    _ptyProcess = null;
  }
  _outputBuffer = '';
  _ptyExited = false;
  _ptyExitCode = null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Auto-configure Claude Code hooks ─────────────────────────────────────────

function autoConfigureHooks() {
  const settingsPath = path.join(process.env.HOME || '/root', '.claude', 'settings.json');
  const stopCmd = 'curl -s -X POST http://localhost:9001/notify >/dev/null 2>&1 &';
  const notifCmd = 'curl -s -X POST http://localhost:9001/notify-idle >/dev/null 2>&1 &';

  let settings = {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('[CVC] Could not read ~/.claude/settings.json:', e.message);
      return;
    }
    // File doesn't exist — will create it
  }

  if (!settings.hooks) settings.hooks = {};

  let changed = false;

  // Stop hook — fires on every Claude response
  const hasStop = Array.isArray(settings.hooks.Stop) &&
    settings.hooks.Stop.some(h =>
      Array.isArray(h.hooks) && h.hooks.some(hh => hh.command && hh.command.includes('9001/notify'))
    );
  if (!hasStop) {
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: stopCmd }],
    });
    changed = true;
  }

  // Notification hook — backup (may not fire in VS Code extension yet)
  const hasNotif = Array.isArray(settings.hooks.Notification) &&
    settings.hooks.Notification.some(h =>
      Array.isArray(h.hooks) && h.hooks.some(hh => hh.command && hh.command.includes('9001/notify-idle'))
    );
  if (!hasNotif) {
    if (!Array.isArray(settings.hooks.Notification)) settings.hooks.Notification = [];
    settings.hooks.Notification.push({
      matcher: '',
      hooks: [{ type: 'command', command: notifCmd }],
    });
    changed = true;
  }

  if (changed) {
    try {
      const dir = path.dirname(settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      console.log('[CVC] Hooks auto-configured in ~/.claude/settings.json');
    } catch (e) {
      console.warn('[CVC] Failed to write hooks:', e.message);
    }
  } else {
    console.log('[CVC] Hooks already configured — no changes needed');
  }
}

// ── Main activation ──────────────────────────────────────────────────────────

function activate(context) {
  autoConfigureHooks();

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Parse URL to handle query params
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // ── /ping ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pong');
      return;
    }

    // ── /inject ────────────────────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/inject') {
      const body = await readBody(req);
      let text = '';
      try {
        const parsed = JSON.parse(body);
        text = parsed.text || '';
      } catch (_) {
        text = body;
      }

      if (!text) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing text');
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('No active editor');
        return;
      }

      editor.edit(builder => {
        const selection = editor.selection;
        if (!selection.isEmpty) {
          builder.replace(selection, text);
        } else {
          builder.insert(selection.active, text);
        }
      }).then(success => {
        if (success) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Edit failed');
        }
      });
      return;
    }

    // ── /notify ────────────────────────────────────────────────────────────
    // Called by the Stop hook on every Claude response.
    // Immediately queues a "response" notification, then starts/resets
    // a 15-second idle timer. If no new /notify arrives within 15s,
    // Claude is considered done and a "idle" (task done) notification
    // is queued automatically.
    if (req.method === 'POST' && pathname === '/notify') {
      req.resume();
      const now = Date.now();
      if (now - _lastResponseNotifyTime > NOTIFY_COOLDOWN_MS) {
        _pendingNotifications.push({ id: ++_notifIdCounter, type: 'response', message: 'Claude is responding', createdAt: now });
        _lastResponseNotifyTime = now;
        console.log('[CVC] Stop hook received — response notification queued (id=' + _notifIdCounter + ')');
      }

      // Reset the idle timer: if no new Stop arrives within 15s,
      // Claude has finished the task.
      if (_idleTimer) clearTimeout(_idleTimer);
      _idleTimer = setTimeout(() => {
        _idleTimer = null;
        _pendingNotifications.push({ id: ++_notifIdCounter, type: 'idle', message: 'Claude finished the task', createdAt: Date.now() });
        // Prune expired notifications
        const cutoff = Date.now() - NOTIF_TTL_MS;
        _pendingNotifications = _pendingNotifications.filter(n => n.createdAt > cutoff);
        console.log('[CVC] No new response for 15s — task-done notification queued (id=' + _notifIdCounter + ')');
      }, IDLE_TIMEOUT_MS);

      res.writeHead(200);
      res.end('OK');
      return;
    }

    // ── /notify-idle ───────────────────────────────────────────────────────
    // Called by the Notification hook (backup — may not fire in VS Code ext).
    // Also cancels the idle timer since we got an explicit signal.
    if (req.method === 'POST' && pathname === '/notify-idle') {
      req.resume();
      const now = Date.now();
      if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
      if (now - _lastIdleNotifyTime > NOTIFY_COOLDOWN_MS) {
        _pendingNotifications.push({ id: ++_notifIdCounter, type: 'idle', message: 'Claude finished the task', createdAt: now });
        _lastIdleNotifyTime = now;
        console.log('[CVC] Idle hook received — task-done notification queued (id=' + _notifIdCounter + ')');
      }
      res.writeHead(200);
      res.end('OK');
      return;
    }

    // ── /workspace ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/workspace') {
      const folders = vscode.workspace.workspaceFolders;
      const path = folders && folders.length > 0 ? folders[0].uri.fsPath : '';
      jsonResponse(res, 200, { path });
      return;
    }

    // ── /poll?since_id=N ───────────────────────────────────────────────────
    // Returns all non-expired notifications with id > since_id.
    // Notifications are NOT consumed — they expire after NOTIF_TTL_MS (60s).
    // Multiple devices can poll independently using their own since_id cursor.
    if (req.method === 'GET' && pathname === '/poll') {
      // Prune expired notifications
      const cutoff = Date.now() - NOTIF_TTL_MS;
      _pendingNotifications = _pendingNotifications.filter(n => n.createdAt > cutoff);

      const sinceId = parseInt(url.searchParams.get('since_id')) || 0;
      const notifications = _pendingNotifications.filter(n => n.id > sinceId);
      jsonResponse(res, 200, { notifications });
      return;
    }

    // ── GET /listdir?path=...&hidden=true ──────────────────────────────────
    // Returns directory entries for the folder picker. Include hidden with ?hidden=true.
    if (req.method === 'GET' && pathname === '/listdir') {
      const dirPath = url.searchParams.get('path') || process.env.HOME || '/';
      const showHidden = url.searchParams.get('hidden') === 'true';
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const dirs = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          // Always include hidden dirs in response — client filters display
          dirs.push(entry.name);
        }
        dirs.sort((a, b) => {
          // Hidden dirs at the end
          const aHid = a.startsWith('.') ? 1 : 0;
          const bHid = b.startsWith('.') ? 1 : 0;
          if (aHid !== bHid) return aHid - bHid;
          return a.localeCompare(b, undefined, { sensitivity: 'base' });
        });
        jsonResponse(res, 200, { path: dirPath, dirs });
      } catch (e) {
        jsonResponse(res, 400, { error: e.message });
      }
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // HTTP Terminal API (no WebSocket — works through code-server proxy)
    // ══════════════════════════════════════════════════════════════════════

    // ── POST /terminal/create?cwd=... ──────────────────────────────────────
    if (req.method === 'POST' && pathname === '/terminal/create') {
      if (!pty) {
        jsonResponse(res, 500, { ok: false, error: 'node-pty not available' });
        return;
      }

      // Kill existing session if any
      destroyTerminal();

      const cwd = url.searchParams.get('cwd') || process.env.HOME || '/';
      const shell = process.env.SHELL || '/bin/bash';
      const cols = parseInt(url.searchParams.get('cols')) || 80;
      const rows = parseInt(url.searchParams.get('rows')) || 24;

      try {
        _ptyProcess = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' },
        });

        console.log(`[CVC] Terminal spawned (pid=${_ptyProcess.pid}, cwd=${cwd})`);

        _ptyProcess.onData((data) => {
          _outputBuffer += data;
          // Trim buffer if too large (keep tail)
          if (_outputBuffer.length > MAX_BUFFER) {
            _outputBuffer = _outputBuffer.slice(-MAX_BUFFER);
          }
        });

        _ptyProcess.onExit(({ exitCode }) => {
          console.log(`[CVC] Terminal exited (code=${exitCode})`);
          _ptyExited = true;
          _ptyExitCode = exitCode;
        });

        jsonResponse(res, 200, { ok: true, pid: _ptyProcess.pid });
      } catch (e) {
        console.error('[CVC] Failed to spawn terminal:', e.message);
        jsonResponse(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    // ── POST /terminal/input ───────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/terminal/input') {
      if (!_ptyProcess || _ptyExited) {
        jsonResponse(res, 410, { ok: false, error: 'No active terminal' });
        return;
      }
      const body = await readBody(req);
      _ptyProcess.write(body);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // ── GET /terminal/output ───────────────────────────────────────────────
    // Returns buffered output and clears buffer.
    // If no output yet, waits up to 500ms (long-poll).
    if (req.method === 'GET' && pathname === '/terminal/output') {
      if (!_ptyProcess && !_ptyExited) {
        jsonResponse(res, 410, { ok: false, error: 'No active terminal' });
        return;
      }

      // If there's data already, return immediately
      if (_outputBuffer.length > 0 || _ptyExited) {
        const data = _outputBuffer;
        _outputBuffer = '';
        jsonResponse(res, 200, { data, exited: _ptyExited, exitCode: _ptyExitCode });
        return;
      }

      // Long-poll: wait up to 500ms for data
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const data = _outputBuffer;
        _outputBuffer = '';
        jsonResponse(res, 200, { data, exited: _ptyExited, exitCode: _ptyExitCode });
      }, 500);

      // Check every 50ms if data arrived
      const interval = setInterval(() => {
        if (resolved) { clearInterval(interval); return; }
        if (_outputBuffer.length > 0 || _ptyExited) {
          resolved = true;
          clearTimeout(timer);
          clearInterval(interval);
          const data = _outputBuffer;
          _outputBuffer = '';
          jsonResponse(res, 200, { data, exited: _ptyExited, exitCode: _ptyExitCode });
        }
      }, 50);

      // Clean up on client disconnect
      req.on('close', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          clearInterval(interval);
        }
      });
      return;
    }

    // ── POST /terminal/resize ──────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/terminal/resize') {
      if (!_ptyProcess || _ptyExited) {
        jsonResponse(res, 410, { ok: false, error: 'No active terminal' });
        return;
      }
      const body = await readBody(req);
      try {
        const { cols, rows } = JSON.parse(body);
        if (cols && rows) {
          _ptyProcess.resize(cols, rows);
          jsonResponse(res, 200, { ok: true });
        } else {
          jsonResponse(res, 400, { ok: false, error: 'Missing cols/rows' });
        }
      } catch (e) {
        jsonResponse(res, 400, { ok: false, error: 'Invalid JSON' });
      }
      return;
    }

    // ── POST /terminal/destroy ─────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/terminal/destroy') {
      destroyTerminal();
      jsonResponse(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[CVC] Port ${PORT} already in use, skipping bind`);
    } else {
      vscode.window.showErrorMessage(`CVC Voice Injector: server error — ${err.message}`);
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[CVC] Voice injector listening on port ${PORT}`);
    console.log(`[CVC] HTTP Terminal API available at /terminal/*`);
  });

  context.subscriptions.push({
    dispose: () => {
      destroyTerminal();
      server.close();
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
