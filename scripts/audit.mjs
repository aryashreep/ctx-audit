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
 *   node scripts/audit.mjs --ci         alias for --strict --json
 *   node scripts/audit.mjs --init       print scaffolding templates to stdout
 *   node scripts/audit.mjs --help       show usage and exit
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename } from "node:path";

// ---- defaults ----
const DEFAULT_FILES = [
  { id: "agents", file: "AGENTS.md", label: "Agent instructions", maxTokens: 1500, required: true },
  { id: "memory", file: "memory.md", label: "Decision / memory log", maxTokens: 2500, required: true },
  { id: "graph", file: ".agent/graph.md", label: "Architecture map", maxTokens: 2000, required: false },
];

const DEFAULT_SOURCE_DIRS = ["src", "lib", "app"];
const DEFAULT_STALE_THRESHOLD = 5;
const DEFAULT_BASELINE_FILE_CAP = 200;

// ---- argument parsing ----
function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    strict: argv.includes("--strict"),
    ci: argv.includes("--ci"),
    init: argv.includes("--init"),
    help: argv.includes("--help"),
  };
}

// ---- config resolution ----
function resolveConfig(overrides = {}) {
  let fileConfig = {};
  try {
    const raw = readFileSync(".ctx-audit.json", "utf8");
    fileConfig = JSON.parse(raw);
  } catch {
    // no config file or invalid JSON — use defaults
  }

  // files: config replaces entirely (not merge), then overrides can replace again
  const files = overrides.files || fileConfig.files || DEFAULT_FILES;

  // sourceDirs: config > auto-detect > fallback
  let sourceDirs;
  if (overrides.sourceDirs) {
    sourceDirs = overrides.sourceDirs;
  } else if (fileConfig.sourceDirs) {
    sourceDirs = fileConfig.sourceDirs;
  } else {
    sourceDirs = autoDetectSourceDirs();
  }

  const staleThreshold = overrides.staleThreshold ?? fileConfig.staleThreshold ?? DEFAULT_STALE_THRESHOLD;
  const baselineFileCap = overrides.baselineFileCap ?? fileConfig.baselineFileCap ?? DEFAULT_BASELINE_FILE_CAP;

  return { files, sourceDirs, staleThreshold, baselineFileCap };
}

// ---- auto-detect source dirs ----
function autoDetectSourceDirs() {
  const skipDirs = new Set(["node_modules", "dist", "build", "coverage", ".git", ".github", ".vscode", ".idea"]);
  const skipPatterns = [/^\./, /\./]; // dot-dirs and files with extensions (config files at root)

  const tree = sh("git ls-files");
  if (!tree) return DEFAULT_SOURCE_DIRS.filter((d) => existsSync(d));

  const counts = {};
  for (const f of tree.split("\n").filter(Boolean)) {
    const top = f.split("/")[0];
    if (top === f) continue; // root-level file, skip
    if (skipDirs.has(top)) continue;
    if (top.startsWith(".")) continue;
    counts[top] = (counts[top] || 0) + 1;
  }

  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([dir]) => dir);

  if (sorted.length === 0) {
    return DEFAULT_SOURCE_DIRS.filter((d) => existsSync(d));
  }

  return sorted;
}

// ---- shell helper ----
function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

// ---- token estimation ----
function estimateTokens(text) {
  // ~3.5 chars/token for mixed code+prose (better accuracy than chars/4)
  return Math.ceil(text.length / 3.5);
}

// ---- frontmatter parsing ----
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

// ---- strip frontmatter to get body ----
function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

// ---- source dirs filtering ----
function existingSourceDirs(config) {
  return config.sourceDirs.filter((d) => existsSync(d));
}

// ---- commit counting ----
function commitsSince(sha, dirs) {
  if (!sha || dirs.length === 0) return null;
  const out = sh(`git rev-list --count ${sha}..HEAD -- ${dirs.join(" ")}`);
  if (out === null || out === "") return null;
  const n = parseInt(out, 10);
  return Number.isNaN(n) ? null : n;
}

// ---- graduated staleness ----
function graduateStaleness(commitCount, threshold) {
  if (commitCount === null) return { level: null, stale: null };
  const half = threshold * 0.5;
  const double = threshold * 2;

  if (commitCount <= half) return { level: "fresh", stale: false };
  if (commitCount <= threshold) return { level: "possibly-stale", stale: false };
  if (commitCount <= double) return { level: "likely-stale", stale: true };
  return { level: "stale", stale: true };
}

const STALENESS_DISPLAY = {
  fresh: "[FRESH   ]",
  "possibly-stale": "[STALE?  ]",
  "likely-stale": "[STALE!  ]",
  stale: "[STALE   ]",
};

// ---- dead reference detection ----
function detectDeadReferences(text) {
  const body = stripFrontmatter(text);
  const warnings = [];

  // Match backtick-quoted paths: `some/path.ext` or `dir/file`
  const backtickPaths = body.matchAll(/`([a-zA-Z0-9_./-]+\/[a-zA-Z0-9_./-]+)`/g);
  for (const m of backtickPaths) {
    const p = m[1];
    if (!existsSync(p)) {
      warnings.push(`dead reference: \`${p}\` not found`);
    }
  }

  // Match bare dir/file.ext patterns (must have an extension)
  const barePaths = body.matchAll(/(?<![`\/])(?:^|[\s(])([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.\/-]+\.[a-zA-Z]{1,10})(?=[)\s,;:]|$)/gm);
  for (const m of barePaths) {
    const p = m[1];
    // Skip URLs and already-caught backtick paths
    if (p.includes("://") || p.startsWith("http")) continue;
    if (!existsSync(p)) {
      warnings.push(`dead reference: ${p} not found`);
    }
  }

  // Deduplicate
  return [...new Set(warnings)];
}

// ---- stale-bump detection ----
function detectStaleBump(filePath, sha) {
  if (!sha) return null;

  // Get file content at the synced commit
  const oldContent = sh(`git show ${sha}:${filePath}`);
  if (oldContent === null) return null;

  // Get current file content
  let currentContent;
  try {
    currentContent = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const oldBody = stripFrontmatter(oldContent);
  const currentBody = stripFrontmatter(currentContent);

  if (oldBody === currentBody) {
    return "SHA bumped but content unchanged";
  }
  return null;
}

// ---- check a single context file ----
function checkFile(entry, config) {
  const result = {
    ...entry,
    exists: false,
    tokens: 0,
    stale: null,
    stalenessLevel: null,
    commitsSinceSync: null,
    issues: [],
    warnings: [],
  };

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

  // Determine which dirs to check for staleness
  let dirs;
  if (fm.watches) {
    // Use watches pathspecs instead of global source dirs
    dirs = fm.watches.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    dirs = existingSourceDirs(config);
  }

  if (!sha) {
    result.issues.push("no last_synced_commit in frontmatter — staleness unknown");
  } else {
    const count = commitsSince(sha, dirs);
    result.commitsSinceSync = count;
    if (count === null) {
      result.issues.push(`could not resolve commit "${sha}" (shallow clone? bad sha?)`);
    } else {
      const { level, stale } = graduateStaleness(count, config.staleThreshold);
      result.stalenessLevel = level;
      result.stale = stale;
      if (level === "possibly-stale") {
        result.warnings.push(`possibly stale: ${count} source commits since last sync (threshold ${config.staleThreshold})`);
      } else if (level === "likely-stale") {
        result.issues.push(`stale: ${count} source commits since last sync (threshold ${config.staleThreshold})`);
      } else if (level === "stale") {
        result.issues.push(`stale: ${count} source commits since last sync (threshold ${config.staleThreshold})`);
      }
    }

    // Stale-bump detection
    const bumpWarning = detectStaleBump(entry.file, sha);
    if (bumpWarning && count > 0) {
      result.warnings.push(bumpWarning);
    }
  }

  // Dead reference detection
  const deadRefs = detectDeadReferences(text);
  result.warnings.push(...deadRefs);

  return result;
}

// ---- baseline estimation ----
function estimateBaselineWithoutContext(config) {
  const dirs = existingSourceDirs(config);
  if (dirs.length === 0) return null;

  const tree = sh(`git ls-files ${dirs.join(" ")}`);
  if (!tree) return null;

  const files = tree.split("\n").filter(Boolean).slice(0, config.baselineFileCap);
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

// ---- build report ----
function buildReport(config) {
  const checks = config.files.map((entry) => checkFile(entry, config));
  const curatedTokens = checks.reduce((sum, r) => sum + r.tokens, 0);
  const baselineTokens = estimateBaselineWithoutContext(config);
  const hasFailure = checks.some((r) => (r.required && !r.exists) || r.stale === true);

  const estimatedSavingsPct = baselineTokens ? Math.round((1 - curatedTokens / baselineTokens) * 100) : null;
  const savingsRatio = baselineTokens && curatedTokens > 0 ? +(baselineTokens / curatedTokens).toFixed(1) : null;

  // ---- suggestions ----
  const suggestions = [];

  const graphCheck = checks.find((c) => c.id === "graph");
  const graphMissing = graphCheck && !graphCheck.exists;
  const graphifyExists = existsSync("graphify-out/graph.json");

  if (!graphifyExists) {
    if (graphMissing) {
      suggestions.push({
        id: "graphify",
        message: "Run /graphify or npx graphifyy to auto-generate an architecture map (.agent/graph.md) from your codebase.",
      });
    } else if (baselineTokens && baselineTokens > 10000) {
      suggestions.push({
        id: "graphify",
        message: `Baseline cost is ~${baselineTokens} tokens. Run /graphify to build a knowledge graph — agents can query it instead of re-reading source.`,
      });
    }
  }

  return {
    checks,
    curatedTokens,
    baselineTokens,
    estimatedSavingsPct,
    savingsRatio,
    contentChecks: [],
    suggestions,
    pass: !hasFailure,
  };
}

// ---- human-readable output ----
function printText(report) {
  console.log("Context Audit");
  console.log("=".repeat(40));
  for (const r of report.checks) {
    let status;
    if (!r.exists) {
      status = r.required ? "MISSING " : "absent  ";
    } else if (r.stalenessLevel && STALENESS_DISPLAY[r.stalenessLevel]) {
      status = STALENESS_DISPLAY[r.stalenessLevel].slice(1, -1); // strip brackets for alignment
    } else {
      status = "OK      ";
    }
    console.log(`[${status}] ${r.file}  (~${r.tokens} tok est.)`);
    for (const issue of r.issues) console.log(`           - ${issue}`);
    for (const w of r.warnings) console.log(`           - [warn] ${w}`);
  }
  console.log("-".repeat(40));
  console.log(`Curated context cost:  ~${report.curatedTokens} tok est.`);
  if (report.baselineTokens) {
    console.log(`Baseline w/o context:  ~${report.baselineTokens} tok est.`);
    let savingsLine = `Estimated savings:     ~${report.estimatedSavingsPct}%`;
    if (report.savingsRatio) {
      savingsLine += ` (${report.savingsRatio}x smaller)`;
    }
    console.log(savingsLine);
  } else {
    console.log("Baseline w/o context:  n/a (no source dirs found to estimate against)");
  }
  console.log(report.pass ? "\nResult: PASS" : "\nResult: FAIL");

  if (report.suggestions.length > 0) {
    console.log("\nSuggestions:");
    for (const s of report.suggestions) {
      console.log(`  → ${s.message}`);
    }
  }
}

// ---- --help output ----
function printHelp() {
  console.log(`ctx-audit — audit persistent context files for AI agents

Usage:
  node scripts/audit.mjs [flags]
  npx ctx-audit [flags]

Flags:
  --json       Machine-readable JSON output
  --strict     Exit 1 on any failure (missing required file or stale file)
  --ci         Alias for --strict --json
  --init       Print AGENTS.md and memory.md scaffolding templates to stdout
  --help       Show this help and exit

Config file (.ctx-audit.json):
  Place in repo root. All fields optional:
  {
    "files": [{ "id": "...", "file": "...", "label": "...", "maxTokens": N, "required": bool }],
    "sourceDirs": ["src", "packages/core"],
    "staleThreshold": 10,
    "baselineFileCap": 300
  }
  "files" replaces defaults entirely (not merge). Missing fields use defaults.

Frontmatter fields:
  last_synced_commit: <sha>   Required for staleness detection
  watches: path/**, other/**  Comma-separated git pathspecs; scopes staleness
                              checks to only commits touching those paths

Staleness levels:
  FRESH     0 to threshold×0.5 commits since sync
  STALE?    threshold×0.5 to threshold (possibly stale)
  STALE!    threshold to threshold×2 (likely stale — counts as failure)
  STALE     >threshold×2 (stale — counts as failure)

Default files:
  AGENTS.md           Agent instructions (required, 1500 tok budget)
  memory.md           Decision / memory log (required, 2500 tok budget)
  .agent/graph.md     Architecture map (optional, 2000 tok budget)

Companion tools:
  /graphify (npx graphifyy)   Auto-generate .agent/graph.md from codebase

Token estimates use ~3.5 chars/token heuristic (directionally useful, not exact).`);
}

// ---- --init scaffolding ----
function printInit() {
  // Detect project info
  const detected = { buildCmd: null, testCmd: null, lintCmd: null, language: null, entrypoint: null };

  // package.json
  if (existsSync("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync("package.json", "utf8"));
      detected.language = "Node.js";
      if (pkg.scripts) {
        if (pkg.scripts.build) detected.buildCmd = `npm run build`;
        if (pkg.scripts.test) detected.testCmd = `npm test`;
        if (pkg.scripts.lint) detected.lintCmd = `npm run lint`;
      }
      if (pkg.main) detected.entrypoint = pkg.main;
    } catch { /* ignore */ }
  }

  // pyproject.toml
  if (!detected.language && existsSync("pyproject.toml")) {
    detected.language = "Python";
    if (existsSync("Makefile")) {
      try {
        const makefile = readFileSync("Makefile", "utf8");
        if (makefile.includes("pytest")) detected.testCmd = "make test";
        if (makefile.includes("ruff") || makefile.includes("flake8")) detected.lintCmd = "make lint";
      } catch { /* ignore */ }
    }
    if (!detected.testCmd) detected.testCmd = "pytest";
  }

  // Cargo.toml
  if (!detected.language && existsSync("Cargo.toml")) {
    detected.language = "Rust";
    detected.buildCmd = "cargo build";
    detected.testCmd = "cargo test";
    detected.lintCmd = "cargo clippy";
  }

  // Makefile fallback
  if (!detected.language && existsSync("Makefile")) {
    try {
      const makefile = readFileSync("Makefile", "utf8");
      const targets = [...makefile.matchAll(/^([a-zA-Z_-]+):/gm)].map((m) => m[1]);
      if (targets.includes("build")) detected.buildCmd = "make build";
      if (targets.includes("test")) detected.testCmd = "make test";
      if (targets.includes("lint")) detected.lintCmd = "make lint";
    } catch { /* ignore */ }
  }

  const sha = sh("git rev-parse HEAD") || "<TODO: insert current HEAD sha>";
  const lang = detected.language || "<TODO: language>";

  console.log(`# ======================== AGENTS.md ========================
---
last_synced_commit: ${sha}
---

# Project conventions

## Language & runtime
${lang}

## Commands
${detected.buildCmd ? `- Build: \`${detected.buildCmd}\`` : "- Build: \`TODO\`"}
${detected.testCmd ? `- Test: \`${detected.testCmd}\`` : "- Test: \`TODO\`"}
${detected.lintCmd ? `- Lint: \`${detected.lintCmd}\`` : "- Lint: \`TODO\`"}

## File layout
TODO: describe key directories and what goes where.

## Hard constraints
TODO: list things agents must never do (e.g., "never commit .env files").

# ======================== memory.md ========================
---
last_synced_commit: ${sha}
---

# Decision log

## $(date) — Initial setup
- **Context:** Project initialized with ctx-audit.
- **Decision:** TODO: record your first architectural or process decision here.
- **Why:** TODO
- **Revisit if:** TODO

# ======================== Tip ========================
# To auto-generate .agent/graph.md (architecture map), run:
#   /graphify    (in Claude Code)
#   npx graphifyy   (standalone)
# The graph gives agents a compressed, queryable map of your codebase.`);
}

// ---- main ----
function main() {
  const args = parseArgs(process.argv.slice(2));

  // --ci is an alias for --strict --json
  if (args.ci) {
    args.strict = true;
    args.json = true;
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.init) {
    printInit();
    process.exit(0);
  }

  const config = resolveConfig();
  const report = buildReport(config);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }

  if (args.strict && !report.pass) process.exit(1);
}

main();
