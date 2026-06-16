# Review request: ctx-audit — a context-freshness checker for AI coding agents

I'm building a small tool and want a critical design review. Below is the
full context: the goal, the reasoning that led to the current design, what's
already built and tested, and the specific points I want feedback on. Please
push back on anything that seems wrong, not just validate it.

## Goal

When an AI coding agent (Claude Code, Cursor, etc.) starts work in a repo, it
spends tokens re-discovering things that were already known: project
structure, conventions, and past decisions. The goal is to make repos
self-describing enough that this rediscovery cost drops — via a small set of
persistent files — and to have a tool that verifies those files actually
still serve that purpose, rather than just checking that they exist.

## Key reasoning so far

- Checking only "does memory.md exist" is a weak bar — an empty or stale file
  passes that check while actively making things worse, because the agent
  trusts wrong information instead of having no information.
- So the real requirement has three parts: **existence**, **currency**
  (is it still accurate relative to recent code changes), and **conciseness**
  (a bloated file costs the tokens it was supposed to save).
- Distribution has two legitimate but different use cases:
  - **Agent-invoked** (soft, advisory): the agent decides to run a check
    at the start of a session. Best distributed as an installable "skill"
    via the `skills.sh` / `npx skills add` ecosystem, which already handles
    multi-agent installation (Claude Code, Cursor, Copilot, etc.).
  - **CI-enforced** (hard gate): PRs should fail if the convention isn't
    maintained, independent of whether anyone asked an agent to check.
    This needs a GitHub Action, not a skill, since a skill is opt-in per
    session.
  - Decision: build one core script, and wrap it twice (skill + Action)
    rather than duplicating the logic, so the definition of "stale" lives
    in exactly one place.
- Token savings can be shown two ways: a cheap **static estimate** (tokenize
  the curated files vs. a baseline of what the agent would otherwise read)
  computable instantly with no live data, or **empirical tracking** (real
  token counts from actual agent sessions before/after adoption), which is
  more accurate but needs hook access into live sessions. Decision: ship the
  static estimate first; empirical tracking is a later layer.

## The convention being checked

Three files, each required to open with frontmatter pinning the commit it
was last verified against:

```markdown
---
last_synced_commit: <git sha>
---
```

- **AGENTS.md** (required) — stable conventions: build/test/lint commands,
  layout rules, hard constraints. Changes rarely.
- **memory.md** (required) — a decision log: what was tried, what was
  decided, why. Not a restatement of current code state.
- **.agent/graph.md** (optional) — one paragraph per module: responsibility
  and what it talks to. Not a file tree, not file contents.

## Staleness detection (the part I'm least sure about)

Currently: count git commits since `last_synced_commit` that touched a fixed
set of source directories (`src`, `lib`, `app`); flag stale if that count
exceeds a flat threshold (5). This is crude — it doesn't distinguish a commit
that renamed a variable from one that restructured a whole module, and it
doesn't tie a specific *claim* in memory.md to the *files* that claim is
about. An alternative would be scoping the commit count to paths actually
referenced by each file, but that requires either manual tagging per entry or
some kind of inferred mapping, which adds real complexity.

## What's already built and tested

`scripts/audit.mjs` — dependency-free Node script. For each configured file:
checks existence, parses frontmatter for `last_synced_commit`, counts commits
since via `git rev-list --count <sha>..HEAD -- <dirs>`, estimates token cost
via a chars/4 heuristic, and flags it if over a configured token budget. Also
computes a baseline estimate (sum of tokens across the tracked source tree,
capped at 200 files) to derive an estimated savings percentage. Exits 1 in
`--strict` mode if anything required is missing or stale.

Tested against a throwaway git repo: confirmed it correctly reports MISSING
when files don't exist, PASS when they exist and are current, and STALE
(with exit code 1 under `--strict`) once source commits since
`last_synced_commit` exceed the threshold.

Full script:

```javascript
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
```

`skill/SKILL.md` (for installation via `npx skills add <owner>/<repo> --skill context-audit`):

```markdown
---
name: context-audit
description: Use this skill at the very start of any non-trivial session in a repository — before doing a manual directory scan, before trusting claims in memory.md or AGENTS.md, and before re-deriving project structure from scratch. It checks whether the repo's persistent context files (AGENTS.md, memory.md, .agent/graph.md) exist and are current relative to recent commits, and estimates how many tokens they save vs. re-discovering everything by reading source directly. Trigger this whenever the user asks to "get up to speed," "check context files," "audit memory," "is this repo set up for agents," or whenever you're about to spend a large number of tool calls exploring an unfamiliar codebase — run this first, it's cheap.
---

# Context Audit

Repos that adopt this convention keep a small set of persistent files so agents
don't re-derive the same things every session: what the project's conventions
are (AGENTS.md), what's already been decided and why (memory.md), and roughly
how the codebase is organized (.agent/graph.md). This skill checks whether
those files exist and are current *before* you rely on them or before you fall
back to scanning the repo manually.

## When to use this

- At the start of work in a repo you haven't touched yet this session.
- Before trusting anything memory.md or AGENTS.md claims about "current state"
  — confirm it isn't stale first. A stale memory file is worse than none,
  because it's misleadingly trusted.
- Any time you're about to do a broad exploratory pass (reading many files just
  to understand structure) — run this first; if the files are current, read
  them instead of the raw tree.

## How to run

This skill bundles `scripts/audit.mjs` alongside this file. Run it with the
working directory set to the repo root (not the skill's own folder, since it
needs `git` to resolve relative to the repo):

    node <path-to-this-skill-folder>/scripts/audit.mjs

(The exact path depends on where the skills CLI installed this skill for your
agent — e.g. `.claude/skills/context-audit/scripts/audit.mjs`.)

Flags:
- `--json` — machine-readable output.
- `--strict` — exit code 1 if anything is missing or stale (mainly for the CI
  counterpart of this same script).

## Interpreting results

- MISSING (required): offer to scaffold a starter file rather than proceeding
  without one.
- STALE: `last_synced_commit` is more than 5 source commits behind HEAD —
  treat the file's claims as unverified.
- Token counts are a rough chars/4 heuristic — directionally useful, not exact.

## If required files are missing — scaffold them

Each file opens with `last_synced_commit: <git sha>` frontmatter.
- AGENTS.md: stable conventions, build/test commands, hard constraints.
- memory.md: a decision log — what was tried, what was decided, why.
- .agent/graph.md (optional): one paragraph per module, not file contents.
```

`action/context-audit.yml` (drop into `.github/workflows/`):

```yaml
name: Context Audit

on:
  pull_request:
    paths:
      - "src/**"
      - "lib/**"
      - "app/**"
      - "AGENTS.md"
      - "memory.md"
      - ".agent/**"

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # full history required for the staleness commit count

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Run context audit
        run: node scripts/audit.mjs --strict
```

## Open questions I want a second opinion on

1. **Staleness signal.** Is a flat commit-count threshold across fixed source
   dirs (`src`/`lib`/`app`) good enough, or is it too coarse to be trustworthy?
   What's a better signal that doesn't require manually tagging which files
   each memory.md entry "covers"?
2. **Scaffolding missing files.** Should generating starter content for a
   missing AGENTS.md/memory.md be a template (deterministic, dumb) or should
   it call an LLM to draft something from the actual repo content (smarter,
   but now the audit tool has a dependency on model access and non-determinism)?
   Should this be a `--fix` flag on the same script, or a deliberately separate
   tool?
3. **Token estimate honesty.** The chars/4 heuristic is a guess. Is shipping
   an "estimated savings: X%" number without a real tokenizer behind it
   more misleading than useful, given it's meant to be a credibility-building
   metric?
4. **Distribution split.** Is splitting into a skill (advisory) + Action
   (enforced) actually the right call, or is that premature scope — should v1
   just be the CLI script and a README, with both wrappers added only once
   someone actually wants to install it that way?
5. **Anything in the threat model I'm missing** — e.g., a team gaming the
   check by writing a long but vacuous memory.md just to pass the existence
   check, or `last_synced_commit` being trivially bumped without the content
   actually being reviewed.

Please don't just confirm the design — tell me what you'd change.
