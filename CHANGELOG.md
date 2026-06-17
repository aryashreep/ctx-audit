# Changelog

All notable changes to ctx-audit are documented here.

## [0.3.0] — 2026-06-17

### Added
- **Colored terminal output** — FRESH/STALE/MISSING labels are green/red/yellow in TTY; clean plain text in CI
- **`install` subcommand** — copies skill to `~/.claude/skills/ctx-audit/` and registers the `/ctx-audit` trigger in `~/.claude/CLAUDE.md` in one command
- **`hook` subcommand** — `hook install / uninstall / status` manage a `pre-push` git hook that blocks pushes when context files are stale
- **`claude` subcommand** — `claude install / uninstall` append/remove a `## ctx-audit` section in the project `CLAUDE.md`, telling agents to run ctx-audit at session start
- **`benchmark` subcommand** — prints a focused, shareable token-savings summary
- **Rich Claude Code skill** (`skill/SKILL.md`) — 30+ trigger phrases covering audit, init, install, hook, benchmark, and staleness queries
- **Graduated staleness** — four levels (`fresh`, `possibly-stale`, `likely-stale`, `stale`) replacing binary pass/fail
- **`watches:` frontmatter** — scope staleness checks to specific path globs per file
- **Stale-bump detection** — warns when the SHA was updated but file content is unchanged
- **Dead reference detection** — flags paths mentioned in context files that no longer exist on disk
- **`--init` scaffolding** — interactive scaffold for `AGENTS.md` + `memory.md`, detecting build/test/lint commands from `package.json`, `pyproject.toml`, `Cargo.toml`, or `Makefile`

### Changed
- Default staleness threshold raised to 5 commits (was 3)
- JSON output now includes both `stalenessLevel` (string) and `stale` (boolean) for backward compatibility
- Token estimates labeled `est.` throughout to clarify they use a ~3.5 chars/token heuristic

---

## [0.2.0] — 2026-05-01

### Added
- Initial `--json` and `--strict` / `--ci` flags
- GitHub Action composite (`action.yml`) for CI gate
- `.ctx-audit.json` configuration file support (`files`, `sourceDirs`, `staleThreshold`, `baselineFileCap`)
- Token savings ratio (`Nx smaller than baseline`)
- Auto-detection of `sourceDirs` from git-tracked files

### Changed
- Moved core logic to `scripts/audit.mjs` (ESM, zero dependencies, Node >=18)

---

## [0.1.0] — 2026-04-01

- Initial release: single-script audit of `AGENTS.md` and `memory.md` for `last_synced_commit` freshness
