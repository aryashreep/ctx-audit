---
name: ctx-audit
description: >
  Use at session start before trusting AGENTS.md or memory.md, before a broad
  exploratory pass, or when the user says: "audit my context", "check if context is stale",
  "is this repo set up for agents", "are my agent files current", "verify memory.md",
  "check AGENTS.md freshness", "is this project AI-ready", "token savings", "context cost",
  "how stale is memory.md", "scaffold AGENTS.md", "initialize context", "add ctx-audit to CI",
  "install ctx-audit", "wire up the context hook", "set up agent context", "check my context files",
  "are context files fresh", "what does memory.md say", "do I have an AGENTS.md", "context audit",
  "run ctx-audit", "benchmark token savings", "how much do my context files save",
  "get me up to speed", "what do agents know about this repo", "set up AI context",
  "should I trust memory.md", "is AGENTS.md current", "check agent setup",
  or whenever about to spend many tool calls exploring an unfamiliar codebase.
trigger: /ctx-audit
---

# Context Audit

Repos that adopt this convention keep a small set of persistent files so agents
don't re-derive the same things every session: what the project's conventions
are (AGENTS.md), what's already been decided and why (memory.md), and roughly
how the codebase is organized (.agent/graph.md). This skill checks whether
those files exist and are current *before* you rely on them or before you fall
back to scanning the repo manually.

## Trigger phrases

**Session start / trust check**
- "get me up to speed on this repo"
- "what do you know about this project"
- "should I trust AGENTS.md / memory.md"
- "are the context files current"
- "check context" / "context audit"

**Staleness**
- "is AGENTS.md stale" / "is memory.md stale"
- "how many commits since last sync"
- "are my agent files current"
- "check if context is stale"

**Token cost**
- "how much do context files save"
- "token savings" / "context cost"
- "benchmark token savings"
- "baseline vs curated tokens"

**Setup / onboarding**
- "scaffold AGENTS.md" / "initialize context"
- "install ctx-audit" / "wire up the context hook"
- "set up AI context" / "is this project AI-ready"

**CI / automation**
- "add ctx-audit to CI"
- "add a pre-push hook"
- "enforce context freshness in CI"

**Architecture**
- "do I have an architecture map"
- "generate graph.md" / "run graphify"

## How to run

The recommended way to run ctx-audit:

```bash
npx ctx-audit
```

Alternatively, if installed as a skill:

```bash
node <path-to-this-skill-folder>/../scripts/audit.mjs
```

Flags:
- `--json` — machine-readable output (use this if you're going to act on the result programmatically).
- `--strict` — exit code 1 if anything is missing or stale.
- `--ci` — alias for `--strict --json`.
- `--init` — write AGENTS.md and memory.md to disk (interactive), or print templates to stdout if piped.
- `--help` — show usage and exit.

## Subcommands

```bash
# One-command install: copies skill to ~/.claude/skills/, registers in CLAUDE.md
npx ctx-audit install

# Git hook: runs --strict audit on every push
npx ctx-audit hook install
npx ctx-audit hook status
npx ctx-audit hook uninstall

# Project CLAUDE.md: adds an instruction block for agents
npx ctx-audit claude install
npx ctx-audit claude uninstall

# Token savings report (focused, shareable format)
npx ctx-audit benchmark
```

## Agent decision table

| Status | Meaning | Action |
|---|---|---|
| **FRESH** | Fewer than half the stale threshold in commits since last sync | Trust the file — read it instead of scanning raw source |
| **STALE?** | Approaching threshold (possibly stale) | Mild caution — spot-check critical claims before relying on them |
| **STALE!** | Past threshold, counts as failure | Treat claims as unverified; spot-check against actual code; update after session |
| **STALE** | Significantly behind, counts as failure | Same as STALE! but more urgent; update immediately after session |
| **MISSING** (required) | File doesn't exist | Run `npx ctx-audit --init`; don't proceed as if convention is in place |
| **absent** (optional) | Optional file not present | Acceptable; consider running `/graphify` to generate graph.md |
| **over budget** | Token count exceeds `maxTokens` | File is bloated — trim it; reading it may cost more than it saves |
| **dead reference** | Backtick path or `dir/file.ext` in file doesn't exist on disk | Update the reference; file documents outdated structure |
| **SHA bumped** | `last_synced_commit` updated but body unchanged | Verify whether file actually reflects recent changes; may be a mechanical bump |

## Interpreting results

- **MISSING** (required file): don't proceed as if the convention is in place.
  Offer to scaffold a starter file (run `npx ctx-audit --init`) rather than
  working without one or silently doing the old "explore everything manually"
  approach.
- **FRESH**: the file is up to date. Read it instead of scanning raw source.
- **STALE?** (possibly stale): approaching the threshold. Spot-check critical claims.
- **STALE!** (likely stale): treat its claims as unverified. Spot-check anything
  load-bearing against the actual code, and after your session, update the file
  and its `last_synced_commit`.
- **STALE**: significantly behind. Same treatment as STALE! but more urgent.
- Token counts are a ~3.5 chars/token heuristic — directionally useful, not
  exact. If a file is flagged "over budget," it's gotten bloated enough that
  reading it is starting to cost what it was meant to save; suggest trimming.
- **Dead reference warnings**: paths mentioned in context files that no longer
  exist on disk. Indicates the file references outdated structure.

## Worked examples

**Basic audit at session start:**
```bash
npx ctx-audit
```

**CI gate (fail build if context is stale):**
```yaml
# .github/workflows/ctx-audit.yml
- name: Audit context freshness
  run: npx ctx-audit --strict
```

**JSON output for programmatic use:**
```bash
npx ctx-audit --json | jq '.checks[] | {file, stalenessLevel, stale}'
```

**One-command onboarding:**
```bash
npx ctx-audit install        # copies skill, registers in CLAUDE.md
npx ctx-audit hook install   # adds pre-push guard
npx ctx-audit claude install # adds note to project CLAUDE.md
npx ctx-audit --init         # scaffolds AGENTS.md + memory.md
```

**Check only specific subsystem staleness (via frontmatter):**
```markdown
---
last_synced_commit: abc1234
watches: src/auth/**, src/api/**
---
```
Only commits touching `src/auth/` or `src/api/` count toward staleness for this file.

**Benchmark token savings:**
```bash
npx ctx-audit benchmark
```

## Configuration

Place `.ctx-audit.json` in the repo root to customize behavior:

```jsonc
{
  "files": [{ "id": "...", "file": "...", "label": "...", "maxTokens": N, "required": true }],
  "sourceDirs": ["src", "packages/core"],
  "staleThreshold": 10,
  "baselineFileCap": 300
}
```

## Frontmatter

Each context file should open with frontmatter:

```markdown
---
last_synced_commit: <git sha>
watches: src/auth/**, src/api/**
---
```

The `watches` field (optional) scopes staleness checks to only commits touching
those paths, instead of all source directories.

## If required files are missing — scaffold them

Run `npx ctx-audit --init` to generate templates. In a TTY it writes files
directly; when piped, it prints to stdout for redirect.

**AGENTS.md** — stable project conventions: build/test/lint commands, file
layout rules, things the agent must never do. Should change rarely.

**memory.md** — a running decision log, not a restatement of current code.
Each entry: what was tried, what was decided, why, and what to reconsider if
circumstances change. Append, don't rewrite history.

**.agent/graph.md** (optional but recommended once the repo grows) — one
paragraph per major module describing its responsibility and what it talks to.
Not file contents, not an exhaustive tree — just enough that an agent can
navigate without re-reading everything.
Tip: run /graphify to auto-generate this from the codebase instead of writing it by hand.

After scaffolding or updating any of these, update its `last_synced_commit` to
the current HEAD so the next audit doesn't immediately flag it as stale.
