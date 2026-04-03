# GawdClaude

Your Claude Code setup is sprawling. This keeps it honest.

GawdClaude is a meta-management layer that inventories, audits, and monitors every Claude Code configuration across your machine — CLAUDE.md files, hooks, plugins, MCP servers, session states, memory dirs, the lot. It runs a nightly health check, writes findings to your Obsidian vault, and serves a local dashboard so you can see what's broken at a glance.

Single project. Zero dependencies. Just Node.js built-ins.

---

## The Problem

Claude Code drops config files everywhere. Every project gets its own CLAUDE.md, maybe a `.mcp.json`, maybe a memory directory, session state files, plugin caches. You work across 30+ projects and things drift:

- Session states go stale and nobody notices
- Memory directories exist but have no index
- Plugins are enabled but their cache is missing
- Obsidian journal hooks silently fail because a path changed
- CLAUDE.md files exist for projects that were deleted months ago

There's no single view of what's configured, what's healthy, and what's rotting.

## The Solution

GawdClaude scans everything, flags issues by severity, and gives you a dashboard with fix buttons. It also runs at 2 AM so you wake up to a report instead of discovering problems mid-session.

---

## What It Checks

| Check | What It Does |
|-------|-------------|
| Plugin integrity | Enabled plugins have valid cache directories |
| Session-state staleness | Flags files older than 7 days |
| Session-state duplicates | Catches space-vs-hyphen naming conflicts |
| Memory dir health | Every memory dir has a MEMORY.md index |
| Project coverage | CLAUDE.md exists for active projects |
| Obsidian hook | Config is valid, hook is registered, vault path exists |
| Watchdog status | Webhook + ngrok PIDs are alive, status file is fresh |
| MCP configs | All `.mcp.json` files are valid JSON |
| Orphan detection | Flags configs for deleted projects (and vice versa) |

---

## Quick Start

```bash
git clone https://github.com/ClariSortAi/GawdClaude.git
cd GawdClaude

# Interactive setup — tells GawdClaude where your projects live
node setup.mjs

# Run a one-shot audit
node audit.mjs

# Run audit + write to Obsidian vault
node audit.mjs --nightly

# Start the dashboard server
node server.mjs
# → http://localhost:6660
```

No `npm install`. No build step. Everything uses Node built-in modules.

### Setup

`node setup.mjs` asks three questions:

1. **Projects directory** — where your code repos live (e.g. `C:\Dev`, `~/dev`)
2. **Dashboard port** — defaults to 6660
3. **Obsidian vault** — auto-detects from `~/.claude/obsidian-hook-config.json` if you have one, otherwise asks for a path or skips it

Writes a `config.json` that the audit engine and server read at startup. If you skip setup, everything falls back to sensible defaults (`~/dev` on Linux/macOS, `C:\Dev` on Windows).

---

## Dashboard

Dark theme, monospace, terminal aesthetic. Serves on `localhost:6660`.

**What you see:**
- Health badge (green/yellow/red) with issue count
- Status cards: projects, plugins, session states, memory dirs, watchdog
- Issues table with severity, source, and description
- Project grid showing config completeness per project (CLAUDE.md, memory, session state, MCP)
- Action buttons: run audit, refresh stale states, fix missing indexes, open in Obsidian

**API endpoints:**

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/status` | Latest audit results (JSON) |
| `GET` | `/api/projects` | Project inventory |
| `GET` | `/api/watchdog` | Watchdog health |
| `POST` | `/api/audit` | Trigger fresh audit |
| `POST` | `/api/fix/:id` | Apply a known fix |

Available fixes: `stale-session-states`, `empty-memory-index`.

---

## Architecture

```
GawdClaude/
├── setup.mjs          # Interactive setup — writes config.json
├── config.json        # User-specific paths and settings (gitignored)
├── audit.mjs          # Health check engine — 9 checks, JSON output, Obsidian writer
├── server.mjs         # HTTP server — dashboard + API on port 6660
├── dashboard.html     # Single-file frontend — light theme, charts, toast notifications
├── register-task.ps1  # Windows Task Scheduler registration
├── CLAUDE.md          # Meta-management role definition
└── .remember/         # Session memory (logs, tmp)
```

The audit engine is the core. Both the server and the nightly cron import it. `runAudit()` returns a structured JSON object; `writeToObsidian()` converts that to Markdown and writes it to the vault.

### What it scans

```
~/.claude/
├── settings.json          ← plugin config, hooks, permissions
├── plugins/cache/         ← validates enabled plugins have cached data
├── hooks/
│   ├── session-state/     ← staleness + duplicate checks
│   ├── obsidian-journal.mjs  ← verifies hook is registered + functional
│   └── watchdog-status.json  ← PID liveness + freshness
├── projects/*/memory/     ← MEMORY.md index presence
└── obsidian-hook-config.json  ← vault path validation

C:\Dev\*/
├── CLAUDE.md              ← cross-references with project configs
└── .mcp.json              ← JSON validity check
```

---

## Nightly Audit

Registered as a Windows Scheduled Task. Runs `node audit.mjs --nightly` at 2:00 AM.

Writes to:
- `{vault}/Projects/gawdclaude/_audit.md` — full report (overwritten each run)
- `{vault}/Projects/gawdclaude/_nightly-log.md` — append-only log of every run

### Register the tasks

```powershell
# Requires admin
powershell -ExecutionPolicy Bypass -File register-task.ps1
```

This creates two scheduled tasks:
1. **GawdClaude-Nightly** — daily at 2:00 AM, runs the audit and writes to Obsidian
2. **GawdClaude-Server** — at logon, starts the dashboard server with auto-restart

Both use `StartWhenAvailable` and `RestartOnFailure` — same pattern as other watchdog tasks on the machine.

---

## Obsidian Integration

GawdClaude writes to your Obsidian vault alongside the existing journal hook. It reads the vault path from `~/.claude/obsidian-hook-config.json`:

```json
{
  "vaultRoot": "C:/Users/jason/Documents/Obsidian Vault",
  "subfolder": "Projects",
  "enableStatusFile": true
}
```

Vault structure:

```
Obsidian Vault/Projects/gawdclaude/
├── _audit.md         # Latest audit report (auto-overwritten)
├── _nightly-log.md   # Append-only history of every nightly run
└── 2026-04-03.md     # Daily diary entries (from obsidian-journal.mjs hook)
```

---

## Configuration

Run `node setup.mjs` to generate a `config.json`:

```json
{
  "devDir": "C:\\Dev",
  "port": 6660,
  "obsidian": {
    "vaultRoot": "C:/Users/you/Documents/Obsidian Vault",
    "subfolder": "Projects"
  }
}
```

| Key | What | Default |
|-----|------|---------|
| `devDir` | Root directory containing your project repos | `C:\Dev` (Windows), `~/dev` (macOS/Linux) |
| `port` | Dashboard server port | `6660` |
| `obsidian.vaultRoot` | Obsidian vault path | Auto-detected from `~/.claude/obsidian-hook-config.json` |
| `obsidian.subfolder` | Vault subfolder for project notes | `Projects` |

If `config.json` doesn't exist, the audit engine falls back to defaults. The `~/.claude/` path is always derived from your home directory — that's not configurable because it's where Claude Code lives.

---

## Current Status

Working. Running nightly on my machine. The dashboard is ugly-functional — it shows real data and the action buttons work. Not designed for anyone else's machine without editing the paths.

This exists because I run 30+ Claude Code projects and needed a way to know when things break without discovering it mid-session.

---

## License

MIT
