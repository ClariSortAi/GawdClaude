#!/usr/bin/env node

/**
 * GawdClaude Dashboard Server
 *
 * Zero-dependency HTTP server serving the audit dashboard and API.
 * Runs on port 6660.
 *
 * Routes:
 *   GET  /                     → Dashboard HTML
 *   GET  /api/status           → Latest audit results
 *   GET  /api/projects         → Project inventory
 *   GET  /api/watchdog         → Watchdog status
 *   GET  /api/today            → Today's activity across projects
 *   GET  /api/scores           → CLAUDE.md health scores
 *   GET  /api/config           → Non-sensitive config (vault name, ignore list)
 *   GET  /api/all-projects     → All projects with ignore status (manage UI)
 *   POST /api/audit            → Trigger fresh audit
 *   POST /api/heal/:project    → Heal a project's CLAUDE.md
 *   POST /api/ignore/:project  → Toggle project include/exclude
 *   POST /api/fix/:id          → Apply a fix
 */

import http from "http";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { runAudit, writeToObsidian, applyFix, userConfig, collectToday, listAllProjects } from "./audit.mjs";
import { scoreAll, healProject, scoreProject } from "./improve.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");
const PORT = userConfig.port || 6660;

// Read/write ignore list from config.json
function readIgnoreList() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return cfg.ignore || [];
  } catch { return []; }
}

function writeIgnoreList(list) {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  cfg.ignore = list;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}
const LOG_DIR = join(__dirname, ".remember", "logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = join(LOG_DIR, "server.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_PATH, line); } catch { /* non-fatal */ }
}

// Cache last audit result
let lastAudit = null;

// Initial audit on startup
runAudit().then(results => {
  lastAudit = results;
  log(`Initial audit complete: ${results.overall} (${results.issueCount} issues)`);
}).catch(err => log(`Initial audit failed: ${err.message}`));

// === REQUEST HANDLING ===
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;
  const path = url.pathname;

  // CORS headers for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // GET / — Dashboard
    if (method === "GET" && path === "/") {
      const html = readFileSync(join(__dirname, "dashboard.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // GET /api/status — Latest audit
    if (method === "GET" && path === "/api/status") {
      if (!lastAudit) {
        json(res, 503, { error: "Audit not yet complete" });
        return;
      }
      json(res, 200, lastAudit);
      return;
    }

    // GET /api/projects — Project list
    if (method === "GET" && path === "/api/projects") {
      if (!lastAudit) {
        json(res, 503, { error: "Audit not yet complete" });
        return;
      }
      json(res, 200, lastAudit.checks.projects);
      return;
    }

    // GET /api/watchdog — Watchdog status
    if (method === "GET" && path === "/api/watchdog") {
      if (!lastAudit) {
        json(res, 503, { error: "Audit not yet complete" });
        return;
      }
      json(res, 200, lastAudit.checks.watchdog);
      return;
    }

    // POST /api/audit — Trigger fresh audit
    if (method === "POST" && path === "/api/audit") {
      log("Manual audit triggered");
      const results = await runAudit();
      lastAudit = results;
      writeToObsidian(results);
      log(`Audit complete: ${results.overall} (${results.issueCount} issues)`);
      json(res, 200, results);
      return;
    }

    // GET /api/today — What we got done today
    if (method === "GET" && path === "/api/today") {
      const dateParam = url.searchParams.get("date") || undefined;
      const today = collectToday(dateParam);
      json(res, 200, today);
      return;
    }

    // GET /api/scores — CLAUDE.md health scores
    if (method === "GET" && path === "/api/scores") {
      const scores = scoreAll();
      json(res, 200, scores);
      return;
    }

    // POST /api/heal/:project — Heal a single project's CLAUDE.md
    if (method === "POST" && path.startsWith("/api/heal/")) {
      const projectName = decodeURIComponent(path.replace("/api/heal/", ""));
      log(`Heal requested: ${projectName}`);

      // Find and score the project
      const scores = scoreAll();
      const project = scores.find(s => s.name === projectName);
      if (!project) {
        json(res, 404, { error: `Project not found: ${projectName}` });
        return;
      }

      const result = healProject(project);
      log(`Heal result: ${projectName} ${result.success ? result.oldScore + "→" + result.newScore : "FAILED"}`);
      json(res, 200, result);
      return;
    }

    // GET /api/config — Non-sensitive config for dashboard
    if (method === "GET" && path === "/api/config") {
      json(res, 200, {
        obsidianVault: userConfig.obsidian?.vaultRoot ? basename(userConfig.obsidian.vaultRoot) : null,
        ignore: readIgnoreList(),
      });
      return;
    }

    // GET /api/ignore — List ignored projects
    if (method === "GET" && path === "/api/ignore") {
      json(res, 200, { ignore: readIgnoreList() });
      return;
    }

    // POST /api/ignore/:project — Toggle ignore for a project
    if (method === "POST" && path.startsWith("/api/ignore/")) {
      const projectName = decodeURIComponent(path.replace("/api/ignore/", ""));
      const list = readIgnoreList();
      const idx = list.findIndex(n => n.toLowerCase() === projectName.toLowerCase());
      if (idx >= 0) {
        list.splice(idx, 1);
        writeIgnoreList(list);
        log(`Unignored: ${projectName}`);
        json(res, 200, { action: "removed", project: projectName, ignore: list });
      } else {
        list.push(projectName);
        writeIgnoreList(list);
        log(`Ignored: ${projectName}`);
        json(res, 200, { action: "added", project: projectName, ignore: list });
      }
      // Re-run audit in background so next /api/status reflects the change
      runAudit().then(r => { lastAudit = r; }).catch(() => {});
      return;
    }

    // GET /api/all-projects — All projects with ignore status (for manage UI)
    if (method === "GET" && path === "/api/all-projects") {
      const projects = listAllProjects();
      json(res, 200, { projects, ignore: readIgnoreList() });
      return;
    }

    // POST /api/fix/:id — Apply a fix
    if (method === "POST" && path.startsWith("/api/fix/")) {
      const fixId = path.replace("/api/fix/", "");
      log(`Fix requested: ${fixId}`);
      const result = applyFix(fixId);
      log(`Fix result: ${JSON.stringify(result)}`);

      // Re-run audit after fix
      if (result.fixed) {
        lastAudit = await runAudit();
        writeToObsidian(lastAudit);
      }
      json(res, 200, result);
      return;
    }

    // 404
    json(res, 404, { error: "Not found" });

  } catch (err) {
    log(`Error handling ${method} ${path}: ${err.message}`);
    json(res, 500, { error: err.message });
  }
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// === START SERVER ===
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  log(`GawdClaude dashboard running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", () => { log("Shutting down"); server.close(); process.exit(0); });
process.on("SIGTERM", () => { log("Shutting down"); server.close(); process.exit(0); });
