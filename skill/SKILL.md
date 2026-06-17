---
name: ctx-audit
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

The recommended way to run ctx-audit:

```bash
npx ctx-audit
```

Alternatively, if installed as a skill, run with the working directory set to
the repo root:

```bash
node <path-to-this-skill-folder>/../scripts/audit.mjs
```

Flags:
- `--json` — machine-readable output (use this if you're going to act on the
  result programmatically rather than just reading it).
- `--strict` — exit code 1 if anything is missing or stale.
- `--ci` — alias for `--strict --json`.
- `--init` — print AGENTS.md and memory.md scaffolding templates to stdout.
- `--help` — show usage and exit.

## Interpreting results

- **MISSING** (required file): don't proceed as if the convention is in place.
  Offer to scaffold a starter file (run `npx ctx-audit --init`) rather than
  working without one or silently doing the old "explore everything manually"
  approach.
- **FRESH**: the file is up to date (fewer than half the stale threshold in
  source commits since last sync).
- **STALE?** (possibly stale): approaching the threshold. Treat with mild
  caution — spot-check critical claims.
- **STALE!** (likely stale): the file is behind enough to count as a failure.
  Treat its claims as unverified. Spot-check anything load-bearing against the
  actual code, and after your session, update the file and its
  `last_synced_commit`.
- **STALE**: significantly behind. Same treatment as STALE! but more urgent.
- Token counts are a ~3.5 chars/token heuristic — directionally useful, not
  exact. If a file is flagged "over budget," it's gotten bloated enough that
  reading it is starting to cost what it was meant to save; suggest trimming.
- **Dead reference warnings**: paths mentioned in context files that no longer
  exist on disk. Indicates the file references outdated structure.

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

Run `npx ctx-audit --init` to generate templates. Redirect output to create
the files, then edit to fill in the TODOs.

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
