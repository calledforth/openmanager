# Server-owned session titles

A session's name is an environment-owned field, not a client guess. SQLite holds
`sessions.title` next to `sessions.title_source`, and `SessionSummary` carries
both, so a sidebar reads the same name the environment would replay.

| Trigger                                            | Source     |
| -------------------------------------------------- | ---------- |
| First prompt of a session that has no real title   | `fallback` |
| Provider reports a title for its own session       | `provider` |
| `session.rename`                                   | `user`     |

`titleFromPrompt` in `@openmanager/protocol` derives the fallback: the prompt
collapsed to a single line and cut to 80 characters. There is no model call —
the name has to be there the moment the turn is accepted, and the provider
supplies a better one shortly afterwards where it supports titles (see
`docs/OPENCODE_SESSION_TITLES_RESEARCH.md`; a provider title arrives after the
first assistant reply, and Claude Code and Codex may never send one).

Precedence lives in one place, `shouldReplaceSessionTitle`. A rename outranks
everything and is never overwritten by a later fallback or provider title. A
provider title replaces a fallback and revises its own earlier titles. A
fallback only fills a placeholder — an empty name or one of the generated
`ACP Session …` / `New session - N` forms — so the first meaningful turn names
the session and every later turn leaves it alone. The thread service settles
this against the in-memory record; the projector repeats the user rule in SQL so
a replayed or third-party event cannot drop a rename either.

The thread service appends an environment-scoped `session.updated` carrying
`{ sessionId, title, titleSource }` in the **same transaction** as the event that
caused it — `turn.started` for the fallback, the rename command for a rename —
and publication happens only after commit. Environment scope is the point:
every connected sidebar subscribes to it, so a session that no client has opened
still gets its name without pulling a transcript. A title that cannot be written
is logged through the host's persistence handler and never fails the turn that
triggered it.

Clients apply the event and keep the source on the summary; the optimistic
rename path stamps `user` locally so an in-flight provider title cannot win a
race against the user. The shared sidebar renders `New session` for a session
that has no title yet.

A title supplied on `session.create` is treated as a fallback in memory. It is
stored without provenance, which changes nothing in practice: a non-placeholder
title is not replaced by a later fallback either way, and a provider title
replaces it in both cases.
