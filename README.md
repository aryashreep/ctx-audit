# ctx-audit

Checks whether a repo's persistent context files (`AGENTS.md`, `memory.md`,
`.agent/graph.md`) exist and are current — and estimates how many tokens
they save an AI agent vs. re-discovering everything from raw source each
session. One core script, two install paths.

## Layout

```
ctx-audit/
├── scripts/audit.mjs        core logic (no dependencies, plain Node)
├── skill/
│   ├── SKILL.md             agent-invoked path, distributed via skills.sh
│   └── scripts/audit.mjs    same script, bundled for the skill
└── action/
    └── context-audit.yml    CI gate, drop into .github/workflows/
```

## Path 1 — agent-invoked (skills.sh)

Publish `skill/` as a skill in a public repo, then anyone installs it with:

```
npx skills add <you>/<repo> --skill context-audit
```

This is the "soft" check — an agent reads SKILL.md and decides to run it
(e.g. at the start of a session, before exploring the repo manually). It's
advisory, not enforced.

## Path 2 — CI gate (GitHub Action)

Copy `action/context-audit.yml` into the target repo's
`.github/workflows/`, and copy `scripts/audit.mjs` into the repo (e.g. at
`scripts/audit.mjs`, matching the path the workflow calls). This is the
"hard" check — PRs fail if context files are missing or stale, regardless of
whether anyone remembered to ask an agent to check.

Both paths call the same script, so the rules for what counts as "stale" or
"over budget" live in one place.

## The convention itself

Three files, each opening with frontmatter pinning the commit it was last
verified against:

```markdown
---
last_synced_commit: <git sha>
---
```

- **AGENTS.md** — stable conventions: build/test/lint commands, layout
  rules, hard constraints. Changes rarely.
- **memory.md** — a decision log: what was tried, what was decided, why.
  Append-only in spirit; not a restatement of current code.
- **.agent/graph.md** (optional) — one paragraph per module: what it does,
  what it talks to. Not file contents, not a full tree.

Whenever you touch what one of these files claims, update its content *and*
its `last_synced_commit` to current HEAD — that's what lets the audit detect
drift instead of trusting a file forever.

## Token estimate caveat

The script uses a chars/4 heuristic for token counts — fast, dependency-free,
and directionally useful, but not exact. Swap in a real tokenizer (tiktoken,
or Anthropic's `count_tokens` endpoint) if you need precise numbers. The
"baseline" estimate (what it'd cost without these files) is also a
simplification — it sums the tracked source tree up to a file cap, which is a
proxy for "an agent reading everything," not a guarantee of what any
particular agent would actually do.

## Try it locally

```bash
node scripts/audit.mjs            # human-readable
node scripts/audit.mjs --json     # machine-readable
node scripts/audit.mjs --strict   # exit 1 on failure, for CI
```
