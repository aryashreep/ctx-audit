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
 *   node scripts/audit.mjs --init       write AGENTS.md + memory.md (interactive) or print to stdout
 *   node scripts/audit.mjs --help       show usage and exit
 *   node scripts/audit.mjs install      copy skill to ~/.claude/skills/, register in CLAUDE.md
 *   node scripts/audit.mjs hook [install|uninstall|status]  manage pre-push git hook
 *   node scripts/audit.mjs claude [install|uninstall]        manage project CLAUDE.md section
 *   node scripts/audit.mjs benchmark    show token savings summary
 */

import {
  existsSync, readFileSync, mkdirSync, copyFileSync,
  writeFileSync, chmodSync, readSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---- color system ----
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const c = {
  reset:  USE_COLOR ? '\x1b[0m'  : '',
  bold:   USE_COLOR ? '\x1b[1m'  : '',
  dim:    USE_COLOR ? '\x1b[2m'  : '',
  green:  USE_COLOR ? '\x1b[32m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  red:    USE_COLOR ? '\x1b[31m' : '',
  cyan:   USE_COLOR ? '\x1b[36m' : '',
  gray:   USE_COLOR ? '\x1b[90m' : '',
};

// ---- defaults ----
const DEFAULT_FILES = [
  { id: "agents", file: "AGENTS.md", label: "Agent instructions", maxTokens: 1500, required: true },
  { id: "memory", file: "memory.md", label: "Decision / memory log", maxTokens: 2500, required: true },
  { id: "graph", file: ".agent/graph.md", label: "Architecture map", maxTokens: 2000, required: false },
];

const DEFAULT_SOURCE_DIRS = ["src", "lib", "app"];
const DEFAULT_STALE_THRESHOLD = 5;
const DEFAULT_BASELINE_FILE_CAP = 200;

// ---- subcommand set ----
const SUBCOMMANDS = new Set(['install', 'hook', 'claude', 'benchmark']);

// ---- argument parsing ----
function parseArgs(argv) {
  const sub = argv[0] && !argv[0].startsWith('-') && SUBCOMMANDS.has(argv[0]) ? argv[0] : null;
  const subArgs = sub ? argv.slice(1) : [];
  return {
    sub,
    subArgs,
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

  const files = overrides.files || fileConfig.files || DEFAULT_FILES;

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

  const tree = sh("git ls-files");
  if (!tree) return DEFAULT_SOURCE_DIRS.filter((d) => existsSync(d));

  const counts = {};
  for (const f of tree.split("\n").filter(Boolean)) {
    const top = f.split("/")[0];
    if (top === f) continue;
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

// ---- status badge with colors ----
function statusBadge(r) {
  if (!r.exists) {
    if (r.required) return `${c.bold}${c.red}[MISSING ]${c.reset}`;
    return `${c.dim}[absent  ]${c.reset}`;
  }
  switch (r.stalenessLevel) {
    case 'fresh':          return `${c.green}[FRESH   ]${c.reset}`;
    case 'possibly-stale': return `${c.yellow}[STALE?  ]${c.reset}`;
    case 'likely-stale':   return `${c.red}[STALE!  ]${c.reset}`;
    case 'stale':          return `${c.bold}${c.red}[STALE   ]${c.reset}`;
    default:               return `${c.cyan}[OK      ]${c.reset}`;
  }
}

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
    if (p.includes("://") || p.startsWith("http")) continue;
    if (!existsSync(p)) {
      warnings.push(`dead reference: ${p} not found`);
    }
  }

  return [...new Set(warnings)];
}

// ---- stale-bump detection ----
function detectStaleBump(filePath, sha) {
  if (!sha) return null;

  const oldContent = sh(`git show ${sha}:${filePath}`);
  if (oldContent === null) return null;

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

  let dirs;
  if (fm.watches) {
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

    const bumpWarning = detectStaleBump(entry.file, sha);
    if (bumpWarning && count > 0) {
      result.warnings.push(bumpWarning);
    }
  }

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
  console.log(`\n${c.bold}${c.cyan}Context Audit${c.reset}`);
  console.log(c.dim + "=".repeat(40) + c.reset);
  for (const r of report.checks) {
    const badge = statusBadge(r);
    console.log(`${badge} ${c.bold}${r.file}${c.reset}  ${c.gray}(~${r.tokens} tok est.)${c.reset}`);
    for (const issue of r.issues) console.log(`           ${c.red}- ${issue}${c.reset}`);
    for (const w of r.warnings) console.log(`           ${c.yellow}- [warn] ${w}${c.reset}`);
  }
  console.log(c.dim + "-".repeat(40) + c.reset);
  console.log(`Curated context cost:  ~${report.curatedTokens} tok est.`);
  if (report.baselineTokens) {
    console.log(`Baseline w/o context:  ~${report.baselineTokens} tok est.`);
    let savingsLine = `Estimated savings:     ${c.cyan}~${report.estimatedSavingsPct}%`;
    if (report.savingsRatio) {
      savingsLine += ` (${report.savingsRatio}x smaller)`;
    }
    savingsLine += c.reset;
    console.log(savingsLine);
  } else {
    console.log("Baseline w/o context:  n/a (no source dirs found to estimate against)");
  }

  if (report.pass) {
    console.log(`\n${c.bold}${c.green}Result: PASS${c.reset}`);
  } else {
    console.log(`\n${c.bold}${c.red}Result: FAIL${c.reset}`);
  }

  if (report.suggestions.length > 0) {
    console.log("\nSuggestions:");
    for (const s of report.suggestions) {
      console.log(`  ${c.cyan}→ ${s.message}${c.reset}`);
    }
  }
}

// ---- --help output ----
function printHelp() {
  console.log(`ctx-audit — audit persistent context files for AI agents

Usage:
  npx ctx-audit [subcommand] [flags]

Subcommands:
  install              Copy skill to ~/.claude/skills/, register in CLAUDE.md
  hook install         Write pre-push git hook (--strict audit on every push)
  hook uninstall       Remove ctx-audit from pre-push hook
  hook status          Check if hook is installed
  claude install       Add ctx-audit section to project CLAUDE.md
  claude uninstall     Remove ctx-audit section from project CLAUDE.md
  benchmark            Show token savings in focused, shareable format

Flags:
  --json       Machine-readable JSON output
  --strict     Exit 1 on any failure (missing required file or stale file)
  --ci         Alias for --strict --json
  --init       Write AGENTS.md + memory.md to disk (interactive), or print to stdout if piped
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

// ---- sync prompt (TTY only) ----
function promptSync(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(256);
  let n = 0;
  try { n = readSync(0, buf, 0, buf.length, null); } catch {}
  return buf.toString('utf8', 0, n).trim();
}

// ---- build init template content ----
function buildInitContent() {
  const detected = { buildCmd: null, testCmd: null, lintCmd: null, language: null };

  if (existsSync("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync("package.json", "utf8"));
      detected.language = "Node.js";
      if (pkg.scripts) {
        if (pkg.scripts.build) detected.buildCmd = `npm run build`;
        if (pkg.scripts.test) detected.testCmd = `npm test`;
        if (pkg.scripts.lint) detected.lintCmd = `npm run lint`;
      }
    } catch { /* ignore */ }
  }

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

  if (!detected.language && existsSync("Cargo.toml")) {
    detected.language = "Rust";
    detected.buildCmd = "cargo build";
    detected.testCmd = "cargo test";
    detected.lintCmd = "cargo clippy";
  }

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
  const today = new Date().toISOString().slice(0, 10);

  const agentsMd = `---
last_synced_commit: ${sha}
---

# Project conventions

## Language & runtime
${lang}

## Commands
${detected.buildCmd ? `- Build: \`${detected.buildCmd}\`` : "- Build: `TODO`"}
${detected.testCmd ? `- Test: \`${detected.testCmd}\`` : "- Test: `TODO`"}
${detected.lintCmd ? `- Lint: \`${detected.lintCmd}\`` : "- Lint: `TODO`"}

## File layout
TODO: describe key directories and what goes where.

## Hard constraints
TODO: list things agents must never do (e.g., "never commit .env files").
`;

  const memoryMd = `---
last_synced_commit: ${sha}
---

# Decision log

## ${today} — Initial setup
- **Context:** Project initialized with ctx-audit.
- **Decision:** TODO: record your first architectural or process decision here.
- **Why:** TODO
- **Revisit if:** TODO
`;

  return { agentsMd, memoryMd };
}

// ---- --init scaffolding ----
function printInit() {
  const { agentsMd, memoryMd } = buildInitContent();

  if (process.stdout.isTTY) {
    // Interactive: write files to disk
    console.log(`${c.bold}${c.cyan}ctx-audit --init${c.reset}  scaffolding context files\n`);

    if (existsSync("AGENTS.md")) {
      const answer = promptSync(`${c.yellow}AGENTS.md already exists. Overwrite? [y/N] ${c.reset}`);
      if (answer.toLowerCase() === 'y') {
        writeFileSync("AGENTS.md", agentsMd, "utf8");
        console.log(`${c.green}✓${c.reset} AGENTS.md written`);
      } else {
        console.log(`${c.dim}↳ AGENTS.md skipped${c.reset}`);
      }
    } else {
      writeFileSync("AGENTS.md", agentsMd, "utf8");
      console.log(`${c.green}✓${c.reset} AGENTS.md written`);
    }

    if (existsSync("memory.md")) {
      const answer = promptSync(`${c.yellow}memory.md already exists. Overwrite? [y/N] ${c.reset}`);
      if (answer.toLowerCase() === 'y') {
        writeFileSync("memory.md", memoryMd, "utf8");
        console.log(`${c.green}✓${c.reset} memory.md written`);
      } else {
        console.log(`${c.dim}↳ memory.md skipped${c.reset}`);
      }
    } else {
      writeFileSync("memory.md", memoryMd, "utf8");
      console.log(`${c.green}✓${c.reset} memory.md written`);
    }

    console.log(`\nNext: fill in the TODOs, then run ${c.cyan}npx ctx-audit${c.reset} to verify.`);
    console.log(`Tip: run ${c.cyan}/graphify${c.reset} or ${c.cyan}npx graphifyy${c.reset} to auto-generate .agent/graph.md`);
  } else {
    // Non-TTY: backward-compatible stdout output
    console.log(`# ======================== AGENTS.md ========================
${agentsMd.trimEnd()}

# ======================== memory.md ========================
${memoryMd.trimEnd()}

# ======================== Tip ========================
# To auto-generate .agent/graph.md (architecture map), run:
#   /graphify    (in Claude Code)
#   npx graphifyy   (standalone)
# The graph gives agents a compressed, queryable map of your codebase.`);
  }
}

// ---- install subcommand ----
function runInstall() {
  const skillSrc = join(__dirname, '..', 'skill', 'SKILL.md');
  const skillDir = join(homedir(), '.claude', 'skills', 'ctx-audit');
  const skillDest = join(skillDir, 'SKILL.md');
  const claudeDir = join(homedir(), '.claude');
  const claudeMdPath = join(claudeDir, 'CLAUDE.md');

  if (!existsSync(skillSrc)) {
    console.error(`${c.red}Error: skill/SKILL.md not found at ${skillSrc}${c.reset}`);
    console.error(`Make sure ctx-audit is installed via npm (not just cloned).`);
    process.exit(1);
  }

  // 1. Copy skill to ~/.claude/skills/ctx-audit/SKILL.md
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(skillSrc, skillDest);
  console.log(`${c.green}✓${c.reset} Skill copied to ${skillDest}`);

  // 2. Register in ~/.claude/CLAUDE.md (idempotent)
  const block = `\n# ctx-audit\n- **ctx-audit** (\`~/.claude/skills/ctx-audit/SKILL.md\`) - audit context file freshness. Trigger: \`/ctx-audit\`\nWhen the user types \`/ctx-audit\`, invoke the Skill tool with \`skill: "ctx-audit"\` before doing anything else.\n`;

  let existing = '';
  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, 'utf8');
  }

  if (existing.includes('ctx-audit')) {
    console.log(`${c.yellow}↳${c.reset}  ${claudeMdPath} already contains ctx-audit — skipped`);
  } else {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(claudeMdPath, existing + block, 'utf8');
    console.log(`${c.green}✓${c.reset} Registered in ${claudeMdPath}`);
  }

  // 3. Onboarding summary
  console.log(`\n${c.bold}${c.green}ctx-audit installed!${c.reset}\n`);
  console.log(`Next steps:`);
  console.log(`  ${c.cyan}ctx-audit hook install${c.reset}    wire up git pre-push hook`);
  console.log(`  ${c.cyan}ctx-audit claude install${c.reset}  add ctx-audit to project CLAUDE.md`);
  console.log(`  ${c.cyan}npx ctx-audit${c.reset}             run an audit now`);
  console.log(`  ${c.cyan}/ctx-audit${c.reset}                trigger from Claude Code`);
}

// ---- hook subcommand ----
function runHook(subArgs) {
  const action = subArgs[0] || 'install';

  if (!['install', 'uninstall', 'status'].includes(action)) {
    console.error(`Unknown hook action: ${action}. Use: install, uninstall, status`);
    process.exit(1);
  }

  if (!existsSync('.git')) {
    console.error(`${c.red}Error: No .git directory found. Run from the repo root.${c.reset}`);
    process.exit(1);
  }

  const hooksDir = join('.git', 'hooks');
  const hookPath = join(hooksDir, 'pre-push');
  const hookMark = '# ctx-audit-hook';
  const hookSnippet = `${hookMark}\nnpx ctx-audit --strict || exit 1`;

  if (action === 'status') {
    if (existsSync(hookPath)) {
      const content = readFileSync(hookPath, 'utf8');
      if (content.includes(hookMark)) {
        console.log(`${c.green}✓${c.reset} ctx-audit hook is installed (${hookPath})`);
      } else {
        console.log(`${c.yellow}~${c.reset} pre-push hook exists but does not contain ctx-audit`);
      }
    } else {
      console.log(`${c.dim}○ No pre-push hook found${c.reset}`);
    }
    return;
  }

  if (action === 'uninstall') {
    if (!existsSync(hookPath)) {
      console.log(`${c.dim}○ No pre-push hook to remove${c.reset}`);
      return;
    }
    const content = readFileSync(hookPath, 'utf8');
    if (!content.includes(hookMark)) {
      console.log(`${c.yellow}↳${c.reset}  Hook does not contain ctx-audit marker — nothing removed`);
      return;
    }
    const newContent = content.replace(`\n\n${hookSnippet}\n`, '').replace(`\n${hookSnippet}\n`, '').replace(hookSnippet, '');
    writeFileSync(hookPath, newContent, 'utf8');
    console.log(`${c.green}✓${c.reset} ctx-audit hook removed from ${hookPath}`);
    return;
  }

  // action === 'install'
  if (existsSync(hookPath)) {
    const content = readFileSync(hookPath, 'utf8');
    if (content.includes(hookMark)) {
      console.log(`${c.yellow}↳${c.reset}  Hook already installed — skipped`);
      return;
    }
    const appended = content.trimEnd() + '\n\n' + hookSnippet + '\n';
    writeFileSync(hookPath, appended, 'utf8');
  } else {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hookPath, `#!/bin/sh\n${hookSnippet}\n`, 'utf8');
  }
  chmodSync(hookPath, 0o755);
  console.log(`${c.green}✓${c.reset} Hook written to ${hookPath}`);
  console.log(`  ${c.gray}Runs npx ctx-audit --strict on every git push${c.reset}`);
}

// ---- claude subcommand ----
function runClaude(subArgs) {
  const action = subArgs[0] || 'install';

  if (!['install', 'uninstall'].includes(action)) {
    console.error(`Unknown claude action: ${action}. Use: install, uninstall`);
    process.exit(1);
  }

  const claudeMdPath = 'CLAUDE.md';
  const sectionMark = '<!-- ctx-audit -->';
  const section = `\n${sectionMark}\n## ctx-audit\n\nRun \`npx ctx-audit\` at the start of any non-trivial session in this repository.\nUpdate context files (AGENTS.md, memory.md) after modifying what they describe, then bump their \`last_synced_commit\` to current HEAD.\n`;

  if (action === 'uninstall') {
    if (!existsSync(claudeMdPath)) {
      console.log(`${c.dim}○ No CLAUDE.md found${c.reset}`);
      return;
    }
    const content = readFileSync(claudeMdPath, 'utf8');
    if (!content.includes(sectionMark)) {
      console.log(`${c.yellow}↳${c.reset}  CLAUDE.md does not contain ctx-audit section — nothing removed`);
      return;
    }
    // Remove from the marker through to the next heading or end of file
    const newContent = content
      .replace(/\n?<!-- ctx-audit -->\n## ctx-audit\n[\s\S]*?(?=\n##? |\n# |$)/, '')
      .trimEnd() + '\n';
    writeFileSync(claudeMdPath, newContent, 'utf8');
    console.log(`${c.green}✓${c.reset} ctx-audit section removed from CLAUDE.md`);
    return;
  }

  // action === 'install'
  let existing = '';
  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, 'utf8');
  }

  if (existing.includes(sectionMark)) {
    console.log(`${c.yellow}↳${c.reset}  CLAUDE.md already contains ctx-audit section — skipped`);
    return;
  }

  writeFileSync(claudeMdPath, existing + section, 'utf8');
  console.log(`${c.green}✓${c.reset} Added ctx-audit section to CLAUDE.md`);
  console.log(`  ${c.gray}Agents will run npx ctx-audit at session start${c.reset}`);
}

// ---- benchmark subcommand ----
function runBenchmark() {
  const config = resolveConfig();
  const report = buildReport(config);

  console.log(`\n${c.bold}${c.cyan}Token Savings Benchmark${c.reset}`);
  console.log(c.dim + "=".repeat(40) + c.reset);

  if (!report.baselineTokens) {
    console.log(`${c.yellow}No source directories found for baseline estimation.${c.reset}`);
    console.log(`Add sourceDirs to .ctx-audit.json or create src/, lib/, or app/ directories.`);
    return;
  }

  console.log(`${c.bold}Curated context:${c.reset}  ~${report.curatedTokens} tokens`);
  console.log(`${c.bold}Baseline (raw):${c.reset}    ~${report.baselineTokens} tokens`);

  if (report.estimatedSavingsPct !== null) {
    console.log(`${c.bold}Savings:${c.reset}           ${c.green}~${report.estimatedSavingsPct}%${c.reset}`);
  }
  if (report.savingsRatio !== null) {
    console.log(`${c.bold}Ratio:${c.reset}             ${c.cyan}${report.savingsRatio}x smaller${c.reset}`);
  }

  console.log(c.dim + "-".repeat(40) + c.reset);
  console.log(`${c.gray}Context files:${c.reset}`);
  for (const r of report.checks) {
    if (r.exists) {
      console.log(`  ${c.gray}${r.file}${c.reset}  ~${r.tokens} tok`);
    }
  }
}

// ---- main ----
function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  // --ci is an alias for --strict --json
  if (args.ci) {
    args.strict = true;
    args.json = true;
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Subcommand dispatch
  if (args.sub === 'install')   { runInstall();           process.exit(0); }
  if (args.sub === 'hook')      { runHook(args.subArgs);  process.exit(0); }
  if (args.sub === 'claude')    { runClaude(args.subArgs); process.exit(0); }
  if (args.sub === 'benchmark') { runBenchmark();         process.exit(0); }

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
