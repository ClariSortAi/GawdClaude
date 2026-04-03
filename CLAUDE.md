# GawdClaude — Meta-Management Hub

This project is the control plane for all Claude Code configurations on the host machine.

## Role
Gawd Claude: inventory, audit, score, and heal every Claude Code config file at both the user level (`~/.claude/`) and project level. This includes CLAUDE.md files, hooks, plugins, MCP configs, session-state files, memory dirs, and Obsidian vault integration.

## Project Structure
```
GawdClaude/
├── setup.ps1          # One-shot setup — deps, config, scheduled tasks (Windows, admin)
├── setup.mjs          # Interactive setup — writes config.json
├── config.json        # User paths: devDir, port, obsidian vault (gitignored)
├── audit.mjs          # Health check engine — 9 checks, JSON output, Obsidian writer
├── improve.mjs        # CLAUDE.md scoring + healing loop (spawns headless Claude)
├── server.mjs         # HTTP server — dashboard + API on port 6660
├── dashboard.html     # Single-file frontend — theme toggle, charts, timeline, scores, manage projects
├── register-task.ps1  # Windows Task Scheduler for nightly + server at logon (admin)
├── config.example.json # Sample config for new users
├── CLAUDE.md          # This file
├── README.md          # User-facing documentation
└── .remember/         # Session logs (gitignored)
```

## How to Run
```powershell
# One-shot setup (Windows, elevated PowerShell) — installs deps, configures, schedules
powershell -ExecutionPolicy Bypass -File setup.ps1
```
```bash
# Or manual setup (any OS)
node setup.mjs                 # First-time setup (writes config.json)
node audit.mjs                 # One-shot health check (JSON to stdout)
node audit.mjs --nightly       # Health check + write to Obsidian vault
node server.mjs                # Dashboard at http://localhost:6660
node improve.mjs --score-only  # Score all CLAUDE.md files
node improve.mjs               # Score + heal below threshold
node improve.mjs --project X   # Score + heal one project
```

## Key Paths (derived at runtime)
- Claude config: `~/.claude/` (from `os.homedir()`)
- Projects dir: from `config.json` → `devDir`
- Obsidian vault: from `config.json` → `obsidian.vaultRoot`
- All paths are configurable via `node setup.mjs` — nothing is hardcoded to a specific machine

## Audit Checklist
When running a health check:
1. Verify all enabled plugins have valid cache entries
2. Check session-state files for staleness (>7 days)
3. Check for duplicate/conflicting session-state filenames
4. Verify Obsidian hook can write to vault
5. Check memory dirs have MEMORY.md indexes
6. Verify .mcp.json files are valid JSON
7. Cross-reference project configs with actual project directories
8. Flag orphaned configs (project deleted but config remains)
9. Check watchdog status (webhook, ngrok health)

## CLAUDE.md Healing Loop
- `improve.mjs` scores every project's CLAUDE.md 0-100 based on section coverage, complexity match, freshness
- Projects below threshold (default 60) are healed by spawning headless `claude -p` with targeted prompts
- Missing files: generates from scratch via codebase analysis
- Weak files: sends specific findings (missing sections) so Claude knows what to fix
- Runs serially to avoid hammering the API

## Conventions
- Audit reports go to Obsidian vault, not this repo
- Never modify other projects' source code — only their Claude configs
- `config.json` is gitignored — user-specific paths stay local
- Zero npm dependencies — everything uses Node built-in modules
