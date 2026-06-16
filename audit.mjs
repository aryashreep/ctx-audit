#!/usr/bin/env node
/**
 * ctx-audit — checks whether a repo's persistent context files
 * (AGENTS.md, memory.md, architecture map) exist and are current,
 * and estimates the token cost of having them vs. not.
 *
 * Usage:
 *   node scripts/audit.mjs              human-readable report
 *   node scripts/audit.mjs --json       machine-readable report
 *   node scripts/audit.mjs --strict     exit 1 on any failure (for CI)
 */

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// ---- config: the files this repo is expected to maintain ----
const CONFIG = [
  { id: "agents", file: "AGENTS.md", label: "Agent instructions", maxTokens: 1500, required: true },
  { id: "memory", file: "memory.md", label: "Decision / memory log", maxTokens: 2500, required: true },
  { id: "graph", file: ".agent/graph.md", label: "Architecture map", maxTokens: 2000, required: false },
];

// directories treated as "real source" when measuring staleness / baseline cost
const SOURCE_DIRS = ["src", "lib", "app"];
const STALE_COMMIT_THRESHOLD = 5;
const BASELINE_FILE_CAP = 200; // cap how many source files we tokenize for the baseline estimate

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function estimateTokens(text) {
  // Rough heuristic: ~4 chars/token for English text and most source code.
  // Swap in a real tokenizer (tiktoken, or Anthropic's count_tokens endpoint)
  // for production-grade accuracy — this is meant to be directionally useful.
  return Math.ceil(text.length / 4);
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}

function existingSourceDirs() {
  return SOURCE_DIRS.filter((d) => existsSync(d));
}

function commitsSince(sha, dirs) {
  if (!sha || dirs.length === 0) return null;
  const out = sh(`git rev-list --count ${sha}..HEAD -- ${dirs.join(" ")}`);
  if (out === null || out === "") return null;
  const n = parseInt(out, 10);
  return Number.isNaN(n) ? null : n;
}

function checkFile(entry) {
  const result = { ...entry, exists: false, tokens: 0, stale: null, commitsSinceSync: null, issues: [] };

  if (!existsSync(entry.file)) {
    result.issues.push(entry.required ? "missing (required)" : "missing (optional)");
    return result;
  }

  result.exists = true;
  const text = readFileSync(entry.file, "utf8");
  result.tokens = estimateTokens(text);

  if (result.tokens > entry.maxTokens) {
    result.issues.push(`over budget: ~${result.tokens} tokens > ${entry.maxTokens} limit`);
  }

  const fm = parseFrontmatter(text);
  const sha = fm.last_synced_commit;

  if (!sha) {
    result.issues.push("no last_synced_commit in frontmatter — staleness unknown");
  } else {
    const dirs = existingSourceDirs();
    const count = commitsSince(sha, dirs);
    result.commitsSinceSync = count;
    if (count === null) {
      result.issues.push(`could not resolve commit "${sha}" (shallow clone? bad sha?)`);
    } else if (count > STALE_COMMIT_THRESHOLD) {
      result.stale = true;
      result.issues.push(`stale: ${count} source commits since last sync (threshold ${STALE_COMMIT_THRESHOLD})`);
    } else {
      result.stale = false;
    }
  }

  return result;
}

function estimateBaselineWithoutContext() {
  // Crude baseline: what would it cost to re-derive context by reading the
  // tracked source tree directly, with no curated files at all.
  const dirs = existingSourceDirs();
  if (dirs.length === 0) return null;

  const tree = sh(`git ls-files ${dirs.join(" ")}`);
  if (!tree) return null;

  const files = tree.split("\n").filter(Boolean).slice(0, BASELINE_FILE_CAP);
  let total = 0;
  for (const f of files) {
    try {
      total += estimateTokens(readFileSync(f, "utf8"));
    } catch {
      // unreadable/binary file, skip
    }
  }
  return total;
}

function buildReport() {
  const checks = CONFIG.map(checkFile);
  const curatedTokens = checks.reduce((sum, r) => sum + r.tokens, 0);
  const baselineTokens = estimateBaselineWithoutContext();
  const hasFailure = checks.some((r) => (r.required && !r.exists) || r.stale === true);

  return {
    checks,
    curatedTokens,
    baselineTokens,
    estimatedSavingsPct: baselineTokens ? Math.round((1 - curatedTokens / baselineTokens) * 100) : null,
    pass: !hasFailure,
  };
}

function printText(report) {
  console.log("Context Audit");
  console.log("=".repeat(40));
  for (const r of report.checks) {
    const status = !r.exists ? (r.required ? "MISSING " : "absent  ") : r.stale ? "STALE   " : "OK      ";
    console.log(`[${status}] ${r.file}  (~${r.tokens} tok)`);
    for (const issue of r.issues) console.log(`           - ${issue}`);
  }
  console.log("-".repeat(40));
  console.log(`Curated context cost:  ~${report.curatedTokens} tokens`);
  if (report.baselineTokens) {
    console.log(`Baseline w/o context:  ~${report.baselineTokens} tokens`);
    console.log(`Estimated savings:     ~${report.estimatedSavingsPct}%`);
  } else {
    console.log("Baseline w/o context:  n/a (no source dirs found to estimate against)");
  }
  console.log(report.pass ? "\nResult: PASS" : "\nResult: FAIL");
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const strict = args.includes("--strict");

  const report = buildReport();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }

  if (strict && !report.pass) process.exit(1);
}

main();
