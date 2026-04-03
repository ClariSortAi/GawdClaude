#!/usr/bin/env node

/**
 * GawdClaude CLAUDE.md Healing Loop
 *
 * Scores every project's CLAUDE.md for content quality relative to
 * project complexity, then heals below-threshold projects by spawning
 * headless Claude Code with the /revise-claude-md skill or generating
 * new CLAUDE.md files.
 *
 * Usage:
 *   node improve.mjs                     → score all, heal below threshold
 *   node improve.mjs --score-only        → just print scores
 *   node improve.mjs --project crypto    → score + heal one project
 *   node improve.mjs --threshold 40      → override default threshold (60)
 *
 * Programmatic:
 *   import { scoreAll, healProject } from './improve.mjs'
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync, mkdirSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { execFileSync, execSync } from "child_process";

// === CONFIG ===
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");

let userConfig = {};
try { userConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch {}

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const DEV_DIR = userConfig.devDir || (process.platform === "win32" ? "C:\\Dev" : join(HOME, "dev"));

// Obsidian config
let obsidianConfig = null;
if (userConfig.obsidian?.vaultRoot) {
  obsidianConfig = userConfig.obsidian;
} else {
  try { obsidianConfig = JSON.parse(readFileSync(join(CLAUDE_DIR, "obsidian-hook-config.json"), "utf-8")); } catch {}
}
const VAULT_ROOT = obsidianConfig?.vaultRoot || null;
const VAULT_PROJECT_DIR = VAULT_ROOT ? join(VAULT_ROOT, obsidianConfig?.subfolder || "Projects", "gawdclaude") : null;

const DEFAULT_THRESHOLD = 60;
const IGNORE_DIRS = new Set([".git", "node_modules", ".next", "__pycache__", ".turbo", "dist", "build", ".venv", "venv", ".remember", ".claude"]);
const USER_IGNORE = new Set((userConfig.ignore || []).map(s => s.toLowerCase()));

// Heuristic: is this directory a real project worth scanning?
// Requires at least one of: git repo, package manifest, or 3+ non-hidden files
function isRealProject(dirPath, dirName) {
  if (USER_IGNORE.has(dirName.toLowerCase())) return false;
  if (dirName.startsWith(".")) return false;
  if (dirExists(join(dirPath, ".git"))) return true;
  const manifests = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "setup.py", "requirements.txt", "composer.json", "Gemfile", "pom.xml", "build.gradle"];
  for (const m of manifests) { if (fileExists(join(dirPath, m))) return true; }
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true }).filter(e => !e.name.startsWith("."));
    return entries.length >= 3;
  } catch { return false; }
}

// Resolve claude CLI — on Windows we need claude.cmd for execFileSync
function findClaude() {
  try {
    const out = execSync(process.platform === "win32" ? "where claude" : "which claude", { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    // On Windows, prefer the .cmd variant
    const lines = out.split(/\r?\n/);
    return lines.find(l => l.endsWith(".cmd")) || lines[0];
  } catch { return "claude"; }
}
const CLAUDE_BIN = findClaude();

// === HELPERS ===
function dirExists(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function fileExists(p) { try { return statSync(p).isFile(); } catch { return false; } }

function countFiles(dir, depth = 0, max = 200) {
  if (depth > 3) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      if (entry.isFile()) {
        count++;
      } else if (entry.isDirectory()) {
        count += countFiles(join(dir, entry.name), depth + 1, max - count);
      }
      if (count >= max) return max;
    }
  } catch {}
  return count;
}

// If the root dir has no project markers, check one level deep for nested projects
// Handles patterns like VMi2_o/VMi2_o/ or myapp/src/
function findProjectRoot(dir) {
  const markers = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "CLAUDE.md"];
  if (markers.some(m => fileExists(join(dir, m)))) return dir;
  try {
    const subdirs = readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && !IGNORE_DIRS.has(d.name));
    for (const sub of subdirs) {
      const subPath = join(dir, sub.name);
      if (markers.some(m => fileExists(join(subPath, m)))) return subPath;
    }
  } catch {}
  return dir;
}

function detectStack(projectDir) {
  const indicators = [];

  // Node/JS
  if (fileExists(join(projectDir, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps["next"]) indicators.push("Next.js");
      else if (allDeps["react"]) indicators.push("React");
      if (allDeps["express"]) indicators.push("Express");
      if (allDeps["drizzle-orm"] || allDeps["prisma"]) indicators.push("ORM");
      if (allDeps["tailwindcss"]) indicators.push("Tailwind");
      if (allDeps["typescript"]) indicators.push("TypeScript");
      if (!indicators.some(i => ["Next.js", "React", "Express"].includes(i))) indicators.push("Node.js");
    } catch { indicators.push("Node.js"); }
  }

  // Python
  if (fileExists(join(projectDir, "pyproject.toml")) || fileExists(join(projectDir, "requirements.txt")) || fileExists(join(projectDir, "setup.py"))) {
    indicators.push("Python");
    if (fileExists(join(projectDir, "manage.py"))) indicators.push("Django");
  }

  // Go
  if (fileExists(join(projectDir, "go.mod"))) indicators.push("Go");

  // Rust
  if (fileExists(join(projectDir, "Cargo.toml"))) indicators.push("Rust");

  // Salesforce
  if (dirExists(join(projectDir, "force-app"))) indicators.push("Salesforce");

  // Static HTML
  if (indicators.length === 0 && fileExists(join(projectDir, "index.html"))) indicators.push("HTML/Static");

  return indicators;
}

function getLastCommitDate(projectDir) {
  try {
    const out = execSync("git log -1 --format=%aI", { cwd: projectDir, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    return new Date(out);
  } catch { return null; }
}

function getClaudeMdAge(projectDir) {
  const claudeMdPath = join(projectDir, "CLAUDE.md");
  if (!fileExists(claudeMdPath)) return null;
  try { return new Date(statSync(claudeMdPath).mtimeMs); } catch { return null; }
}

// === SCORING ===

function scoreClaudeMd(content, complexity, stack) {
  let score = 0;
  const findings = [];

  if (!content) {
    return { score: 0, findings: ["No CLAUDE.md exists"], sections: {} };
  }

  const lines = content.split("\n");
  const lower = content.toLowerCase();
  const length = lines.length;

  // Section detection
  const sections = {
    whatThisIs: /^#+\s*(what this is|what this|overview|about)/im.test(content) || /^#\s+\w/m.test(content),
    projectStructure: /^#+\s*(project structure|structure|file structure|architecture)/im.test(content) || content.includes("```\n") && (content.includes("├──") || content.includes("|--")),
    conventions: /^#+\s*(conventions|key conventions|code style|style guide)/im.test(content),
    howToRun: /^#+\s*(how to|quick start|getting started|setup|running|development)/im.test(content) || /npm run|python|cargo|go run/i.test(content),
    testing: /^#+\s*(test|testing)/im.test(content) || /npm test|pytest|cargo test|go test/i.test(content),
    safety: /^#+\s*(safety|security|rules|important|warning|critical)/im.test(content),
    deployment: /^#+\s*(deploy|deployment|aws|docker|ci\/cd)/im.test(content),
  };

  // Base score: has content at all
  if (length >= 3) score += 10;
  if (length >= 10) score += 5;
  if (length >= 30) score += 5;

  // Section scores — weighted by complexity
  if (sections.whatThisIs) score += 15; else findings.push("Missing: what this project is");
  if (sections.projectStructure) score += 15; else if (complexity !== "simple") findings.push("Missing: project structure");
  if (sections.conventions) score += 10; else if (complexity !== "simple") findings.push("Missing: key conventions");
  if (sections.howToRun) score += 15; else findings.push("Missing: how to run/setup");
  if (sections.testing) score += 5; else if (complexity === "complex") findings.push("Missing: testing instructions");

  // Complexity-scaled bonuses
  if (complexity === "complex") {
    if (sections.safety) score += 10;
    if (sections.deployment) score += 5;
    if (length >= 50) score += 5;
    if (length >= 100) score += 5;
  } else if (complexity === "medium") {
    if (length >= 20) score += 10;
  } else {
    // Simple projects get a length bonus easier
    if (length >= 10) score += 10;
  }

  // Stack mention bonus — does CLAUDE.md acknowledge the actual stack?
  for (const tech of stack) {
    if (lower.includes(tech.toLowerCase())) {
      score += 2;
      break; // one match is enough
    }
  }

  // Cap at 100
  score = Math.min(score, 100);

  return { score, findings, sections };
}

export function scoreProject(projectDir) {
  const name = basename(projectDir);
  const fileCount = countFiles(projectDir);
  const complexity = fileCount < 10 ? "simple" : fileCount < 50 ? "medium" : "complex";
  const effectiveRoot = findProjectRoot(projectDir);
  const stack = detectStack(effectiveRoot);
  const lastCommit = getLastCommitDate(projectDir);
  const claudeMdDate = getClaudeMdAge(effectiveRoot);

  // Check for CLAUDE.md at project root first, then effective root (nested project)
  let claudeMdPath = join(projectDir, "CLAUDE.md");
  let content = null;
  try { content = readFileSync(claudeMdPath, "utf-8"); } catch {}
  if (!content && effectiveRoot !== projectDir) {
    claudeMdPath = join(effectiveRoot, "CLAUDE.md");
    try { content = readFileSync(claudeMdPath, "utf-8"); } catch {}
  }

  const { score, findings, sections } = scoreClaudeMd(content, complexity, stack);

  // Freshness penalty: if CLAUDE.md is >30 days older than last commit, dock points
  let freshnessPenalty = 0;
  if (content && lastCommit && claudeMdDate) {
    const gap = lastCommit.getTime() - claudeMdDate.getTime();
    if (gap > 30 * 86400000) {
      freshnessPenalty = 10;
      findings.push(`Stale: CLAUDE.md is ${Math.floor(gap / 86400000)} days older than last commit`);
    }
  }

  const finalScore = Math.max(0, score - freshnessPenalty);

  return {
    name,
    path: projectDir,
    effectiveRoot: effectiveRoot !== projectDir ? effectiveRoot : undefined,
    hasClaudeMd: !!content,
    claudeMdLines: content ? content.split("\n").length : 0,
    fileCount,
    complexity,
    stack,
    score: finalScore,
    findings,
    sections,
    lastCommit: lastCommit?.toISOString() || null,
    claudeMdDate: claudeMdDate?.toISOString() || null,
  };
}

export function scoreAll() {
  const results = [];
  try {
    const dirs = readdirSync(DEV_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      const projectDir = join(DEV_DIR, d.name);
      if (!isRealProject(projectDir, d.name)) continue;
      results.push(scoreProject(projectDir));
    }
  } catch (err) {
    console.error(`Cannot read ${DEV_DIR}: ${err.message}`);
  }
  results.sort((a, b) => a.score - b.score);
  return results;
}

// === HEALING ===

export function healProject(projectResult) {
  const { name, path: projectDir, effectiveRoot, hasClaudeMd, score, findings, sections, complexity, stack } = projectResult;
  const healDir = effectiveRoot || projectDir;
  const startTime = Date.now();

  let action, prompt;
  if (hasClaudeMd) {
    action = "improve";
    // Build a targeted prompt that tells Claude exactly what's missing
    const missing = findings.filter(f => f.startsWith("Missing:")).map(f => f.replace("Missing: ", ""));
    if (missing.length > 0) {
      prompt = [
        "Read the existing CLAUDE.md in this project and improve it.",
        `This is a ${complexity} project (${stack.join(", ") || "unknown stack"}).`,
        `The following sections are missing or inadequate: ${missing.join(", ")}.`,
        "Analyze the actual codebase to fill in these gaps with accurate, project-specific content.",
        "Edit the existing CLAUDE.md directly — add the missing sections, keep existing good content.",
        "Do not add generic boilerplate. Every line should be specific to this project.",
      ].join(" ");
    } else {
      prompt = "/revise-claude-md";
    }
  } else {
    action = "generate";
    prompt = [
      "Analyze this project's codebase — file structure, stack, entry points, config files, conventions.",
      "Then generate a comprehensive CLAUDE.md that covers: what this project is, project structure,",
      "key conventions, how to run/test, and any safety or deployment notes if relevant.",
      "Write the file directly to ./CLAUDE.md. Be specific to this project, not generic.",
    ].join(" ");
  }

  try {
    // Build command — shell: true needed on Windows for .cmd files
    const escapedPrompt = prompt.replace(/"/g, '\\"');
    const cmd = `"${CLAUDE_BIN}" -p "${escapedPrompt}" --dangerously-skip-permissions --model sonnet`;
    const result = execSync(cmd, {
      cwd: healDir,
      encoding: "utf-8",
      timeout: 120000, // 2 min max per project
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Re-score after healing
    const newResult = scoreProject(projectDir);

    return {
      success: true,
      project: name,
      action,
      oldScore: score,
      newScore: newResult.score,
      delta: newResult.newScore - score,
      elapsed: `${elapsed}s`,
      output: result.slice(0, 500), // truncate for logging
    };
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return {
      success: false,
      project: name,
      action,
      oldScore: score,
      error: err.message?.slice(0, 200) || "Unknown error",
      elapsed: `${elapsed}s`,
    };
  }
}

export async function healAll(threshold = DEFAULT_THRESHOLD) {
  const scores = scoreAll();
  const toHeal = scores.filter(s => s.score < threshold);
  const results = [];

  console.log(`Scoring complete: ${scores.length} projects, ${toHeal.length} below threshold (${threshold})`);

  for (const project of toHeal) {
    console.log(`  Healing: ${project.name} (score: ${project.score}, ${project.hasClaudeMd ? "improve" : "generate"})...`);
    const result = healProject(project);
    results.push(result);
    if (result.success) {
      console.log(`    Done: ${result.oldScore} → ${result.newScore} (${result.elapsed})`);
    } else {
      console.log(`    Failed: ${result.error} (${result.elapsed})`);
    }
  }

  return { scores, healed: results, threshold, timestamp: new Date().toISOString() };
}

// === OBSIDIAN LOGGING ===

function logToObsidian(healResults) {
  if (!VAULT_PROJECT_DIR) return;
  mkdirSync(VAULT_PROJECT_DIR, { recursive: true });

  const logPath = join(VAULT_PROJECT_DIR, "_nightly-log.md");
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8);

  const healed = healResults.healed;
  const improved = healed.filter(h => h.success && h.action === "improve");
  const generated = healed.filter(h => h.success && h.action === "generate");
  const failed = healed.filter(h => !h.success);

  let entry = `### CLAUDE.md Healing — ${time}\n\n`;
  entry += `Threshold: ${healResults.threshold} | Healed: ${healed.length} | Improved: ${improved.length} | Generated: ${generated.length} | Failed: ${failed.length}\n\n`;

  if (improved.length > 0) {
    entry += "**Improved:**\n";
    for (const h of improved) entry += `- ${h.project}: ${h.oldScore} → ${h.newScore} (${h.elapsed})\n`;
    entry += "\n";
  }
  if (generated.length > 0) {
    entry += "**Generated:**\n";
    for (const h of generated) entry += `- ${h.project}: 0 → ${h.newScore} (${h.elapsed})\n`;
    entry += "\n";
  }
  if (failed.length > 0) {
    entry += "**Failed:**\n";
    for (const h of failed) entry += `- ${h.project}: ${h.error}\n`;
    entry += "\n";
  }
  entry += "\n";

  appendFileSync(logPath, entry, "utf-8");
}

// === CLI ===
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("improve.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const scoreOnly = args.includes("--score-only");
  const projectFlag = args.indexOf("--project");
  const thresholdFlag = args.indexOf("--threshold");
  const singleProject = projectFlag !== -1 ? args[projectFlag + 1] : null;
  const threshold = thresholdFlag !== -1 ? parseInt(args[thresholdFlag + 1], 10) : DEFAULT_THRESHOLD;

  if (singleProject) {
    // Single project mode
    const projectDir = join(DEV_DIR, singleProject);
    if (!dirExists(projectDir)) {
      console.error(`Project not found: ${projectDir}`);
      process.exit(1);
    }
    const result = scoreProject(projectDir);
    console.log(`${result.name}: score=${result.score} complexity=${result.complexity} stack=[${result.stack.join(", ")}] files=${result.fileCount} claudeMd=${result.hasClaudeMd ? result.claudeMdLines + " lines" : "MISSING"}`);
    if (result.findings.length > 0) {
      for (const f of result.findings) console.log(`  - ${f}`);
    }
    if (!scoreOnly && result.score < threshold) {
      console.log(`\nHealing ${result.name}...`);
      const healResult = healProject(result);
      if (healResult.success) {
        console.log(`Done: ${healResult.oldScore} → ${healResult.newScore} (${healResult.elapsed})`);
      } else {
        console.log(`Failed: ${healResult.error}`);
      }
    } else if (result.score >= threshold) {
      console.log(`\nScore ${result.score} >= threshold ${threshold}. No healing needed.`);
    }
  } else {
    // All projects
    const scores = scoreAll();
    console.log(`\nCLAUDE.md Health Scores (${scores.length} projects)\n`);
    console.log("Score | Complexity | Files | CLAUDE.md | Project");
    console.log("------|------------|-------|-----------|--------");
    for (const s of scores) {
      const bar = s.score >= 60 ? "OK" : s.score >= 30 ? "LOW" : "CRIT";
      const md = s.hasClaudeMd ? `${s.claudeMdLines}L` : "NONE";
      console.log(`  ${String(s.score).padStart(3)} | ${s.complexity.padEnd(10)} | ${String(s.fileCount).padStart(5)} | ${md.padStart(9)} | ${s.name}`);
    }

    const belowThreshold = scores.filter(s => s.score < threshold);
    console.log(`\n${belowThreshold.length} of ${scores.length} projects below threshold (${threshold})`);

    if (!scoreOnly && belowThreshold.length > 0) {
      console.log(`\nStarting healing loop...\n`);
      const results = await healAll(threshold);
      logToObsidian(results);
      console.log(`\nHealing complete. ${results.healed.filter(h => h.success).length} succeeded, ${results.healed.filter(h => !h.success).length} failed.`);
    }
  }
}
