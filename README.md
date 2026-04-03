# GawdClaude

Your Claude Code setup is sprawling. This keeps it honest.

GawdClaude is a meta-management layer that inventories, audits, and monitors every Claude Code configuration across your machine — CLAUDE.md files, hooks, plugins, MCP servers, session states, memory dirs, the lot. It scores your CLAUDE.md files for quality and heals weak ones by spawning headless Claude Code. It runs a nightly health check, writes findings to your Obsidian vault, and serves a local dashboard so you can see what's broken at a glance.

Single project. Zero npm dependencies. Just Node.js built-ins.

---

## The Problem

Claude Code drops config files everywhere. Every project gets its own CLAUDE.md, maybe a `.mcp.json`, maybe a memory directory, session state files, plugin caches. You work across dozens of projects and things drift:

- Session states go stale and nobody notices
- Memory directories exist but have no index
- Plugins are enabled but their cache is missing
- CLAUDE.md files are thin stubs that don't help Claude understand your project
- Projects that need a CLAUDE.md don't have one at all
- Obsidian journal hooks silently fail because a path changed
- CLAUDE.md files exist for projects that were deleted months ago

There's no single view of what's configured, what's healthy, and what's rotting.

## The Solution

GawdClaude scans everything, flags issues by severity, scores your CLAUDE.md files for content quality, and heals the weak ones autonomously. It also runs at 2 AM so you wake up to a report instead of discovering problems mid-session.

---

## Prerequisites

| Dependency | Required? | What for |
|-----------|-----------|----------|
| **Node.js 18+** | Yes | Runs everything — audit, server, scoring |
| **Git** | Yes | Cloning this repo, commit-date checks in scoring |
| **Claude Code CLI** | Yes | This is a management layer *for* Claude Code. The dashboard and audit run without it, but the CLAUDE.md healing loop spawns headless `claude` sessions. Install: `npm install -g @anthropic-ai/claude-code`, then `claude auth login`. |
| **Obsidian** | No | Enables vault integration for audit reports and the "Today" timeline. |

> On Windows, `setup.ps1` will install Node.js and Git for you via `winget` if they're missing.

## Quick Start (Windows)

One-shot setup — checks dependencies, installs what's missing, configures everything, optionally registers scheduled tasks. **Run from an elevated PowerShell:**

```powershell
git clone https://github.com/ClariSortAi/GawdClaude.git
cd GawdClaude
powershell -ExecutionPolicy Bypass -File setup.ps1
```

What it does:
1. Verifies admin privileges
2. Installs Git and Node.js LTS via `winget` if missing
3. Runs interactive setup (projects directory, port, Obsidian vault)
4. Validates your config and runs an initial audit
5. Asks whether to register Windows Scheduled Tasks

**Dry run** — see exactly what the script would do without changing anything:

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1 -DryRun
```

### Manual Setup (any OS)

```bash
git clone https://github.com/ClariSortAi/GawdClaude.git
cd GawdClaude
node setup.mjs          # interactive config — writes config.json
node audit.mjs          # one-shot health check
node server.mjs         # dashboard at http://localhost:6660
```

No `npm install`. No build step.

### What `setup.mjs` asks

1. **Projects directory** — where your code repos live (e.g. `C:\Dev`, `~/dev`). Must exist or the dashboard shows an empty state with guidance.
2. **Dashboard port** — defaults to 6660
3. **Obsidian vault** — auto-detects from `~/.claude/obsidian-hook-config.json`, or asks for a path, or skips

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
| MCP configs | All `.mcp.json` files are valid JSON |
| Orphan detection | Flags configs for deleted projects (and vice versa) |
| **CLAUDE.md quality** | Scores 0-100 based on content vs project complexity |

---

## Dashboard

Light/dark theme toggle, charts, and toast notifications. Serves on `localhost:6660`.

**What you see:**
- Health badge (green/yellow/red) with issue count
- Status cards: projects, plugins, session states, memory dirs, issues
- Charts: project config coverage bar chart, issues-by-severity donut, plugin status donut
- **Today timeline**: what you got done across all projects, pulled from Obsidian vault diaries and session-state files
- **CLAUDE.md health**: score ring per project (0-100), one-click "Heal" button on anything below threshold
- Issues table with severity, source, and description
- Project grid showing config completeness (CLAUDE.md, memory, session state, MCP)

**API endpoints:**

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/status` | Latest audit results (JSON) |
| `GET` | `/api/projects` | Project inventory |
| `GET` | `/api/today` | Today's activity across projects |
| `GET` | `/api/scores` | CLAUDE.md health scores |
| `POST` | `/api/audit` | Trigger fresh audit |
| `POST` | `/api/heal/:project` | Heal a single project's CLAUDE.md |
| `POST` | `/api/fix/:id` | Apply a known fix |

Available fixes: `stale-session-states`, `empty-memory-index`.

---

## CLAUDE.md Healing Loop

The killer feature. Scores every CLAUDE.md for content quality relative to project complexity, then heals below-threshold projects by spawning headless Claude Code.

### Scoring (heuristic, instant, free)

- Detects stack from `package.json`, `pyproject.toml`, `go.mod`, etc.
- Counts files to determine complexity tier: simple (< 10), medium (10-50), complex (50+)
- Scores 0-100 based on: section presence (structure, conventions, how-to-run), length relative to complexity, stack mention, freshness vs last commit
- No API calls, no tokens — pure filesystem heuristics

### Healing (headless Claude Code)

- **Missing CLAUDE.md**: spawns `claude -p` with a generation prompt that analyzes the codebase and writes a comprehensive file from scratch
- **Weak CLAUDE.md**: spawns `claude -p` with a targeted prompt listing exactly which sections are missing, so Claude knows what to fix
- Uses `--model sonnet` for speed, `--dangerously-skip-permissions` for headless operation
- Runs serially, one project at a time

### CLI

```bash
# Score all projects, print table
node improve.mjs --score-only

# Score + heal everything below threshold (default 60)
node improve.mjs

# Custom threshold
node improve.mjs --threshold 40

# Single project
node improve.mjs --project my-project
```

---

## Architecture

```
GawdClaude/
├── setup.ps1          # One-shot setup — deps, config, scheduled tasks (Windows, admin)
├── setup.mjs          # Interactive setup — writes config.json (cross-platform)
├── config.json        # User-specific paths and settings (gitignored)
├── config.example.json # Sample config for reference
├── audit.mjs          # Health check engine — 9 checks, JSON output, Obsidian writer
├── improve.mjs        # CLAUDE.md scoring + healing loop
├── server.mjs         # HTTP server — dashboard + API
├── dashboard.html     # Single-file frontend — light/dark theme, charts, timeline, scores
├── register-task.ps1  # Windows Task Scheduler registration (requires admin)
├── CLAUDE.md          # Project instructions for Claude Code
└── .remember/         # Session memory (gitignored)
```

The audit engine is the core. Both the server and the nightly cron import it. `runAudit()` returns a structured JSON object; `writeToObsidian()` converts that to Markdown and writes it to the vault. `improve.mjs` handles scoring and healing independently.

### What it scans

```
~/.claude/
├── settings.json          ← plugin config, hooks, permissions
├── plugins/cache/         ← validates enabled plugins have cached data
├── hooks/
│   ├── session-state/     ← staleness + duplicate checks
│   └── obsidian-journal.mjs  ← verifies hook is registered + functional
├── projects/*/memory/     ← MEMORY.md index presence
└── obsidian-hook-config.json  ← vault path validation

{devDir}/*/
├── CLAUDE.md              ← cross-references with project configs, scored for quality
└── .mcp.json              ← JSON validity check
```

---

## Nightly Automation (Windows)

Registered as Windows Scheduled Tasks. Runs `node audit.mjs --nightly` at 2:00 AM.

Writes to:
- `{vault}/Projects/gawdclaude/_audit.md` — full report (overwritten each run)
- `{vault}/Projects/gawdclaude/_nightly-log.md` — append-only log of every run

### Register the tasks

If you chose not to register tasks during `setup.ps1`, you can do it later:

```powershell
# Requires admin — run from an elevated PowerShell in the GawdClaude directory
powershell -ExecutionPolicy Bypass -File register-task.ps1
```

This creates two scheduled tasks:
1. **GawdClaude-Nightly** — daily at 2:00 AM, runs the audit and writes to Obsidian
2. **GawdClaude-Server** — at logon, starts the dashboard server with auto-restart

Both use `StartWhenAvailable` and `RestartOnFailure`. The script uses `$PSScriptRoot` to resolve paths — works from any install location.

---

## Obsidian Integration

Optional. GawdClaude writes to your Obsidian vault if configured. It reads the vault path from `config.json` (set during `node setup.mjs`) or falls back to `~/.claude/obsidian-hook-config.json`.

Vault structure:

```
{vault}/Projects/gawdclaude/
├── _audit.md         # Latest audit report (auto-overwritten)
├── _nightly-log.md   # Append-only history of every run + healing results
└── YYYY-MM-DD.md     # Daily diary entries (from obsidian-journal.mjs hook)
```

The "Today" dashboard section reads daily diary files from all project folders in the vault to build a cross-project activity timeline. If you don't use Obsidian, the dashboard shows setup instructions in the Today section.

---

## Configuration

Run `node setup.mjs` (or let `setup.ps1` run it for you) to generate `config.json`:

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
| `obsidian.vaultRoot` | Obsidian vault path | Auto-detected or asked during setup |
| `obsidian.subfolder` | Vault subfolder for project notes | `Projects` |
| `ignore` | Array of directory names to skip when scanning | `[]` |

If `config.json` doesn't exist, the audit engine falls back to defaults. The `~/.claude/` path is always derived from your home directory — that's not configurable because it's where Claude Code lives.

### Project filtering

Not everything in your dev directory is a real project. GawdClaude automatically skips directories that don't look like projects — no git repo, no package manifest (`package.json`, `pyproject.toml`, `go.mod`, etc.), and fewer than 3 files. Empty folders, temp dirs, and stubs are filtered out.

For anything the heuristic doesn't catch, add directory names to the `ignore` array in `config.json`:

```json
{
  "ignore": ["New folder", "temp", "archive"]
}
```

---

## License

MIT
