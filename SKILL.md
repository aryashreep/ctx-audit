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

```bash
node <path-to-this-skill-folder>/scripts/audit.mjs
```

(The exact path depends on where the skills CLI installed this skill for your
agent — e.g. `.claude/skills/context-audit/scripts/audit.mjs`.)

Flags:
- `--json` — machine-readable output (use this if you're going to act on the
  result programmatically rather than just reading it).
- `--strict` — exit code 1 if anything is missing or stale. Not usually needed
  inside an agent session (you're reading the output yourself); this is mainly
  for the CI counterpart of this same script.

## Interpreting results

- **MISSING** (required file): don't proceed as if the convention is in place.
  Offer to scaffold a starter file — see below — rather than working without
  one or silently doing the old "explore everything manually" approach.
- **STALE**: the file's `last_synced_commit` frontmatter is more than 5 source
  commits behind HEAD. Treat its claims as unverified. Spot-check anything
  load-bearing against the actual code before acting on it, and after your
  session, update the file and its `last_synced_commit`.
- Token counts are a rough chars/4 heuristic — directionally useful, not exact.
  If a file is flagged "over budget," it's gotten bloated enough that reading
  it is starting to cost what it was meant to save; suggest trimming it.

## If required files are missing — scaffold them

Each file should open with frontmatter pinning the commit it was last verified
against, so future audits can detect drift:

```markdown
---
last_synced_commit: <git sha>
---
```

**AGENTS.md** — stable project conventions: build/test/lint commands, file
layout rules, things the agent must never do. Should change rarely.

**memory.md** — a running decision log, not a restatement of current code.
Each entry: what was tried, what was decided, why, and what to reconsider if
circumstances change. Append, don't rewrite history.

**.agent/graph.md** (optional but recommended once the repo grows) — one
paragraph per major module describing its responsibility and what it talks to.
Not file contents, not an exhaustive tree — just enough that an agent can
navigate without re-reading everything.

After scaffolding or updating any of these, update its `last_synced_commit` to
the current HEAD so the next audit doesn't immediately flag it as stale.
