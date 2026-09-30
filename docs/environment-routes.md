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
    priority: number          // 0 is the route in use
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

Two environments stay two environments. A different `environmentId` at a new
address is always its own record with its own token, and a saved route that
starts answering as another environment is reported, not adopted
(see [Health](#health)).

## Route type

The client assigns `local` to a loopback address and `remote` to everything
else. That is a fact about the address, not a guess about the network behind
it, which is why there is no `cloudflare` or `tailscale` yet: a custom domain
in front of a tunnel is indistinguishable from any other host.

`type` is an open string. A value this client does not know is kept as written
and shown as is, so a type reported by the environment later needs no storage
change. See [Server-reported routes](#server-reported-routes).

## Priority: the user chooses

Priority is the user's order of preference and `0` is the route in use.

- Connecting by a URL makes that route the one in use.
- **Use** on a route in the environment list moves it to `0` and reconnects.
- **Forget** drops a route. The last route cannot be forgotten; remove the
  environment instead.

Nothing changes priority on its own. A route that stops answering is reported
and the connection keeps retrying it; the client does not move a live session
to another route by itself. Automatic fallback is a separate decision
(CAL-101) and would read this same order.

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
sent to whatever answered. Only connecting to the address by hand adopts it.

A protocol mismatch is still `available`: the route reached the environment.
`unreachable` and `unauthorized` stay separate so the interface can tell a
tunnel that is down from one that refuses this client.

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
