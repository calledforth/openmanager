# Reaching an environment through a Cloudflare tunnel

The environment server can run a **named Cloudflare tunnel** itself. Other
devices then reach it at `https://<your hostname>`, from anywhere, with no
inbound port opened on the machine. Why a named tunnel and not a quick tunnel
is in [decisions/cloudflare-tunnel.md](./decisions/cloudflare-tunnel.md).

The server needs two inputs: the tunnel's **token** and its **public
hostname**. You create both once in your own Cloudflare account. Later,
managed provisioning will hand the server the same two inputs; the decision
record lists what it needs first.

## What the tunnel does and does not expose

- The server listens on `127.0.0.1` only, as it always has. `cloudflared`
  makes outbound connections to Cloudflare; nothing listens on a public
  address, and no router or firewall rule is needed.
- Requests from the internet reach the server through `cloudflared` on the
  same machine. Every one of them needs a client credential, exactly as on
  loopback (threat model D2). `/local-owner` answers `404` through the tunnel.
- Cloudflare terminates TLS, so it can see the traffic. That is an accepted
  risk in the [threat model](./threat-model.md). Whoever controls your
  Cloudflare account, the zone's DNS or the tunnel's dashboard settings has
  the same reach, so protect that account like the machine.

## Set it up

You need a domain whose DNS is on Cloudflare (an active zone; the Free plan is
enough) and the `cloudflared` binary.

1. **Install `cloudflared`.** Get it from Cloudflare's
   [downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   (on Windows, `winget install --id Cloudflare.cloudflared` also works). Put
   it on `PATH`, or note its full path for `--cloudflared`. On WSL, install the
   Linux build inside the distro, not the Windows one. Do not install it as a
   system service (`cloudflared service install`): the environment server
   starts and stops it.
2. **Create the tunnel.** In the Cloudflare dashboard, go to Zero Trust,
   Networks, Tunnels, and create a tunnel of type **Cloudflared**. Give it any
   name. On the install page, copy the token: it is the long string after
   `--token` in the command Cloudflare shows. Do not run that command.
3. **Add one public hostname.** Pick a subdomain and domain, for example
   `om.example.com`, leave the path empty, and set the service to
   **HTTP** and `127.0.0.1:<port>`, where `<port>` is the environment
   server's port (`43120` unless you changed it).
   - The path must be empty. Pairing's `/pair`, the socket's `/ws` and the
     server's own check at `/tunnel-check` live at the root.
   - Leave the route's "HTTP Host Header" setting empty. The server's `Host`
     allowlist relies on Cloudflare forwarding the public hostname; anything
     else is refused with `403`.
   - Route only the environment server through this tunnel. The dashboard can
     add more hostnames or services, which would bypass every check the server
     makes. The server cannot stop that (see
     [The tunnel's routing](#the-tunnels-routing)), but it notices and says
     so.
4. **No Cloudflare Access policy on the hostname.** v1 does not support one.
   Access would answer the server's own check with a login page, and a
   device's own credential is what authorizes it.
5. **Give the server the token and hostname.** Read the token in without
   echoing it, so it does not land in your shell history:

   ```sh
   # bash or zsh
   read -rs OPENMANAGER_TUNNEL_TOKEN && export OPENMANAGER_TUNNEL_TOKEN
   # PowerShell (5.1 and 7)
   $env:OPENMANAGER_TUNNEL_TOKEN = [Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Tunnel token')).Password
   ```

   Then either run the server once:

   ```sh
   node apps/server/dist/main.js --tunnel-hostname om.example.com
   ```

   or install the background service, which saves the token in the data
   directory and remembers the rest:

   ```sh
   node apps/server/dist/main.js service install --tunnel-hostname om.example.com
   ```

   You can also paste the token into `<data-dir>/tunnel-token` with an editor
   (by default `~/.openmanager/tunnel-token`, or
   `%USERPROFILE%\.openmanager\tunnel-token` on Windows) and leave the
   variable unset. On Linux and WSL the server narrows the file to mode
   `0600` the first time it reads it.

6. **Allow the web client's origin.** A browser page on the hosted web client
   calls the server from its own origin, so add it with `--allowed-origin`
   (for example `--allowed-origin https://app.example.com`; see
   [decisions/web-hosting.md](./decisions/web-hosting.md)). Without it the
   server refuses every request from that page, and the page reads the
   refusal as the route being down.
7. **Check it.** `service status` (or the log) should reach
   `Tunnel: https://om.example.com (connected ...)` within a few seconds of
   the start. Open `https://om.example.com/health` from a phone on mobile data:
   it answers `{"status":"ok"}`.

## The tunnel token

**The token is a secret on par with the owner credential.** Anyone holding it
can run a second connector for the same tunnel and receive part of the
hostname's traffic, including the credentials devices send on the socket
upgrade. The server's check cannot detect that.

- It lives in `<data-dir>/tunnel-token` (or `OPENMANAGER_TUNNEL_TOKEN`), never
  on a command line, in the Windows task or the systemd unit, or in the log.
- **Routine rotation:** use "Rotate token" in the dashboard, write the new
  token to the token file, and restart the server (`service restart`).
  Connectors using the old token stay connected until they restart.
- **If the token may have leaked,** restarting your own machine is not enough:
  a connector someone else started keeps its connection. Rotate the token,
  disconnect every connection to the tunnel from the dashboard, then restart
  only your own connector with the new token. Credentials captured while the
  other connector ran stay valid, so also revoke or rotate every device that
  connected through the tunnel in that window (Settings → Devices), re-pair
  where needed, and rotate the owner credential with `client.owner.rotate` if
  it was used through the tunnel.

## Configuration

| Flag                  | Environment variable            | Default                                                     |
| --------------------- | ------------------------------- | ----------------------------------------------------------- |
| `--tunnel-hostname`   | `OPENMANAGER_TUNNEL_HOSTNAME`   | none. Without it there is no tunnel.                        |
| none (no flag)        | `OPENMANAGER_TUNNEL_TOKEN`      | none. Wins over the token file.                             |
| `--tunnel-token-file` | `OPENMANAGER_TUNNEL_TOKEN_FILE` | `<data-dir>/tunnel-token`                                   |
| `--cloudflared`       | `OPENMANAGER_CLOUDFLARED`       | the first `cloudflared` (`cloudflared.exe`) found on `PATH` |

- The hostname is a bare DNS name (`om.example.com`): no scheme, port or
  path. It is added to the `Host` allowlist automatically; `--allowed-host` is
  not needed for it.
- The token has no flag on purpose. Any process on the machine can read
  another process's command line, so the token is only ever an environment
  variable or a file. The server removes `OPENMANAGER_TUNNEL_TOKEN` from its
  own environment once read, so provider CLIs, agents and terminals it starts
  do not inherit it.
- The token file is read again before every connector start. Saving a token
  there, or replacing it, takes effect at the next connector start.
- `--tunnel-token-file` and `--cloudflared` without `--tunnel-hostname` are
  refused. The environment variables without a hostname are ignored.

## How the server runs `cloudflared`

The server starts the connector once it is listening:

```
cloudflared tunnel --config <data-dir>/cloudflared.yml --no-autoupdate
  --output json --loglevel info --metrics 127.0.0.1:0
  --management-diagnostics=false run
```

with the token in the child's `TUNNEL_TOKEN` environment variable.

- **Environment.** The child gets the token and only the variables a program
  needs to find its home and temporary folders, use a proxy and trust
  certificates (`PATH`, `HOME`/`USERPROFILE`, `TEMP`, `SystemRoot`,
  `HTTPS_PROXY`, `SSL_CERT_FILE`, `GODEBUG` and the like). Provider keys and
  every other variable of the server stay out, and so does every `TUNNEL_*`
  variable, each of which is a `cloudflared` setting that could redirect the
  tunnel or raise its log level.
- **Configuration file.** `<data-dir>/cloudflared.yml` is written by the
  server and holds no settings that matter. Without it, `cloudflared` would
  read `~/.cloudflared/config.yml`, and a leftover `url:` or `loglevel:` there
  would apply to this tunnel. If the file cannot be written, the connector
  is not started at all.
- **Logging.** The log level is pinned to `info` because at `debug`
  `cloudflared` logs request headers, and the socket credential travels in
  one. Its log lines go to the server log at `debug`, except that one error
  line a minute is logged as a warning, so an owner at the default level sees
  why a tunnel does not come up. The token is cut out of any line that
  contains it.

### The tunnel's routing

A token tunnel is managed from the dashboard: its routing (ingress) is pushed
to the connector by Cloudflare and replaces any routing given on the machine.
The connector reports its local configuration as version `-1`, and a pushed
configuration always has a higher version. So the server **cannot pin** the
connector's destinations to its own listener; CAL-109's "local origin is the
environment server only" is the owner's responsibility in v1. This has not
been tried against a live dashboard tunnel yet; the decision record makes
pinning a condition for managed provisioning.

What the server does instead: it reads the routing back from the connector's
`/config` when the connector connects, when it logs a configuration update and
after every passed check, and reports `sharedIngress: true`, with a warning in
the log, when any rule sends traffic anywhere but its own loopback port.

### The check

After the connector connects, and every 10 minutes while it runs, the server
checks that the hostname reaches **this process**. It sends a fresh,
single-use random nonce to `https://<hostname>/tunnel-check?nonce=…`, without
any credential. The check passes only if that nonce arrives at the server's
own listener through the tunnel; what comes back in the response is not
trusted. A host that only pretends to be this environment, for example by
serving a copy of its public `/bootstrap`, fails it. Until the check passes,
the tunnel is not `connected` and no route is offered.

`/tunnel-check` gives nothing away: the nonce of a check in flight gets an
empty `204`, anything else the same `404` as an unknown path. Misses spend a
`tunnel_check` budget of their own (30 a minute per client), never the
credential budget.

The check proves arrival, not that nothing sits in between. Whoever controls
the zone, its DNS or the tunnel's dashboard settings can relay the hostname
here and read what devices send to it. That is the trust already given to
Cloudflare; see "What the check does not prove" in the decision record.

### States

The server publishes one state, logged on every change and written to
`<data-dir>/tunnel-status.json`, which `service status` shows:

| State               | Meaning                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `starting`          | The connector runs but has no connection to Cloudflare yet.                                                      |
| `checking`          | Connected to Cloudflare; the server is checking that the hostname reaches it.                                    |
| `connected`         | Connected, and the check's nonce arrived here. Only now is `route` set.                                          |
| `self_check_failed` | Connected, but the hostname does not reach this server. `reason` says how.                                       |
| `down`              | The connector exited, or lost every connection to Cloudflare. It is reconnecting or restarting.                  |
| `binary_missing`    | No `cloudflared` at `--cloudflared`, or none on `PATH`.                                                          |
| `token_missing`     | No `OPENMANAGER_TUNNEL_TOKEN` and no token in the token file (`token_malformed`: the file holds something else). |
| `stopped`           | The server is shutting down.                                                                                     |

`reason` values:

- `token_invalid`: `cloudflared` cannot read the token (`down`).
- `token_malformed`: the token file holds more than one line, or nothing
  (`token_missing`).
- `tunnel_rejected`: the token reads, but Cloudflare refuses it, usually a
  deleted tunnel or a rotated token (`starting`, or `down` once the connector
  is replaced).
- `exited`, `spawn_failed`, `reconnecting`, `unready`, `start_timeout`,
  `resumed_stale`: why the connector is down or was replaced (`down`).
- `config_unwritable`: `<data-dir>/cloudflared.yml` could not be written, so
  the connector is not started (`down`); retried every 60 s.
- `not_arrived`: something answered at the hostname, but the nonce never
  reached this server. The dashboard points the hostname at another machine
  or port, the public hostname has a path (so the check falls to the
  catch-all rule), or something else serves the name.
- `tunnel_unreachable`: Cloudflare answered `530`; the hostname's tunnel has
  no connector. Usually a hostname that belongs to a different tunnel.
- `http_<status>`: any other answer without arrival. The common ones:
  `http_403` when "HTTP Host Header" is set in the dashboard (the server
  refuses that `Host`), `http_302` or `http_403` when Cloudflare Access sits
  in front of the hostname, `http_502` when the dashboard points the hostname
  at a port where nothing listens.
- `unreachable`: no answer at all (DNS not there yet, timeout).

A failing tunnel never stops the server: local access keeps working whatever
the tunnel does.

### Recovery

`cloudflared` reconnects dropped connections on its own. The server checks the
connector's `/ready` every 5 seconds and steps in when that is not enough:

- **Crash or exit:** restarted after 1 s, doubling to at most 60 s. A
  connector that stays connected for a minute earns a fresh 1 s backoff. A
  token `cloudflared` cannot read waits the full 60 s between attempts.
- **Lost connections:** shown as `down` (`reconnecting`) after two failed
  probes in a row. A connector still without a connection after 60 s is
  restarted.
- **Never connected:** a connector that has not connected 90 s after starting
  is restarted.
- **Sleep and resume:** a 5-second tick that arrives 30 s or more late means
  the machine slept. The server then probes at once and repeats the check; a
  check that began before the sleep is discarded. If the connector claims to
  be connected but Cloudflare answers that check with `530`, the connector is
  holding connections Cloudflare already dropped, and it is restarted once.
  Other failures after a wake, such as no network yet, are retried as usual.
  A restart that was waiting out its backoff runs at once.
- **Missing binary or token:** retried every 60 s, so installing
  `cloudflared` or saving the token recovers without a restart.

A passed check is repeated every 10 minutes; a failed one is retried after
15 s, doubling to 5 minutes.

### Failed-attempt budgets behind the tunnel

Every request through the tunnel reaches the server from `cloudflared` on
`127.0.0.1`. One shared budget would let a stranger who knows the hostname
lock pairing and every device out, the owner's local browser included. So for
a loopback request whose `Host` is the tunnel hostname, the `auth_failure`,
`pairing` and `tunnel_check` budgets are keyed by `CF-Connecting-IP`, the
address Cloudflare sets at its edge (IPv6 grouped by /64). A tunnel request
without that header goes into one tunnel bucket, kept apart from local
traffic, which keeps its own keys.

The header decides nothing else: not identity, not `/local-owner`. A local
process can forge it and so get fresh budgets; that is accepted because
credentials and pairing tokens are too long to guess either way. Devices
behind one address (one home network) still share a budget. A Cloudflare WAF
rate-limiting rule on `/ws` and `/pair` (the Free plan has one) blunts floods
from many addresses.

### What a client sees

A browser cannot read Cloudflare's error pages: they carry no CORS headers,
so a page on the web client's origin sees a network failure for `530`
(connector down), `502` (connector dropping, or tunnel up and server down)
and for a refusal by the server's origin check alike. Clients that are not
browsers can read the status. Measured with a quick tunnel: killing the
server gives `502` at once; killing the connector gives a `502` for a moment,
then `530`. The decision record and CAL-112 own the client-side failure
states.

## Background service

`service install` with a tunnel:

- saves `OPENMANAGER_TUNNEL_TOKEN`, when set, to the token file
  (`<data-dir>/tunnel-token`, written as a new file readable only by you on
  Linux, then renamed into place; on Windows it takes the data directory's
  permissions, by default those of your user profile, like the owner
  credential) and never writes the token into the logon task or the systemd
  unit, which other tools and accounts can read;
- refuses to install without a token, either in that variable or already in
  the token file;
- finds `cloudflared` now and bakes its absolute path in as `--cloudflared`,
  so the service does not depend on the `PATH` its supervisor provides, and
  refuses to install without one;
- bakes `--tunnel-hostname` and `--tunnel-token-file` in as flags.

To change the token later, follow [The tunnel token](#the-tunnel-token).

`service status` adds a `Tunnel:` line, and `service status --json` a
`tunnel` object with the published status.

The connector does not outlive its server. Without the server it would
answer every device with a 502 instead of letting Cloudflare report the
environment unreachable, so it ends with the server, however the server
ends:

- **A normal stop** stops it.
- **A crash** (an uncaught exception or unhandled rejection) kills it on
  the way out, from the server's `exit` handler.
- **On Windows, a server killed outright** (Task Manager's End task,
  `Stop-Process -Force`, `taskkill /F`) takes it along: Node starts its
  children in a job object that Windows closes, ending them, when the server
  process ends. This holds for the logon task, `node --watch` and a server
  started by hand alike, so nothing is left to clean up at the next start.
- **On Linux and WSL**, the systemd unit ends anything left in it when the
  server stops. A server you run in a terminal yourself and kill with
  `kill -9`, or that the runtime aborts (out of memory), leaves its
  `cloudflared` running: Linux has no such job. End it by hand.

## Limits and follow-ups

- **Not built: reporting the route to clients.** The server knows its route
  once `connected`, but does not yet tell clients, in server-reported routes
  or the `pairing.create` reply. A device adds `https://<hostname>` like any
  other address, and a local browser that never typed the hostname still
  makes pairing links with a loopback route. See
  [environment-routes.md](./environment-routes.md#server-reported-routes).
- **A device with a revoked credential keeps redialing.** A browser sees a
  refused upgrade as a dropped connection, so a device revoked while it was
  offline retries about every 15 s and spends its address's budget. With the
  per-address budgets above it no longer locks out other networks.
- **Changing the hostname** is an owner action: rerun `install` (or restart
  with the new flag). Devices add the new address once, as the decision
  record describes; the old one stays listed as unavailable until forgotten.
