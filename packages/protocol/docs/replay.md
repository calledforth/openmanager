# Sequencing, cursors and replay

## Cursor scope

Every subscription scope (environment, session, thread) has its own independent
stream. A cursor is `{ scope, epoch, sequence }`:

- `sequence` increases by exactly one per durable event within a scope, starting
  at 1. Zero is the empty stream. Sequences belong to scopes, not sockets or
  subscriptions, so a client keeps one cursor per scope it follows.
- `epoch` changes whenever the host cannot preserve a scope's sequence history
  (for example a rebuilt store). Sequences are only comparable within an epoch.
- `turn.notice` is transient and never receives a cursor.

Provider sequence numbers and event timestamps are never cursors.

## Messages

| Message | Shape |
| --- | --- |
| `subscription.replay` command | `{ scope, cursor \| null }`; `null` requests an initial snapshot |
| Replay response | `{ mode: 'replay', subscriptionId, from, to, events }` — exactly the contiguous range `(from, to]` in one epoch, no duplicates |
| Snapshot response | `{ mode: 'snapshot', subscriptionId, reason, snapshot }` — full current state for the scope with its cursor |
| `subscription.event` | `{ subscriptionId, record: { cursor, event } }` live delivery after the response |

Both response modes establish the subscription; live events continue from the
response's `to` or snapshot cursor. Validate responses against the pending
command with `parseReplayResult(command, json)`, which also checks the request ID.
`decideReplay(scope, cursor, head, oldestAvailableSequence)` gives the host the
decision below.

## Behavior

| Situation | Result |
| --- | --- |
| No cursor | snapshot, `initial` |
| Cursor within retained range | replay from the cursor to head (possibly empty) |
| Cursor older than the oldest retained event | snapshot, `gap_expired` |
| Cursor sequence ahead of the host's head | snapshot, `cursor_ahead` |
| Cursor epoch differs from the host's epoch | snapshot, `stream_reset` |
| Cursor from another environment or scope | `validation` error; no snapshot is offered |

A snapshot's `reason` must be consistent with the requested cursor; clients
reject a contradictory reason. A foreign cursor is rejected before any state is
read so a client can never obtain another environment's snapshot by presenting
its cursor.
