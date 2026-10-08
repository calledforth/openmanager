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
- the environment closes the socket with `4401` (`revoked`): the client's
  credential was revoked, or the owner credential it used was rotated. It is
  reported as an `auth` failure. A browser cannot see why a later upgrade is
  refused, so without this every redial would also count against the
  address's failed-credential limit. For the same reason the environment
  accepts a browser's upgrade with a credential it does not know and closes
  it with `4401` (`unauthorized`), which ends retries the same way.
- `maxAttempts` is set and exhausted. It is unset by default, so the shipped
  client retries a reachable-but-down environment forever.

A close with `1001` (`server_shutdown`) is the environment stopping on purpose.
It is retried like any drop, but the failure carries `serverStopped`, so the
reconnect strip's detail line can say the environment shut down rather than
that a tunnel is down.

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
would load it. Older pages the client had already loaded stay in front of it:
history is only appended to, so what the client holds before the first message
the page names is older than the page, and the cursor for the next older page
stays valid. Reasoning and
tool state exist only in the event log, which is what the snapshot stands in
for, so they start over. An environment snapshot carries the environment,
every workspace and the newest page of sessions.

The catalog reads and the `session.open` of the active session still run after
recovery, as they did before replay existed: after an environment restart the
open is what re-attaches the provider session, and the history merge is keyed
by message ID, so it adds nothing a replay already delivered.

## How the shell maps this to UI

`apps/web/src/lib/connection-state.ts` derives one `ConnectionKind` from the
environment selection, the HTTP bootstrap result, the transport status, the
browser's network status and, when no saved route answers, the route failure
(see [environment routes](./environment-routes.md)).
`apps/web/src/components/connection-surfaces.tsx` renders it as a blocking
screen, a strip that floats over the page, or nothing.

The strip is one component for every state that leaves the page in place. It
sits at the top of the main area, over the page rather than above it, so the
session underneath neither unmounts nor moves. What a person sees:

| Shown as | When | Spinner | Actions |
| --- | --- | --- | --- |
| **Can't reach *environment*** · Trying to reconnect… | Every failure that waiting resolves: a dropped connection (`reconnecting`), the search for another route, an unreachable bootstrap, and every route failure except a refused token (`unreachable`) | yes | Retry, Switch environment |
| **Connecting to *environment*** · Waiting for an answer… | The first attempt, before anything has failed (`connecting`) | yes | none |
| **You're offline** · Reconnects when the network is back. | The browser reports no network (`offline`) | no | none |
| **Can't reach *environment*** · Stopped retrying. | The client gave up (`offline` with `retriesExhausted`; only with a capped `maxAttempts`) | no | Retry, Switch environment |
| **Can't reach *environment*** · Not retrying. | An address a person typed did not answer (`unreachable` with `autoRetry: false`): only a saved environment's routes are searched and retried | no | Retry, Switch environment |
| **Not authorized** (screen) | The token was refused (`credential_rejected`, or an `auth` handshake failure); nothing is retried. A refused origin (`route_refused`) is a reconnect strip instead, and is retried | no | Switch environment |
| **Incompatible protocol** (screen) | Versions cannot talk | no | Retry, Switch environment |
| **No environment configured** / **Add a route to *environment*?** (screens) | Nothing is configured, or a new address waits for consent | no | the form or the question |

*environment* is the environment's label, or "the environment" when it has
none. The reconnect strip carries one muted detail line with the specific cause
("No answer from om.example.com", "om.example.com answered, but nothing is
connected behind it", "*environment* shut down"); that line, and the `reason`,
`endpoint`, `routesTried` and `shutDown` fields on the state, are for debugging.
The headline never changes with the cause. A strip that is retrying, or has
nothing to press, is a polite `status` live region; the stopped-retrying strip
waits on a person and is an `alert`. The sidebar's status chip and Settings use
the same headline (`connectionStatusLabel`).

Each route failure reason is placed in one exhaustive `switch`
(`routeFailureUi`): it either returns the reconnect state or its own state, and
a new reason does not compile until it is placed, so nothing falls into the
strip by accident.

The three kinds that are easy to confuse:

- **connecting** — the first attempt for this environment. Nothing has been
  established yet, so there is nothing to lose, and nothing says it failed.
- **reconnecting** — a connection that existed has dropped and the backoff above
  is running. It reads as "Can't reach *environment*", the same as any other
  wait, and the session stays on screen under the strip.
- **offline** — waiting will not help on its own. Either the device reports no
  network (`navigator.onLine === false`, tracked through the `online` /
  `offline` window events), or the client has stopped retrying
  (`retriesExhausted`). The no-network variant offers no button and no spinner,
  because the only thing that fixes it is a network; the stopped-retrying
  variant offers **Retry** and **Switch environment**.

Network listening lives in the web layer (`apps/web/src/lib/browser-runtime.ts`,
consumed by `ConnectionProvider`), never in the framework-agnostic client
package — Node, Electron and React Native all answer "is there a network"
differently. Coming back online bumps the same nonce a manual retry does, which
refetches the bootstrap and asks the socket to dial immediately rather than
waiting out its current window. An offline blip does not dispose the client:
its store, and the session on screen, outlive the gap.
