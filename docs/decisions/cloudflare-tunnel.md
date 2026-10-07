# Remote route: a named Cloudflare tunnel

Status: Accepted, 2026-10-06.

## Decision

The first release reaches an environment from other devices through a
**named Cloudflare tunnel**, set up by the person who owns the environment.
Quick tunnels (`*.trycloudflare.com`) are not built.

The environment server needs two inputs: a tunnel token and the tunnel's
public hostname. In v1 the owner creates both in their own Cloudflare account
(personal setup). Later, managed provisioning creates them for the owner. The
server's runtime stays the same, but managed provisioning has extra
conditions (see [Later: managed provisioning](#later-managed-provisioning)).

## Why not a quick tunnel

A quick tunnel needs no account, but its hostname changes every time a tunnel
is created: at least on every `cloudflared` restart, server restart or reboot.
The main reason for this project is a phone reaching a laptop that is
somewhere else, and that is the case a changing hostname breaks:

- Every remote device's saved route stops working at once.
- The device has no way to learn the new address. Until the account service
  in Wave 7 exists there is no control plane. Server-reported routes (see
  [environment-routes.md](../environment-routes.md#server-reported-routes))
  only reach a client that can still connect some other way, and a phone away
  from the laptop has no other way.
- Someone at the laptop has to send each device a new address. Each device
  then goes through the "Add a route?" consent prompt (CAL-99) again. Dead
  routes pile up in every device's record until someone forgets them.

Cloudflare's own terms point the same way. Quick tunnels have no uptime
guarantee and allow at most 200 in-flight requests (the rest get `429`). They
don't support Server-Sent Events, and Cloudflare offers them for testing and
development only.

## Why not a Worker on `workers.dev`

A tunnel's public hostname must belong to a zone in the owner's Cloudflare
account. `workers.dev` belongs to Cloudflare, so a tunnel cannot use one of
its names. A Worker on `<name>.workers.dev` could in principle front the
tunnel through Workers VPC. Cloudflare documents Workers VPC for HTTP and TCP,
not for proxying WebSockets, so it may not carry the socket at all. Even if it
did, it would put a Worker on the path that carries credentials, prompts and
terminal bytes. The Cloudflare project rules that out: a Worker, if any,
belongs in the control plane only.

## Personal setup (v1)

**Prerequisite:** a domain whose DNS is on Cloudflare (an active zone). The
Free plan is enough. Cloudflare Registrar sells domains at cost, about
$10 a year for `.com`. A domain bought somewhere else also works once its
nameservers point at Cloudflare.

**What the owner does once:**

1. In the Cloudflare dashboard, create a tunnel of type `cloudflared`.
2. Add one public hostname, for example `om.example.com`. Point it at the
   environment server's loopback listener, `http://127.0.0.1:<port>`, at the
   root path. Pairing's exact `/pair` path does not work behind a path prefix.
   Leave the route's "HTTP Host Header" setting empty: the server's `Host`
   allowlist relies on Cloudflare forwarding the public hostname.
3. Do not put a Cloudflare Access policy on the hostname in v1. Access would
   answer the server's own self-check with a login page. A device's own
   credential is what authorizes it.
4. Give the environment server the tunnel token and the hostname. CAL-109
   names the settings. Also allow the hosted web client's origin with
   `--allowed-origin` (see [web-hosting.md](./web-hosting.md)). Without it the
   server refuses every request from that page, and the page reads the
   refusal as the route being down.

**The tunnel token is a secret on par with the owner credential.** Anyone
holding it can run a second connector for the same tunnel and receive part
of the hostname's traffic, including the credentials devices send on the
socket upgrade. The self-check below cannot detect that. So:

- The token lives in a file in the server's data directory, readable only by
  the owner, like `owner-credential`. It is never written into the Windows
  task or the systemd unit, never put on a command line, and never logged.
  The server reads it before each connector start and passes it to the child
  process in the `TUNNEL_TOKEN` environment variable.
- To rotate it, use "Rotate token" in the dashboard, write the new token to
  the file, and restart the server. Connectors using the old token stay
  connected until they restart, so restart every machine that ran one.

**What the server does (CAL-109, CAL-110):**

- Adds the hostname to the `Host` allowlist. `/local-owner` already answers
  404 for a tunnel host or proxy headers (CAL-49), and that stays true.
- Starts `cloudflared tunnel run` and supervises it.
- Keys failed-attempt budgets by client, not by socket. Every request through
  the tunnel arrives from `cloudflared` on `127.0.0.1`. With one shared budget,
  a stranger who knows the hostname could lock pairing and every device out,
  including the owner's local browser; CAL-112 measured 14 failures in about
  90 seconds locking out every device. For a loopback socket whose `Host` is
  the tunnel hostname, the budgets for socket auth, pairing and uploads are
  keyed by `CF-Connecting-IP`. Without that header the request goes into a
  tunnel bucket kept apart from local traffic. A local process can forge the
  header and so get a fresh budget. That is accepted: credentials and pairing
  tokens are too long to guess either way.
- Runs a reachability check after the connector comes up, and repeats it
  while the tunnel runs, because the dashboard can change at any time. The
  server sends a fresh, single-use random value to its own hostname. The check
  passes only if that value arrives at this process's own listener. What
  comes back in the response is not trusted. No credential is sent on the
  check. A host that only pretends to be this environment, for example by
  serving a copy of its public `/bootstrap`, fails it. Until the check passes,
  the route is not offered to anyone.
- Reports the route as type `cloudflare` once server-reported routes exist.

**What the check does not prove.** Arrival shows the hostname reached this
server when it was checked. It does not show that nothing sits in between.
Whoever controls the zone, its DNS, or the tunnel's settings in the dashboard
can relay or redirect the hostname and see what devices send to it. That
includes credentials on the socket upgrade. This is the same trust already
given to Cloudflare, which terminates TLS. It is also the "consent, not
proof" gap that
[environment-routes.md](../environment-routes.md#merging-a-discovered-route)
records for routes. In v1 the zone and the dashboard are the owner's own
account, so the owner should protect that account like the machine. A
credential bound to a key on the device would close this gap; D6 in the
[threat model](../threat-model.md) plans that for cloud credentials.

Setting up or changing the tunnel is an owner action on the machine itself.
v1 adds no remote command for it. When one is added it needs `admin`, as
[capability-scopes-and-credentials.md](./capability-scopes-and-credentials.md)
already says.

The tunnel's routing (its ingress) lives in the dashboard, not on the
machine. The dashboard can point other hostnames on the same tunnel at other
local or LAN services, and they would bypass every check OpenManager makes.
In v1 that dashboard is the owner's, so the setup guide must say that the
tunnel carries only the environment server. CAL-109's "local origin is the
environment server only" means the server pins its own routing on the machine
where `cloudflared` allows it, and otherwise documents that it cannot.

## Later: managed provisioning

When accounts arrive (Wave 7), OpenManager owns a zone, and the account
service gives each linked environment its own hostname and connector token,
as T3 Connect does. The server receives the same two inputs from the link
instead of from the owner. If the account service replaces a tunnel, for
example after reclaiming an idle one, it keeps the hostname, so devices keep
their routes.

Managed provisioning hands the account service more than D6 allows today,
which is discovery data only. A service that holds connector tokens and
controls a tunnel's routing could run its own connector and read every linked
environment's traffic. It could also publish other services on the owner's
machine or LAN through the owner's connector. Neither is capped by the link's
grant. Before managed provisioning ships:

- The server must pin the connector's destinations on the machine to its own
  listener, so routing pushed from the account side cannot expose anything
  else. If `cloudflared` cannot do that for a managed tunnel, that is a reason
  not to ship managed provisioning in that form.
- Unlinking must stop the connector and delete the token on the machine, not
  only revoke credentials.
- The threat model must state the account service's new reach as an accepted
  risk with a recovery path, or the design must remove that reach.

Until then, remote access is available only to an owner who has a domain on
Cloudflare. That is acceptable because the first release is for personal use.

## What this means for the pairing payload

- **The link format does not change.** It is still
  `<app>/pair#v=1&route=…&environment=…&token=…`. `route` is the tunnel URL,
  `https://<hostname>`.
- **A link for another device should carry the tunnel route.** A loopback
  route is useless on another device. The pairing dialog already prefers the
  first saved route that is not loopback and warns when it only has a loopback
  one. The gap is that the creating client only knows the tunnel hostname if
  it is in that client's own list of routes. A local browser that never typed
  the hostname still offers loopback. The fix is on the server: report the
  tunnel route to an authenticated client, through server-reported routes or
  in the `pairing.create` reply, once the reachability check has passed.
- **The trust rules do not change.** A link's route is still a claim, and a
  credential is still never sent to it. A new device trades the token at
  `POST /pair`. A device that already has a credential redeems the token over
  its trusted socket.
- **The route saved at pairing stays valid.** The hostname survives
  restarts, sleep and connector replacement, so a device pairs once.

## What this means for route merge

- **Each device merges the tunnel route once,** normally when it pairs. Its
  record then holds the hostname next to any loopback route. Fallback order
  is unchanged: loopback first, then the tunnel.
- **A hostname change is the exception, not a routine event.** It happens
  only when the owner moves the tunnel on purpose. It is handled like any new
  address: the CAL-99 consent prompt for an address typed by a person, or a
  server-reported route arriving over the authenticated socket on a device
  that still reaches the environment some other way. The old route stays
  listed as unavailable until it is forgotten.
- **Server-reported routes stay as sketched,** merged only from the
  authenticated handshake. A stable hostname makes that merge a one-off, so
  v1 needs no pruning of stale tunnel routes. An authenticated report does not
  prove where the hostname leads; see
  [What the check does not prove](#personal-setup-v1).
- **CAL-110's check "Tunnel URL changes are merged as a route update"**
  narrows to the owner changing the hostname. Recovering after sleep and
  network changes keeps the same hostname.
- **A browser cannot read Cloudflare's error pages.** Cloudflare answers
  `530` once the tunnel is down. While the connector is dropping it answers
  `502` first, and `502` is also its answer when the tunnel is up but the
  environment is not. None of these pages carry CORS headers, so a page on the
  web client's origin sees a network failure for all of them. A browser cannot
  tell them apart, or tell them from a refusal by the server's origin check.
  Only clients that are not browsers, such as the mobile app, can read the
  status. CAL-112 measured this through a real tunnel and owns the failure
  states that follow from it. Until it lands, the failure-reason table in
  [environment-routes.md](../environment-routes.md#the-route-in-use-fallback-and-reconnect)
  still describes the older rule, which assumed a browser could read the
  status.

## Consequences

- Wave 5 testing needs a domain on Cloudflare before CAL-109 can be verified
  end to end.
- Cloudflare idles quiet WebSockets, so the protocol heartbeats are required
  through the tunnel (CAL-111). A 15-second heartbeat kept a socket open
  through a real tunnel for 70 idle seconds.
- Cloudflare terminates TLS and can see tunnel traffic. This is already an
  accepted risk in the threat model. Control of the owner's Cloudflare account
  or zone carries the same reach; see
  [What the check does not prove](#personal-setup-v1).
- If a no-account mode is wanted later, quick tunnels can be added as an
  opt-in labelled temporary. That needs a way to tell remote devices the new
  address, which in practice means the Wave 7 control plane.

## Related records

- Web hosting and route selection: [web-hosting.md](./web-hosting.md)
- Routes, merge and fallback: [environment-routes.md](../environment-routes.md)
- Pairing links and scopes: [capability-scopes-and-credentials.md](./capability-scopes-and-credentials.md)
- Threat model: [threat-model.md](../threat-model.md)
