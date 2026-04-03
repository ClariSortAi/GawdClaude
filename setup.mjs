#!/usr/bin/env node

/**
 * GawdClaude Setup
 *
 * Interactive setup that writes a config.json with user-specific paths.
 * Run once after cloning:
 *
 *   node setup.mjs
 *
 * Detects what it can, asks for the rest via stdin prompts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");
const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");

const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(question, defaultVal) {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  return new Promise(resolve => {
    rl.question(`${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

console.log("");
console.log("  GawdClaude Setup");
console.log("  ================");
console.log("");

// --- Detect existing state ---
const hasClaudeDir = existsSync(CLAUDE_DIR);
const hasSettings = existsSync(join(CLAUDE_DIR, "settings.json"));
const obsidianConfigPath = join(CLAUDE_DIR, "obsidian-hook-config.json");
let obsidianConfig = null;
try { obsidianConfig = JSON.parse(readFileSync(obsidianConfigPath, "utf-8")); } catch {}

if (!hasClaudeDir) {
  console.log("  WARNING: ~/.claude directory not found.");
  console.log("  Claude Code may not be installed. Install it first:");
  console.log("  https://docs.anthropic.com/en/docs/claude-code/overview");
  console.log("");
}

if (hasSettings) {
  console.log("  Detected: ~/.claude/settings.json");
}
if (obsidianConfig?.vaultRoot) {
  console.log(`  Detected: Obsidian vault at ${obsidianConfig.vaultRoot}`);
}
console.log("");

// --- Gather config ---
const devDir = await ask("Projects directory (where your code repos live)", process.platform === "win32" ? "C:\\Dev" : join(HOME, "dev"));
const port = await ask("Dashboard port", "6660");

let vaultRoot = "";
let vaultSubfolder = "";
if (obsidianConfig?.vaultRoot) {
  const useExisting = await ask(`Use detected Obsidian vault? (${obsidianConfig.vaultRoot}) [Y/n]`, "Y");
  if (useExisting.toLowerCase() !== "n") {
    vaultRoot = obsidianConfig.vaultRoot;
    vaultSubfolder = obsidianConfig.subfolder || "Projects";
  }
}
if (!vaultRoot) {
  vaultRoot = await ask("Obsidian vault path (leave blank to skip Obsidian integration)", "");
  if (vaultRoot) {
    vaultSubfolder = await ask("Vault subfolder for project notes", "Projects");
  }
}

const config = {
  devDir,
  port: parseInt(port, 10),
  obsidian: vaultRoot ? { vaultRoot, subfolder: vaultSubfolder } : null,
  createdAt: new Date().toISOString(),
};

// --- Write config ---
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
console.log("");
console.log(`  Config written to ${CONFIG_PATH}`);
console.log("");
console.log("  " + JSON.stringify(config, null, 2).split("\n").join("\n  "));
console.log("");

// --- Create log directory ---
const logDir = join(__dirname, ".remember", "logs");
mkdirSync(logDir, { recursive: true });

console.log("  Setup complete. Next steps:");
console.log("");
console.log("    node audit.mjs              # Run a health check");
console.log("    node audit.mjs --nightly    # Health check + write to Obsidian");
console.log("    node server.mjs             # Start dashboard at http://localhost:" + config.port);
console.log("");

rl.close();
