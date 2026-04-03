#!/usr/bin/env node

/**
 * GawdClaude Dashboard Server
 *
 * Zero-dependency HTTP server serving the audit dashboard and API.
 * Runs on port 6660.
 *
 * Routes:
 *   GET  /              → Dashboard HTML
 *   GET  /api/status    → Latest audit results
 *   GET  /api/projects  → Project inventory
 *   GET  /api/watchdog  → Watchdog status
 *   POST /api/audit     → Trigger fresh audit
 *   POST /api/fix/:id   → Apply a fix
 */

import http from "http";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runAudit, writeToObsidian, applyFix, userConfig } from "./audit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = userConfig.port || 6660;
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
