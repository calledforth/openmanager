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

## Protocol bumps ship with a server release

The server and the desktop/web/phone clients must speak the same protocol
(`PROTOCOL_VERSION` in `packages/protocol/src/negotiation.ts`). A client on a
newer protocol than the installed server cannot connect at all.

- A PR that raises `PROTOCOL_VERSION` must also bump `version` in
  `apps/server/package.json`.
- Right after it merges, tag and push the server release
  (`git tag -a server-v<version> -m "OpenManager server <version>"`,
  `git push origin server-v<version>`; see `docs/RELEASING.md`). Don't leave a
  protocol bump on `main` without a published server release.
- If you can't release the server, don't merge the protocol bump.
