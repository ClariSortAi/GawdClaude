#!/usr/bin/env node

/**
 * GawdClaude Audit Engine
 *
 * Scans all Claude Code configurations across the system and produces
 * a structured health report. Used by both the nightly cron and the
 * dashboard server.
 *
 * Usage:
 *   node audit.mjs              → print JSON to stdout
 *   node audit.mjs --nightly    → print JSON + write to Obsidian vault
 *   import { runAudit } from './audit.mjs'  → programmatic use
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

// === CONFIG ===
const __dirname = import.meta.dirname;
const CONFIG_PATH = join(__dirname, "config.json");

let userConfig = {};
try {
  userConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
} catch {
  // No config.json — fall back to defaults. Run `node setup.mjs` to create one.
}

// === PATHS ===
const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const PLUGINS_CACHE = join(CLAUDE_DIR, "plugins", "cache");
const SESSION_STATE_DIR = join(CLAUDE_DIR, "hooks", "session-state");
const WATCHDOG_STATUS = join(CLAUDE_DIR, "hooks", "watchdog-status.json");
const OBSIDIAN_CONFIG = join(CLAUDE_DIR, "obsidian-hook-config.json");
const DEV_DIR = userConfig.devDir || (process.platform === "win32" ? "C:\\Dev" : join(HOME, "dev"));

// Load obsidian config — prefer config.json, fall back to Claude's obsidian-hook-config
let obsidianConfig = null;
if (userConfig.obsidian?.vaultRoot) {
  obsidianConfig = userConfig.obsidian;
} else {
  try {
    obsidianConfig = JSON.parse(readFileSync(OBSIDIAN_CONFIG, "utf-8"));
  } catch { /* no obsidian config */ }
}

const VAULT_ROOT = obsidianConfig?.vaultRoot || null;
const VAULT_PROJECT_DIR = VAULT_ROOT ? join(VAULT_ROOT, obsidianConfig?.subfolder || "Projects", "gawdclaude") : null;

// === HELPERS ===
function safeReadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return { _error: err.message };
  }
}

function dirExists(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function fileExists(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function fileAge(path) {
  try {
    const mtime = statSync(path).mtimeMs;
    return Date.now() - mtime;
  } catch { return Infinity; }
}

function listDirs(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return []; }
}

function listFiles(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => d.name);
  } catch { return []; }
}

const DAY_MS = 86400000;
const STALE_THRESHOLD = 7 * DAY_MS;

// === AUDIT CHECKS ===

function checkSettings() {
  const result = { healthy: false, details: {} };
  const settings = safeReadJSON(SETTINGS_PATH);
  if (settings._error) {
    result.details.error = settings._error;
    return result;
  }
  result.healthy = true;
  result.details = {
    defaultMode: settings.permissions?.defaultMode || "unknown",
    skipDangerousPrompt: settings.skipDangerousModePermissionPrompt || false,
    hookCount: Object.keys(settings.hooks || {}).length,
    hooks: Object.keys(settings.hooks || {}),
  };
  return result;
}

function checkPlugins() {
  const result = { healthy: true, enabled: [], disabled: [], missing: [], issues: [] };
  const settings = safeReadJSON(SETTINGS_PATH);
  if (settings._error) {
    result.healthy = false;
    result.issues.push("Cannot read settings.json");
    return result;
  }

  const plugins = settings.enabledPlugins || {};
  for (const [key, enabled] of Object.entries(plugins)) {
    const [name, marketplace] = key.split("@");
    if (enabled) {
      result.enabled.push(key);
      const cachePath = join(PLUGINS_CACHE, marketplace, name);
      if (!dirExists(cachePath)) {
        result.missing.push(key);
        result.issues.push(`Plugin enabled but no cache: ${key}`);
        result.healthy = false;
      }
    } else {
      result.disabled.push(key);
    }
  }
  return result;
}

function checkSessionStates() {
  const result = { healthy: true, states: [], stale: [], duplicates: [], issues: [] };
  const files = listFiles(SESSION_STATE_DIR).filter(f => f.endsWith(".json"));

  // Check for space/hyphen duplicates
  const normalized = {};
  for (const f of files) {
    const key = f.replace(/\s+/g, "-");
    if (!normalized[key]) normalized[key] = [];
    normalized[key].push(f);
  }
  for (const [key, variants] of Object.entries(normalized)) {
    if (variants.length > 1) {
      result.duplicates.push({ normalized: key, files: variants });
      result.issues.push(`Duplicate session-state (space vs hyphen): ${variants.join(", ")}`);
    }
  }

  for (const f of files) {
    const fullPath = join(SESSION_STATE_DIR, f);
    const age = fileAge(fullPath);
    const data = safeReadJSON(fullPath);
    const entry = {
      file: f,
      ageDays: Math.floor(age / DAY_MS),
      summary: data.summary || null,
      hasError: !!data._error,
    };
    result.states.push(entry);

    if (age > STALE_THRESHOLD) {
      result.stale.push(f);
      result.issues.push(`Stale session-state (${entry.ageDays} days): ${f}`);
    }
  }
  return result;
}

function checkMemoryDirs() {
  const result = { healthy: true, dirs: [], empty: [], missingIndex: [], issues: [] };
  const projectDirs = listDirs(PROJECTS_DIR);

  for (const proj of projectDirs) {
    const memDir = join(PROJECTS_DIR, proj, "memory");
    if (!dirExists(memDir)) continue;

    const files = listFiles(memDir);
    const entry = { project: proj, files: files.length, hasIndex: files.includes("MEMORY.md") };
    result.dirs.push(entry);

    if (files.length === 0) {
      result.empty.push(proj);
      result.issues.push(`Empty memory dir: ${proj}`);
    } else if (!entry.hasIndex) {
      result.missingIndex.push(proj);
      result.issues.push(`Memory dir missing MEMORY.md index: ${proj}`);
    }
  }
  return result;
}

function checkProjects() {
  const result = { healthy: true, projects: [], orphanedConfigs: [], orphanedClaudeMd: [], issues: [] };

  // Get all project configs
  const projectConfigs = listDirs(PROJECTS_DIR);

  // Get all dev directories
  let devDirs = [];
  try {
    devDirs = readdirSync(DEV_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { /* no dev dir */ }

  // Build project inventory
  for (const config of projectConfigs) {
    const memDir = join(PROJECTS_DIR, config, "memory");
    const memFiles = dirExists(memDir) ? listFiles(memDir) : [];

    // Try to find matching dev directory
    // Config names look like C--Dev-ProjectName, dev dirs are just ProjectName
    const devName = config.replace(/^C--Dev-/, "").replace(/^C--dev-/, "");
    const hasDevDir = devDirs.some(d => d.toLowerCase() === devName.toLowerCase() ||
                                        d.toLowerCase().replace(/[\s_]/g, "-") === devName.toLowerCase());

    // Check for CLAUDE.md in the dev dir
    let hasClaudeMd = false;
    for (const d of devDirs) {
      if (d.toLowerCase() === devName.toLowerCase() ||
          d.toLowerCase().replace(/[\s_]/g, "-") === devName.toLowerCase()) {
        hasClaudeMd = fileExists(join(DEV_DIR, d, "CLAUDE.md"));
        break;
      }
    }

    // Check for session-state
    const sessionFiles = listFiles(SESSION_STATE_DIR).filter(f => f.endsWith(".json"));
    const hasSessionState = sessionFiles.some(f => {
      const base = f.replace(".json", "").toLowerCase();
      return devName.toLowerCase().includes(base) || base.includes(devName.toLowerCase());
    });

    // Check for MCP config
    let hasMcp = false;
    for (const d of devDirs) {
      if (d.toLowerCase() === devName.toLowerCase() ||
          d.toLowerCase().replace(/[\s_]/g, "-") === devName.toLowerCase()) {
        hasMcp = fileExists(join(DEV_DIR, d, ".mcp.json"));
        // Also check subdirs one level deep
        if (!hasMcp) {
          const subDirs = listDirs(join(DEV_DIR, d));
          for (const sub of subDirs) {
            if (fileExists(join(DEV_DIR, d, sub, ".mcp.json"))) {
              hasMcp = true;
              break;
            }
          }
        }
        break;
      }
    }

    result.projects.push({
      config: config,
      devName,
      hasDevDir,
      hasClaudeMd,
      hasMemory: memFiles.length > 0,
      memoryFiles: memFiles.length,
      hasMemoryIndex: memFiles.includes("MEMORY.md"),
      hasSessionState,
      hasMcp,
    });
  }

  // Check for dev dirs with CLAUDE.md but no project config
  for (const d of devDirs) {
    if (fileExists(join(DEV_DIR, d, "CLAUDE.md"))) {
      const hasConfig = projectConfigs.some(c => {
        const cn = c.replace(/^C--Dev-/, "").replace(/^C--dev-/, "").toLowerCase();
        return cn === d.toLowerCase() || cn === d.toLowerCase().replace(/[\s_]/g, "-");
      });
      if (!hasConfig) {
        result.orphanedClaudeMd.push(d);
        result.issues.push(`CLAUDE.md exists but no project config: ${d}`);
      }
    }
  }

  return result;
}

function checkWatchdog() {
  const result = { healthy: false, details: {} };
  const status = safeReadJSON(WATCHDOG_STATUS);

  if (status._error) {
    result.details.error = status._error;
    result.issues = ["Cannot read watchdog-status.json"];
    return result;
  }

  const age = fileAge(WATCHDOG_STATUS);
  result.details = {
    webhookHealthy: status.webhook_healthy,
    webhookPid: status.webhook_pid,
    ngrokRunning: status.ngrok_running,
    ngrokPid: status.ngrok_pid,
    webhookRestarts: status.webhook_restarts,
    ngrokRestarts: status.ngrok_restarts,
    lastUpdate: status.timestamp,
    ageMins: Math.floor(age / 60000),
  };

  // Healthy if status file is recent (<5 min) and services are up
  result.healthy = age < 300000 && status.webhook_healthy && status.ngrok_running;
  result.issues = [];
  if (age >= 300000) result.issues.push(`Watchdog status stale (${result.details.ageMins} min old)`);
  if (!status.webhook_healthy) result.issues.push("Webhook unhealthy");
  if (!status.ngrok_running) result.issues.push("Ngrok not running");

  return result;
}

function checkMcpConfigs() {
  const result = { healthy: true, configs: [], issues: [] };
  let devDirs = [];
  try {
    devDirs = readdirSync(DEV_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return result; }

  for (const d of devDirs) {
    const mcpPath = join(DEV_DIR, d, ".mcp.json");
    if (fileExists(mcpPath)) {
      const data = safeReadJSON(mcpPath);
      if (data._error) {
        result.healthy = false;
        result.issues.push(`Invalid JSON in ${d}/.mcp.json: ${data._error}`);
        result.configs.push({ project: d, valid: false, error: data._error });
      } else {
        result.configs.push({ project: d, valid: true, serverCount: Object.keys(data.mcpServers || {}).length });
      }
    }
    // Check subdirs
    const subDirs = listDirs(join(DEV_DIR, d));
    for (const sub of subDirs) {
      const subMcpPath = join(DEV_DIR, d, sub, ".mcp.json");
      if (fileExists(subMcpPath)) {
        const data = safeReadJSON(subMcpPath);
        if (data._error) {
          result.healthy = false;
          result.issues.push(`Invalid JSON in ${d}/${sub}/.mcp.json: ${data._error}`);
          result.configs.push({ project: `${d}/${sub}`, valid: false, error: data._error });
        } else {
          result.configs.push({ project: `${d}/${sub}`, valid: true, serverCount: Object.keys(data.mcpServers || {}).length });
        }
      }
    }
  }
  return result;
}

function checkObsidianHook() {
  const result = { healthy: false, details: {}, issues: [] };
  const hookPath = join(CLAUDE_DIR, "hooks", "obsidian-journal.mjs");

  if (!fileExists(hookPath)) {
    result.issues.push("obsidian-journal.mjs not found");
    return result;
  }

  if (!obsidianConfig) {
    result.issues.push("obsidian-hook-config.json not found or invalid");
    return result;
  }

  if (!VAULT_ROOT || !dirExists(VAULT_ROOT)) {
    result.issues.push(`Vault root does not exist: ${VAULT_ROOT}`);
    return result;
  }

  result.healthy = true;
  result.details = {
    hookExists: true,
    vaultRoot: VAULT_ROOT,
    subfolder: obsidianConfig.subfolder || "Projects",
    enableStatus: obsidianConfig.enableStatusFile !== false,
  };

  // Check if hook is registered in settings
  const settings = safeReadJSON(SETTINGS_PATH);
  const hooks = settings.hooks?.Stop || [];
  const registered = hooks.some(h => h.hooks?.some(hh => hh.command?.includes("obsidian-journal")));
  result.details.registeredInSettings = registered;
  if (!registered) {
    result.issues.push("Obsidian hook not registered in settings.json Stop hooks");
    result.healthy = false;
  }

  return result;
}

// === MAIN AUDIT ===
export { userConfig };

// === TODAY: What We Got Done ===
const VAULT_PROJECTS_DIR = VAULT_ROOT ? join(VAULT_ROOT, obsidianConfig?.subfolder || "Projects") : null;

function parseDiaryEntry(block) {
  const entry = { time: null, sessionId: null, focus: null, accomplishments: [], nextSteps: [], blockers: [], branch: null, filesChanged: 0 };

  // Header: ## HH:MM:SS — Session `abcd1234`
  const headerMatch = block.match(/^## (\d{2}:\d{2}:\d{2}) — Session `([^`]+)`/m);
  if (headerMatch) {
    entry.time = headerMatch[1];
    entry.sessionId = headerMatch[2];
  }

  // Focus
  const focusMatch = block.match(/\*\*Focus:\*\* (.+)/);
  if (focusMatch) entry.focus = focusMatch[1];

  // Branch
  const branchMatch = block.match(/\*\*Branch:\*\* `([^`]+)`/);
  if (branchMatch) entry.branch = branchMatch[1];

  // Sections with bullet lists
  const sections = { "### Accomplishments": "accomplishments", "### Next Steps": "nextSteps", "### Blockers": "blockers" };
  for (const [header, key] of Object.entries(sections)) {
    const idx = block.indexOf(header);
    if (idx === -1) continue;
    const afterHeader = block.slice(idx + header.length);
    const lines = afterHeader.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        entry[key].push(trimmed.slice(2));
      } else if (trimmed.startsWith("### ") || trimmed.startsWith("## ") || trimmed === "---") {
        break;
      }
    }
  }

  // Recently modified files count
  const recentIdx = block.indexOf("### Recently Modified Files");
  if (recentIdx !== -1) {
    const afterRecent = block.slice(recentIdx);
    const fileLines = afterRecent.split("\n").filter(l => l.trim().startsWith("- `"));
    entry.filesChanged = fileLines.length;
  }

  return entry;
}

function parseDiaryFile(content) {
  // Split on session headers (## HH:MM:SS)
  const blocks = [];
  const lines = content.split("\n");
  let current = [];
  let inEntry = false;

  for (const line of lines) {
    if (/^## \d{2}:\d{2}:\d{2} — Session/.test(line)) {
      if (inEntry && current.length > 0) {
        blocks.push(current.join("\n"));
      }
      current = [line];
      inEntry = true;
    } else if (inEntry) {
      current.push(line);
    }
  }
  if (inEntry && current.length > 0) {
    blocks.push(current.join("\n"));
  }

  return blocks.map(parseDiaryEntry).filter(e => e.time);
}

export function collectToday(dateStr) {
  const today = dateStr || new Date().toISOString().slice(0, 10);
  const result = { date: today, projects: [], totals: { projectsActive: 0, sessionsTotal: 0, accomplishmentsTotal: 0 } };

  const seenSessions = new Set();

  // Source 1: Obsidian vault daily diaries
  if (VAULT_PROJECTS_DIR && dirExists(VAULT_PROJECTS_DIR)) {
    const projectDirs = listDirs(VAULT_PROJECTS_DIR);
    for (const proj of projectDirs) {
      const diaryPath = join(VAULT_PROJECTS_DIR, proj, `${today}.md`);
      if (!fileExists(diaryPath)) continue;

      try {
        const content = readFileSync(diaryPath, "utf-8");
        const entries = parseDiaryFile(content);
        if (entries.length === 0) continue;

        // Deduplicate by sessionId — keep the latest entry per session
        const bySession = new Map();
        for (const entry of entries) {
          const key = entry.sessionId || entry.time;
          bySession.set(key, entry); // later entry overwrites earlier
        }
        const dedupedEntries = [...bySession.values()];

        for (const e of dedupedEntries) seenSessions.add(`${proj}:${e.sessionId}`);

        result.projects.push({
          name: proj,
          source: "obsidian",
          sessions: dedupedEntries,
        });
      } catch { /* skip unreadable files */ }
    }
  }

  // Source 2: Session-state files updated today (fill gaps for projects not in vault)
  if (dirExists(SESSION_STATE_DIR)) {
    const files = listFiles(SESSION_STATE_DIR).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const fullPath = join(SESSION_STATE_DIR, f);
      const data = safeReadJSON(fullPath);
      if (data._error) continue;

      // Check if updated today
      const updatedAt = data.updatedAt ? data.updatedAt.slice(0, 10) : null;
      const fileModDate = new Date(statSync(fullPath).mtimeMs).toISOString().slice(0, 10);
      if (updatedAt !== today && fileModDate !== today) continue;

      const projName = f.replace(".json", "");

      // Skip if we already got this project from obsidian
      const alreadyCovered = result.projects.some(p => p.name === projName);
      if (alreadyCovered) continue;

      result.projects.push({
        name: projName,
        source: "session-state",
        sessions: [{
          time: data.updatedAt ? new Date(data.updatedAt).toTimeString().slice(0, 8) : "unknown",
          sessionId: null,
          focus: data.summary || null,
          accomplishments: data.accomplishments || [],
          nextSteps: data.nextSteps || [],
          blockers: data.blockers || [],
          branch: null,
          filesChanged: 0,
        }],
      });
    }
  }

  // Sort projects by most recent session time (descending)
  result.projects.sort((a, b) => {
    const aTime = a.sessions[a.sessions.length - 1]?.time || "";
    const bTime = b.sessions[b.sessions.length - 1]?.time || "";
    return bTime.localeCompare(aTime);
  });

  // Totals
  result.totals.projectsActive = result.projects.length;
  result.totals.sessionsTotal = result.projects.reduce((sum, p) => sum + p.sessions.length, 0);
  result.totals.accomplishmentsTotal = result.projects.reduce((sum, p) =>
    sum + p.sessions.reduce((s2, sess) => s2 + sess.accomplishments.length, 0), 0);

  return result;
}

export async function runAudit() {
  const timestamp = new Date().toISOString();
  const results = {
    timestamp,
    overall: "healthy",
    issueCount: 0,
    issues: [],
    checks: {
      settings: checkSettings(),
      plugins: checkPlugins(),
      sessionStates: checkSessionStates(),
      memoryDirs: checkMemoryDirs(),
      projects: checkProjects(),
      watchdog: checkWatchdog(),
      mcpConfigs: checkMcpConfigs(),
      obsidianHook: checkObsidianHook(),
    },
    summary: {},
  };

  // Collect all issues
  for (const [name, check] of Object.entries(results.checks)) {
    if (check.issues && check.issues.length > 0) {
      for (const issue of check.issues) {
        results.issues.push({ source: name, message: issue, severity: classifySeverity(name, issue) });
      }
    }
  }
  results.issueCount = results.issues.length;

  // Determine overall health
  const hasCritical = results.issues.some(i => i.severity === "critical");
  const hasWarning = results.issues.some(i => i.severity === "warning");
  results.overall = hasCritical ? "critical" : hasWarning ? "warning" : "healthy";

  // Build summary
  const p = results.checks.plugins;
  const ss = results.checks.sessionStates;
  const mem = results.checks.memoryDirs;
  const proj = results.checks.projects;
  results.summary = {
    projectCount: proj.projects.length,
    projectsWithClaudeMd: proj.projects.filter(p => p.hasClaudeMd).length,
    projectsWithMemory: proj.projects.filter(p => p.hasMemory).length,
    projectsWithSessionState: proj.projects.filter(p => p.hasSessionState).length,
    projectsWithMcp: proj.projects.filter(p => p.hasMcp).length,
    pluginsEnabled: p.enabled.length,
    pluginsDisabled: p.disabled.length,
    pluginsMissing: p.missing.length,
    sessionStatesTotal: ss.states.length,
    sessionStatesStale: ss.stale.length,
    memoryDirsTotal: mem.dirs.length,
    memoryDirsEmpty: mem.empty.length,
    watchdogHealthy: results.checks.watchdog.healthy,
    obsidianHookHealthy: results.checks.obsidianHook.healthy,
  };

  return results;
}

function classifySeverity(source, message) {
  if (message.includes("Cannot read") || message.includes("not found") || message.includes("Invalid JSON")) return "critical";
  if (message.includes("unhealthy") || message.includes("not running") || message.includes("not registered")) return "critical";
  if (message.includes("missing") || message.includes("Missing")) return "warning";
  if (message.includes("Stale") || message.includes("stale")) return "warning";
  if (message.includes("Duplicate") || message.includes("Empty")) return "info";
  if (message.includes("no project config")) return "info";
  return "info";
}

// === OBSIDIAN OUTPUT ===
function generateObsidianReport(results) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8);
  const badge = results.overall === "healthy" ? "HEALTHY" : results.overall === "warning" ? "WARNING" : "CRITICAL";
  const s = results.summary;

  const lines = [
    "---",
    `updated: ${date} ${time}`,
    "project: gawdclaude",
    "tags:",
    "  - claude-audit",
    "  - gawdclaude",
    "  - auto-generated",
    "---",
    "",
    `# God Claude Audit Report — ${date}`,
    "",
    `> Auto-generated at ${time}. Overall: **${badge}** | Issues: **${results.issueCount}**`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Projects | ${s.projectCount} |`,
    `| With CLAUDE.md | ${s.projectsWithClaudeMd} |`,
    `| With Memory | ${s.projectsWithMemory} |`,
    `| With Session State | ${s.projectsWithSessionState} |`,
    `| With MCP Config | ${s.projectsWithMcp} |`,
    `| Plugins Enabled | ${s.pluginsEnabled} |`,
    `| Plugins Disabled | ${s.pluginsDisabled} |`,
    `| Plugins Missing Cache | ${s.pluginsMissing} |`,
    `| Session States | ${s.sessionStatesTotal} (${s.sessionStatesStale} stale) |`,
    `| Memory Dirs | ${s.memoryDirsTotal} (${s.memoryDirsEmpty} empty) |`,
    `| Watchdog | ${s.watchdogHealthy ? "Running" : "DOWN"} |`,
    `| Obsidian Hook | ${s.obsidianHookHealthy ? "Healthy" : "BROKEN"} |`,
    "",
  ];

  if (results.issues.length > 0) {
    lines.push("## Issues");
    lines.push("");
    lines.push("| Severity | Source | Issue |");
    lines.push("|----------|--------|-------|");
    for (const issue of results.issues) {
      const icon = issue.severity === "critical" ? "RED" : issue.severity === "warning" ? "YELLOW" : "BLUE";
      lines.push(`| ${icon} | ${issue.source} | ${issue.message} |`);
    }
    lines.push("");
  }

  lines.push("## Project Inventory");
  lines.push("");
  lines.push("| Project | CLAUDE.md | Memory | Session | MCP |");
  lines.push("|---------|-----------|--------|---------|-----|");
  for (const proj of results.checks.projects.projects) {
    const cm = proj.hasClaudeMd ? "Yes" : "-";
    const mem = proj.hasMemory ? `${proj.memoryFiles} files` : "-";
    const ss = proj.hasSessionState ? "Yes" : "-";
    const mcp = proj.hasMcp ? "Yes" : "-";
    lines.push(`| ${proj.devName} | ${cm} | ${mem} | ${ss} | ${mcp} |`);
  }
  lines.push("");
  lines.push(`_Generated by GawdClaude audit engine — ${time}_`);
  lines.push("");

  return lines.join("\n");
}

export function writeToObsidian(results) {
  if (!VAULT_PROJECT_DIR) return false;

  mkdirSync(VAULT_PROJECT_DIR, { recursive: true });

  // Overwrite _audit.md
  const reportPath = join(VAULT_PROJECT_DIR, "_audit.md");
  writeFileSync(reportPath, generateObsidianReport(results), "utf-8");

  // Append to nightly log
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8);
  const logPath = join(VAULT_PROJECT_DIR, "_nightly-log.md");

  if (!fileExists(logPath)) {
    writeFileSync(logPath, [
      "---",
      `date: ${date}`,
      "project: gawdclaude",
      "tags:",
      "  - nightly-log",
      "---",
      "",
      "# GawdClaude Nightly Log",
      "",
      "",
    ].join("\n"), "utf-8");
  }

  const badge = results.overall === "healthy" ? "HEALTHY" : results.overall === "warning" ? "WARNING" : "CRITICAL";
  const entry = `## ${date} ${time} — ${badge} (${results.issueCount} issues)\n\n` +
    results.issues.map(i => `- [${i.severity}] ${i.source}: ${i.message}`).join("\n") +
    (results.issues.length === 0 ? "- No issues found" : "") +
    "\n\n---\n\n";

  appendFileSync(logPath, entry, "utf-8");
  return true;
}

// === FIXERS ===
export function applyFix(fixId) {
  switch (fixId) {
    case "stale-session-states": {
      const files = listFiles(SESSION_STATE_DIR).filter(f => f.endsWith(".json"));
      const removed = [];
      for (const f of files) {
        const age = fileAge(join(SESSION_STATE_DIR, f));
        if (age > STALE_THRESHOLD) {
          // Don't delete — just update the timestamp by touching the file
          const data = safeReadJSON(join(SESSION_STATE_DIR, f));
          if (!data._error) {
            data.updatedAt = new Date().toISOString();
            data._note = "Timestamp refreshed by GawdClaude audit";
            writeFileSync(join(SESSION_STATE_DIR, f), JSON.stringify(data, null, 2), "utf-8");
            removed.push(f);
          }
        }
      }
      return { fixed: true, message: `Refreshed ${removed.length} stale session-state files`, files: removed };
    }
    case "empty-memory-index": {
      const projectDirs = listDirs(PROJECTS_DIR);
      const fixed = [];
      for (const proj of projectDirs) {
        const memDir = join(PROJECTS_DIR, proj, "memory");
        if (!dirExists(memDir)) continue;
        const files = listFiles(memDir);
        if (files.length > 0 && !files.includes("MEMORY.md")) {
          const entries = files.filter(f => f !== "MEMORY.md").map(f => {
            const name = f.replace(".md", "");
            return `- [${name}](${f}) — auto-indexed by GawdClaude`;
          });
          writeFileSync(join(memDir, "MEMORY.md"), entries.join("\n") + "\n", "utf-8");
          fixed.push(proj);
        }
      }
      return { fixed: true, message: `Created MEMORY.md index for ${fixed.length} projects`, projects: fixed };
    }
    default:
      return { fixed: false, message: `Unknown fix: ${fixId}` };
  }
}

// === CLI ENTRY POINT ===
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("audit.mjs");
if (isMain) {
  const nightly = process.argv.includes("--nightly");

  runAudit().then(results => {
    console.log(JSON.stringify(results, null, 2));

    if (nightly) {
      const wrote = writeToObsidian(results);
      if (wrote) {
        console.error(`[nightly] Wrote audit report to Obsidian vault`);
      } else {
        console.error(`[nightly] Could not write to Obsidian vault (no config)`);
      }
    }
  }).catch(err => {
    console.error(`Audit failed: ${err.message}`);
    process.exit(1);
  });
}
