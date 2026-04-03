# GawdClaude — Meta-Management Hub

This project is the control plane for all Claude Code configurations across Jason's system.

## Role
God Claude: inventory, audit, and optimize every Claude Code config file at both the user level (`~/.claude/`) and project level (`C:\Dev\*`). This includes CLAUDE.md files, hooks, plugins, MCP configs, session-state files, memory dirs, and Obsidian vault integration.

## What This Project Manages
- **30 project configs** in `~/.claude/projects/`
- **21 project CLAUDE.md files** across `C:\Dev\`
- **12 memory directories** with persistent cross-session knowledge
- **7 session-state files** feeding the Obsidian journal hook
- **6 MCP configurations** for project-specific tool servers
- **25 enabled plugins** (8 disabled)
- **1 global Stop hook** writing to Obsidian vault

## Key Paths
- Global config: `C:\Users\jason\.claude\CLAUDE.md`
- Global settings: `C:\Users\jason\.claude\settings.json`
- Obsidian hook: `C:\Users\jason\.claude\hooks\obsidian-journal.mjs`
- Obsidian config: `C:\Users\jason\.claude\obsidian-hook-config.json`
- Obsidian vault: `C:\Users\jason\Documents\Obsidian Vault\Projects\`
- Session states: `C:\Users\jason\.claude\hooks\session-state\`
- Plugin cache: `C:\Users\jason\.claude\plugins\cache\`

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
9. Report findings to Obsidian vault at `Projects/gawdclaude/_audit.md`

## Conventions
- Audit reports go to Obsidian vault, not this repo
- Session-state for this project: `~/.claude/hooks/session-state/gawdclaude.json`
- Never modify other projects' code — only their Claude configs
- Always ask before disabling plugins or deleting configs
