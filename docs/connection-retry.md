# Connection retry and the shell's connection states

How the environment client reconnects after a drop, and how the web shell turns
that into something a person can act on. Two layers, one rule between them: the
client owns *when* to dial, the shell owns *what the user is told*.

## The retry schedule

`packages/environment-client/src/websocket.ts` schedules every reconnect through
`reconnectDelayMs`, which is exported for tests and for anyone tuning a policy:

```
window = min(initialDelayMs * multiplier ** attempt, maxDelayMs)
delay  = window * (1 - jitter) + random() * window * jitter
```

`DEFAULT_RECONNECT` is `initialDelayMs: 500`, `multiplier: 2`,
`maxDelayMs: 15_000`, `jitter: 1` — full jitter over a doubling window, so
attempt *N* waits a uniform random delay in `[0, min(500ms · 2^N, 15s))`:

| attempt | window  | delay range     |
| ------- | ------- | --------------- |
| 0       | 500 ms  | 0 – 500 ms      |
| 1       | 1 s     | 0 – 1 s         |
| 2       | 2 s     | 0 – 2 s         |
| …       | …       | …               |
| 5+      | 15 s    | 0 – 15 s        |

The jitter is the point of the exercise. A restarted environment is a single
event observed by every client at once; without randomization they all re-dial
in the same millisecond, and the server's first breath is a thundering herd.
The delay never exceeds the window, so `maxDelayMs` stays a real ceiling.

`jitter` is a fraction of the window, not a mode: `1` is full jitter, `0`
disables it (the old fixed backoff), `0.5` keeps half the window fixed and
randomizes the rest. It and `maxAttempts` are optional, so a policy written
before jitter existed still type-checks and still behaves the way it did apart
from the randomization.

`random` is an option on the client (`() => number` in `[0, 1)`, defaulting to
`Math.random`), alongside the existing `timers`, `now`, `requestId` and
`WebSocket` seams. Tests inject all of them and assert exact delays.

## What resets, and what stops it

`attempt` counts consecutive failed attempts since the last successful
handshake and is published on the connection slice. A successful handshake
resets it to `0`, so the schedule always restarts at the short end.

Retries stop, and `connection.retriesExhausted` becomes `true`, when:

- the handshake fails terminally — `auth`, `protocol_incompatible` or
  `capability_missing`. Retrying an environment that refused the credential or
  cannot speak the protocol is pointless and, for `auth`, rude.
- `maxAttempts` is set and exhausted. It is unset by default, so the shipped
  client retries a reachable-but-down environment forever.

Only `connect()` starts the schedule again: it clears the timer, resets
`attempt`, clears a terminal failure and `retriesExhausted`, and dials. A
deliberate `disconnect()` or `dispose()` closes without scheduling anything and
is never reported as exhausted retries — the user asked for it.

## Heartbeats

Heartbeats (`packages/protocol/src/heartbeat.ts`) are the other half: backoff
only runs once a socket is known to be dead, and a TCP connection can be dead
for minutes without a close event. The client answers every server `ping` with
a `pong` and keeps a deadline; when the deadline passes with no server traffic
it closes the socket itself. That close is an ordinary drop, so it feeds the
same backoff schedule. Any server message — not just a ping — refreshes the
deadline.

## Resuming subscriptions

Subscriptions are per socket, so a drop invalidates all of them. On every
handshake the client re-establishes every scope it still holds, before the
catalog reads and before `session.open`; waiting for those would leave the open
session with no server-side subscription, and events produced in that window
would never be sent at all.

Cursors are kept per scope, not per socket or subscription ID, so they survive
the drop. A scope that has a cursor is resumed with `subscription.replay`
(`packages/protocol/src/replay.ts`), which carries the scope and the last
applied cursor; a scope with no cursor yet, or an environment that does not
advertise `subscription.replay`, falls back to a plain `subscription.subscribe`
and the reads that follow the handshake.

The environment answers a replay in one of two ways, and the live subscription
is part of either answer:

- **replay** — the exact contiguous tail `(cursor, head]`, applied through the
  same path as live events. A record at or below the held cursor of the same
  epoch is ignored, so an overlap between the tail and a live re-send is
  harmless, and the client ends at `head` with no hole.
- **snapshot** — the scope's state at `head`, replacing what the client had
  (`applySnapshot`), when the tail cannot be replayed: the cursor is from a
  different epoch (`stream_reset`), points ahead of the stream
  (`cursor_ahead`), or is behind what the environment still holds
  (`gap_expired`, which also covers a tail too large for one frame:
  `REPLAY_LIMITS` in `apps/server/src/db/replay.ts`). A first subscription
  with no cursor is answered the same way (`initial`).

`decideReplay` is the shared rule; the server reads head and retention
boundary together from `event_streams`, so the decision matches the log it
then reads. The server registers the subscription and answers in the same
tick as the read, so every event committed after the answer reaches the client
live and in order, after the answer. An answer the client cannot reconcile
with what it asked for (`parseReplayResult`) is not applied; the scope is
subscribed plainly instead. A scope the environment no longer has is dropped.

A thread snapshot carries all turns, pending interactions and the newest
history page of messages, as `session.open` followed by `session.history`
would load it; reasoning and tool state exist only in the event log, which is
what the snapshot stands in for, so they start over. An environment snapshot
carries the environment, every workspace and the newest page of sessions.

The catalog reads and the `session.open` of the active session still run after
recovery, as they did before replay existed: after an environment restart the
open is what re-attaches the provider session, and the history merge is keyed
by message ID, so it adds nothing a replay already delivered.

## How the shell maps this to UI

`apps/web/src/lib/connection-state.ts` derives one `ConnectionKind` from the
environment selection, the HTTP bootstrap result, the transport status, and the
browser's network status. `apps/web/src/components/connection-surfaces.tsx`
renders it as a blocking screen, a banner, or nothing.

| kind                    | surface | means                                      | user action |
| ----------------------- | ------- | ------------------------------------------ | ----------- |
| `no_environment`        | screen  | nothing configured yet                     | add one     |
| `incompatible_protocol` | screen  | versions cannot talk                       | upgrade     |
| `unauthorized`          | screen  | credential refused                         | fix it      |
| `ready`                 | none    | connected                                  | none        |
| `offline`               | banner  | no network, or retries stopped             | wait, or retry |
| `reconnecting`          | banner  | a live connection dropped, retries running | none        |
| `connecting`            | banner  | first attempt, never connected             | none        |
| `unreachable`           | banner  | endpoint answered badly or not at all      | retry       |

The three that are easy to confuse:

- **connecting** — the first attempt for this environment. Nothing has been
  established yet, so there is nothing to lose.
- **reconnecting** — a connection that existed has dropped and the backoff above
  is running. The shell stays mounted and the session stays on screen; no
  action is offered because the client is already handling it.
- **offline** — waiting will not help on its own. Either the device reports no
  network (`navigator.onLine === false`, tracked through the `online` /
  `offline` window events), or the client has stopped retrying
  (`retriesExhausted`). The no-network variant offers no button, because the
  only thing that fixes it is a network; the stopped-retrying variant offers
  **Retry** and **Change environment**.

Network listening lives in the web layer (`apps/web/src/lib/browser-runtime.ts`,
consumed by `ConnectionProvider`), never in the framework-agnostic client
package — Node, Electron and React Native all answer "is there a network"
differently. Coming back online bumps the same nonce a manual retry does, which
refetches the bootstrap and asks the socket to dial immediately rather than
waiting out its current window. An offline blip does not dispose the client:
its store, and the session on screen, outlive the gap.
