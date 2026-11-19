## Linear

Some work in this repo is tracked in Linear, but not all of it.

**Only when I mention Linear** — an issue ID, an issue link, or an explicit
ask — read the workflow guide before touching code:

- Claude Code: the `linear` skill
- Everyone else (Codex, Cursor, ...): read
  `~/.claude/skills/linear/SKILL.md` directly (on Windows,
  `%USERPROFILE%\.claude\skills\linear\SKILL.md`)

Otherwise treat the task as ordinary work and ignore this section; do not go
looking for a matching Linear issue on your own.

## Checks

Several agents share one laptop. Check only the packages you changed; don't run
the root `pnpm typecheck` / `pnpm test` / `pnpm ci`. CI runs the full set on the PR.

- Typecheck: `pnpm --filter <package> typecheck`
- Tests: `pnpm --filter <package> exec vitest related --run <changed files>`
