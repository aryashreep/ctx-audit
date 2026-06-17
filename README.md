# ctx-audit

Checks whether a repo's persistent context files (`AGENTS.md`, `memory.md`,
`.agent/graph.md`) exist and are current — and estimates how many tokens
they save an AI agent vs. re-discovering everything from raw source each
session. Zero dependencies, single script, three install paths.

## Install

### npx (no install)

```bash
npx ctx-audit
```

### Global install

```bash
npm i -g ctx-audit
ctx-audit
```

### Agent skill (skills.sh)

```
npx skills add <you>/<repo> --skill ctx-audit
```

### CI gate (GitHub Action)

```yaml
# .github/workflows/ctx-audit.yml
- uses: <owner>/ctx-audit@v1
  with:
    strict: "true"   # exit 1 on failure (default)
    json: "false"     # JSON output (default: false)
```

Or copy `action/ctx-audit.yml` into `.github/workflows/` for the
standalone workflow approach.

## Layout

```
ctx-audit/
├── package.json
├── action.yml              composite GitHub Action
├── scripts/audit.mjs       core logic (no dependencies, plain Node >=18)
├── skill/SKILL.md          agent-invoked path
├── action/ctx-audit.yml     CI workflow template (copy into target repo)
└── README.md
```

## Usage

```bash
npx ctx-audit              # human-readable report
npx ctx-audit --json       # machine-readable JSON
npx ctx-audit --strict     # exit 1 on any failure (for CI)
npx ctx-audit --ci         # alias for --strict --json
npx ctx-audit --init       # print AGENTS.md + memory.md templates to stdout
npx ctx-audit --help       # show usage and exit
```

## The convention

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
its `last_synced_commit` to current HEAD.

## Configuration

Place `.ctx-audit.json` in the repo root. All fields are optional:

```jsonc
{
  "files": [
    { "id": "agents", "file": "AGENTS.md", "label": "Agent instructions", "maxTokens": 1500, "required": true },
    { "id": "memory", "file": "memory.md", "label": "Decision log", "maxTokens": 2500, "required": true }
  ],
  "sourceDirs": ["src", "packages/core"],
  "staleThreshold": 10,
  "baselineFileCap": 300
}
```

- **`files`** — replaces the default file list entirely (not merge). If you
  customize this, list all files you want audited.
- **`sourceDirs`** — directories treated as "real source" for staleness and
  baseline. When omitted, auto-detected from git tracked files (top 5 dirs
  by file count), falling back to `["src", "lib", "app"]`.
- **`staleThreshold`** — number of source commits before a file is considered
  stale. Default: `5`.
- **`baselineFileCap`** — max source files to tokenize for baseline estimate.
  Default: `200`.

## `watches:` frontmatter field

Scope staleness checks to specific paths instead of all source directories:

```markdown
---
last_synced_commit: abc1234
watches: src/auth/**, src/api/**
---
```

Comma-separated git pathspecs. When present, only commits touching those paths
count toward staleness, making the check more precise for files that document
a specific subsystem.

## Graduated staleness

Instead of binary stale/fresh, ctx-audit reports 4 levels:

| Level | Commits since sync | Display | Counts as failure? |
|---|---|---|---|
| `fresh` | 0 to threshold×0.5 | `[FRESH]` | No |
| `possibly-stale` | threshold×0.5 to threshold | `[STALE?]` | No |
| `likely-stale` | threshold to threshold×2 | `[STALE!]` | Yes |
| `stale` | >threshold×2 | `[STALE]` | Yes |

The JSON report includes both `stalenessLevel` (string) and `stale` (boolean)
for backward compatibility.

## Additional checks

- **Stale-bump detection:** If a file's body is identical at `last_synced_commit`
  vs. current HEAD but source commits exist, a warning is emitted: "SHA bumped
  but content unchanged." This catches mechanical SHA updates without real
  review. Warning only, not a failure.
- **Dead reference detection:** Backtick-quoted paths and bare `dir/file.ext`
  patterns in context files are checked against the filesystem. Missing paths
  are reported as warnings.

## `--init` scaffolding

```bash
npx ctx-audit --init > /dev/null  # preview
npx ctx-audit --init              # prints AGENTS.md + memory.md templates
```

Detects project info from `package.json`, `pyproject.toml`, `Cargo.toml`, or
`Makefile` and fills in build/test/lint commands. Output goes to stdout only —
the tool never writes files directly. Redirect as needed.

## Companion tools

**Graphify** (`/graphify` in Claude Code, or `npx graphifyy` standalone) can
auto-generate the `.agent/graph.md` architecture map by building a knowledge
graph from your codebase. When ctx-audit reports high baseline token costs or a
missing graph file, running Graphify is the fastest way to close the gap.

## Token estimate caveat

The script uses a ~3.5 chars/token heuristic — fast, dependency-free, and
directionally useful, but not exact. All token counts in the output are labeled
`est.` to make this clear. The "baseline" estimate (cost without context files)
sums tracked source files up to a cap, which is a proxy for "an agent reading
everything," not a guarantee of what any particular agent would actually do.

The savings ratio (e.g., `12.0x smaller`) shows how much more compact the
curated context is compared to reading raw source.
