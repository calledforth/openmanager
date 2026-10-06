# Remote route: a named Cloudflare tunnel

Status: Accepted, 2026-10-06.

## Decision

The first release reaches an environment from other devices through a
**named Cloudflare tunnel**, set up by the person who owns the environment.
Quick tunnels (`*.trycloudflare.com`) are not built.

The environment server needs two inputs: a tunnel token and the tunnel's
public hostname. In v1 the owner creates both in their own Cloudflare account
(personal setup). Later, managed provisioning creates them for the owner, and
the server code stays the same.

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
- The server's `Host` allowlist would have to follow the changing hostname at
  runtime instead of being configured once.

Cloudflare's own terms point the same way. Quick tunnels have no uptime
guarantee and allow at most 200 in-flight requests (the rest get `429`). They
don't support Server-Sent Events, and Cloudflare offers them for testing and
development only.

## Why not a Worker on `workers.dev`

A tunnel's public hostname must belong to a zone in the owner's Cloudflare
account. `workers.dev` belongs to Cloudflare, so a tunnel cannot use one of
its names. A Worker on `<name>.workers.dev` could forward to the tunnel
(Workers VPC can reach one). That would put a Worker on the path that carries
credentials, prompts and terminal bytes. The Cloudflare project rules that out:
a Worker, if any, belongs in the control plane only.

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
3. Give the environment server the tunnel token and the hostname. CAL-109
   names the flags and environment variables.

**What the server does (CAL-109, CAL-110):**

- Adds the hostname to the `Host` allowlist. `/local-owner` already answers
  404 for a tunnel host or proxy headers (CAL-49), and that stays true.
- Starts `cloudflared tunnel run` and supervises it. The token is passed to
  the child process in the `TUNNEL_TOKEN` environment variable, never on the
  command line, where other processes can read it. The token is never logged.
- Checks itself after the connector comes up. It fetches
  `https://<hostname>/bootstrap` and requires its own `environmentId` back.
  The dashboard, not the server, decides where the hostname leads, so this
  check catches a hostname that points at another port or another machine.
  Until the check passes, the route is not offered to anyone.
- Reports the route as type `cloudflare` once server-reported routes exist.

Setting up or changing the tunnel is an owner action on the machine itself.
v1 adds no remote command for it. When one is added it needs `admin`, as
[capability-scopes-and-credentials.md](./capability-scopes-and-credentials.md)
already says.

The dashboard can point other hostnames on the same tunnel at other local
services. The server cannot see or prevent that. The setup guide must say that
the tunnel should carry only the environment server, which is CAL-109's
"local origin is the environment server only".

## Later: managed provisioning

When accounts arrive (Wave 7), OpenManager owns a zone, and the account
service gives each linked environment its own hostname and connector token,
as T3 Connect does. The server receives the same two inputs from the link
instead of from the owner, so the runtime above is unchanged. The account
service keeps only discovery data (D6 in the
[threat model](../threat-model.md)). If it replaces a tunnel, for example
after reclaiming an idle one, it keeps the hostname, so devices keep their
routes.

Until then, remote access is available only to an owner who has a domain on
Cloudflare. That is acceptable because the first release is for personal use.

## What this means for the pairing payload

- **The link format does not change.** It is still
  `<app>/pair#v=1&route=…&environment=…&token=…`. `route` is the tunnel URL,
  `https://<hostname>`.
- **A link made for another device carries the tunnel route,** once the
  self-check has passed. A loopback route is useless on another device. This
  belongs to the pairing UI (the web half of CAL-103, and CAL-107).
- **The trust rules do not change.** A link's route is still a claim, and a
  credential is still never sent to it. A new device trades the token at
  `POST /pair`. A device that already has a credential redeems the token over
  its trusted socket.
- **The route saved at pairing stays valid.** The hostname survives
  restarts, sleep and connector replacement, so a device pairs once.
- **Failed attempts share one budget.** All tunnel traffic reaches the server
  from `cloudflared` on `127.0.0.1`, so every device behind the tunnel spends
  one failed-credential budget. This is true of either tunnel type and
  remains an open follow-up for the Cloudflare project.

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
  v1 needs no pruning of stale tunnel routes.
- **CAL-110's check "Tunnel URL changes are merged as a route update"**
  narrows to the owner changing the hostname. Recovering after sleep and
  network changes keeps the same hostname.
- **Failure reasons already fit.** Cloudflare's `530` (tunnel down) is
  `route_down`. `502`/`503`/`504` (tunnel up, origin down) is
  `environment_offline`. A `403` from an optional Cloudflare Access gate is
  `route_refused`. See [environment-routes.md](../environment-routes.md#the-route-in-use-fallback-and-reconnect).

## Consequences

- Wave 5 testing needs a domain on Cloudflare before CAL-109 can be verified
  end to end.
- Cloudflare terminates TLS and can see tunnel traffic. This is already an
  accepted risk in the threat model.
- If a no-account mode is wanted later, quick tunnels can be added as an
  opt-in labelled temporary. That needs a runtime `Host` allowlist and a way
  to tell remote devices the new address, which in practice means the Wave 7
  control plane.

## Related records

- Web hosting and route selection: [web-hosting.md](./web-hosting.md)
- Routes, merge and fallback: [environment-routes.md](../environment-routes.md)
- Pairing links and scopes: [capability-scopes-and-credentials.md](./capability-scopes-and-credentials.md)
- Threat model: [threat-model.md](../threat-model.md)
