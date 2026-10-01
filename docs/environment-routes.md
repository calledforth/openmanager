# Environment routes

An environment is one server with one stable `environmentId`. A URL is only a
way to reach it. The web client keeps the two apart so that a second URL, or a
tunnel whose address changed, never becomes a second environment with its own
sessions, token and sidebar entry.

## The stored record

`apps/web/src/lib/environment-store.ts` keeps one record per environment in
`localStorage` (`openmanager-environments`, version 2):

```ts
{
  environmentId: string
  label: string
  credential: string          // one token per environment, never per URL
  routes: Array<{
    type: string              // 'local' | 'remote' today; open for later types
    endpoint: string          // http(s) URL
    priority: number          // the person's order, 0 first
    health: {
      status: 'unknown' | 'available' | 'unreachable' | 'unauthorized'
      changedAt?: string      // ISO time the status last changed
      message?: string
    }
  }>
}
```

Identity rules:

- Records are found by `environmentId` only. An endpoint is never an identity:
  a reused localhost port or a moved tunnel can lead to a different server.
- Session, thread and workspace IDs are minted by the environment and carry no
  URL. The socket client is keyed by `environmentId`; a different route gives
  it a new socket URL and nothing else.
- Connecting to a URL whose bootstrap answers with a known `environmentId`
  adds that URL as a route to the existing record and keeps its token. See
  [Merging a discovered route](#merging-a-discovered-route).

Version 1 stored `endpoints: string[]`, most recently used first. It is read
as routes in the same order and rewritten as version 2 on first load.

## Merging a discovered route

A connect is a person entering an address. What the address is to this client
depends on the `environmentId` its bootstrap answers with
(`classifyDiscoveredRoute`):

| The answer's ID | The address | What connecting does |
| --- | --- | --- |
| Not saved | any | Adds a new environment with this one route. |
| Saved | already a route of it | Makes the route the one in use and updates its health. |
| Saved | new to it | Adds the address to that record as the route in use. Never a second record. |

In every case the record is found by `environmentId`, so the label, the token,
the other routes and everything the environment minted stay where they were. A
tunnel whose address changed is the third row: the new address joins the
record and the old one stays listed, reported as unavailable, until it is
forgotten.

The third row has one condition. `/bootstrap` is unauthenticated, so the ID in
an answer is a claim anyone can make, and the token is sent on the socket
upgrade that follows. Merging on the claim alone would hand a saved token to
whatever answered. So:

- If the connect brings its own token (typed, or claimed from a loopback
  address's `/local-owner`), the address is merged straight away. The saved
  token is replaced by the one given and is never sent to the new address.
- If the connect brings no token and the record has one, the client stops and
  asks: "Add a route to *label*?", naming the address and saying the saved
  token will be sent to it. Until the person agrees the address is not saved
  and no socket is opened on it. **Cancel** drops it and returns to the saved
  selection.
- If the record has no token there is nothing to send, and the address is
  merged straight away.

The question shows the label the record already has, not the one the address
answered with, which is also only a claim.

This is consent, not proof: a person who agrees to a hostile address still
sends it the token. Proof needs the environment to show it holds the
credential before the client reveals it, which is a server and protocol change
(see [Server-reported routes](#server-reported-routes)).

The same rule holds outside a merge: a socket is only opened on a route that
has answered, on this attempt, as the environment whose token the socket would
carry. A connect that is still waiting for its answer has no identity and gets
no socket, and being offline is not an answer. A client that already exists
is kept through an offline gap, and through a connect that re-enters the route
in use, so the session it holds is not dropped.

Two environments stay two environments. A different `environmentId` at a new
address is always its own record with its own token, and a saved route that
starts answering as another environment is reported, not adopted
(see [Health](#health)).

## Credentials and client cache

The registry stores the credential on the record selected by `environmentId`.
Changing a route keeps that credential; an address is never used to look up a
token.

The web client also keeps one in-memory store per environment ID. A route or
credential change replaces the transport while retaining sessions, messages,
and the active selection. Each new transport reopens the active session's
subscriptions and refreshes authoritative data from the server.

IndexedDB persists a snapshot in `openmanager-environment:<environmentId>`
(database version 1, `state` object store). Neither URLs nor credentials are
part of that cache. A fresh client loads the snapshot after verifying the
route's environment identity and exposes it only after the WebSocket
authenticates. Live connection state, pending sends, and in-flight hydration
are not restored. Storage failures fall back to memory.

All session catalog pages are refreshed, keeping older sessions navigable.
Older catalog pages refresh in the background so the active session recovers
after the first page. Inactive agent runtimes are never opened to check cache
membership. Once every page has answered, a cached session missing from all
of them is removed, which covers sessions deleted while the client was
offline. Keyset pages are not one snapshot, so a concurrent update can move a
session ahead of the cursor without deleting it. A catalog that fits in one
page is one query and needs no more checks. Otherwise, before removing
anything, the client re-reads the newest pages down to the walk's newest
session. It repeats that from each re-read's own newest session until one
pass fits in a single page, and removes nothing if three passes never do.
It keeps any session that live events touched during the refresh,
the active session (its `session.open` decides), and parents of listed
sessions. Workspace membership and composer preferences are refreshed from
the server. Snapshot writes are serialized per
environment so cleanup cannot overwrite newer data with an older snapshot.
Deleted active sessions are removed when the environment reports them missing.
There was no previous IndexedDB cache to migrate.

## Route type

The client assigns `local` to a loopback address and `remote` to everything
else. That is a fact about the address, not a guess about the network behind
it, which is why there is no `cloudflare` or `tailscale` yet: a custom domain
in front of a tunnel is indistinguishable from any other host.

`type` is an open string. A value this client does not know is kept as written
and shown as is, so a type reported by the environment later needs no storage
change. See [Server-reported routes](#server-reported-routes).

## Priority: the user chooses

Priority is the user's order of preference, `0` first.

- Connecting by a URL makes that route the first choice and the one in use.
- **Use** on a route in the environment list makes it the first choice and
  the one in use, and reconnects.
- **Forget** drops a route. The last route cannot be forgotten; remove the
  environment instead.

Nothing else changes priority. Falling back to another route changes which
route is in use, not the order, so a tunnel that is down for an hour does not
lose its place for good.

## The route in use, fallback and reconnect

The route in use is the client's pick for this page, kept in memory beside
the registry. It starts at the first route in search order and moves when that
route fails. A reload, or selecting the environment again, starts over from the
top.

**Search order** is every local (loopback) route first, then the rest, each
group in the person's order. A loopback route is this device talking to
itself, so when it answers no tunnel or network path is needed. A person who
chooses a remote route with **Use** while a local one answers keeps it until
the next reload or reselection.

**What starts a search** (`startRouteSearch` in `connection-provider.tsx`):

| Trigger | What is asked |
| --- | --- |
| The bootstrap on the route in use fails, is refused, or answers as another environment | Every other route, all at once. The interface says it is trying another route. |
| The live socket drops | The route in use on its own first. If it still answers, the drop is a blip left to the socket's own backoff. If not, every other route. |
| No route answered last time | Every route again, quietly, after 2 s, 4 s, 8 s, 15 s, then every 30 s. |

Routes are asked at once but chosen in search order: a route is only taken
once every route ahead of it has failed, so a slow local answer still beats a
fast tunnel. A route that answers is made the route in use, and the ordinary
bootstrap then verifies it before a socket is opened on it, as for any route.
The environment, its token and its sessions never change; only the socket URL
does.

Nothing is searched while a typed connect is in flight (the person chose that
address), while the device is offline (nothing would answer; coming back
online asks again), or after the environment refused the token.

**A refused token is not a route failure.** When the socket is refused with
`auth`, the environment itself rejected the token, and every route carries the
same one, so no other route is tried and nothing is retried. A `401`/`403` on
`/bootstrap` is different: that endpoint takes no token, so the refusal is about
the route or the browser (a tunnel's access gate, or the environment's origin
check), not the token, and the next route is tried.

**Why it failed.** When no route answers, the client shows one reason, worked
out from every route it asked (`route-fallback.ts`):

| Reason | Learned from | Shown as |
| --- | --- | --- |
| `environment_offline` | Nothing answers on a loopback route (nothing listens on this device), or a gateway answers `502`/`503`/`504` (Cloudflare, Tailscale and ngrok all do this when their tunnel is up and the origin is not) | Environment offline |
| `route_refused` | `401`/`403` on `/bootstrap`: a tunnel's access gate, or the environment refusing this browser's origin | Route refused access |
| `route_down` | Nothing answers over a network, another HTTP error (Cloudflare's `530` is its tunnel being down), or something that is not an environment | Route unavailable |
| `wrong_environment` | The address answers as another environment | Environment unreachable |
| `credential_rejected` | The socket is refused with `auth` | Not authorized |

The first four are ranked in that order when routes disagree: a sign that the
server is down explains every other failure, and a refusal is something a
person can act on. Over a network, silence cannot tell a tunnel that is down
from a machine that is off, and the wording says so ("the environment itself
may still be running"). `/playground/connection` shows each one.

While no route answers, the socket is closed and the reason stays on screen
until a route answers again, at which point the client reconnects on its own.
**Retry** asks again straight away.

**Known gaps.** A route whose bootstrap answers but whose socket can never
connect (a proxy that does not pass WebSocket upgrades) is treated as a blip
and retried by the socket indefinitely; it is not given up on. Being on a
fallback route does not switch back when a route ahead of it recovers: moving
a working connection is a disruption, so it waits for the next reload,
reselection or failure.

## Health

Health is the last thing this client learned about a route, persisted so it
survives a reload. It is written only when the status or its message changes.

| Source | When | Result |
| --- | --- | --- |
| `GET /bootstrap` on the route in use | every connect, retry and reload | `available`, `unreachable` or `unauthorized` |
| The socket on the route in use | it connects, drops, or is refused | `available`, `unreachable` (`unavailable`), `unauthorized` (`auth`) |
| A probe of every other saved route | the environment list appears | same as bootstrap |

A route counts as `available` only if the answer comes from the environment it
belongs to. An answer carrying another `environmentId` is recorded as
`unreachable` with "A different environment answers at this address." When
that happens on the route in use, the selection does not move: the client stays
on the environment the user chose and opens no socket, so its token is never
sent to whatever answered, and tries the environment's other routes. Only
connecting to the address by hand adopts it.

A protocol mismatch is still `available`: the route reached the environment.
`unreachable` and `unauthorized` stay separate so the interface can tell a
tunnel that is down from one that refuses this client.

A route search records what it learned on every route it asked, the same as a
probe does.

## Server-reported routes

Not built. The environment does not yet say how it can be reached, so the
client only knows the URLs a person typed. The intended shape, for when the
Cloudflare tunnel lands:

- Bootstrap gains an optional `routes: [{ type, endpoint }]`, advertised behind
  a capability. `BootstrapResponseSchema` already accepts unknown fields, so
  older clients ignore it and no protocol version bump is needed.
- The server lists what it knows first-hand: its loopback listener as `local`,
  and a tunnel it started itself as `cloudflare`.
- The client merges that list into the record for the answering
  `environmentId`: unknown endpoints are appended after the existing ones, and
  a known endpoint takes the reported `type`.

Routes must only be merged from an answer the client can trust. `/bootstrap`
is unauthenticated, so a list taken from it could point a trusted environment
at someone else's address and send the token there on the next connect. The
merge belongs on the authenticated handshake, or behind a check that the
advertised route answers with a proof only that environment can give. A person
is not there to ask when a list arrives on its own, so the consent step used
for a typed address does not carry over.
