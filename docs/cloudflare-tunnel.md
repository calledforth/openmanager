# Reaching an environment through a Cloudflare tunnel

The environment server can run a **named Cloudflare tunnel** itself. Other
devices then reach it at `https://<your hostname>`, from anywhere, with no
inbound port opened on the machine. Why a named tunnel and not a quick tunnel
is in [decisions/cloudflare-tunnel.md](./decisions/cloudflare-tunnel.md).

The server needs two inputs: the tunnel's **token** and its **public
hostname**. You create both once in your own Cloudflare account. Later,
managed provisioning will hand the server the same two inputs, and nothing
below changes.

## What the tunnel does and does not expose

- The server listens on `127.0.0.1` only, as it always has. `cloudflared`
  makes outbound connections to Cloudflare; nothing listens on a public
  address, and no router or firewall rule is needed.
- Requests from the internet reach the server through `cloudflared` on the
  same machine. Every one of them needs a client credential, exactly as on
  loopback (threat model D2). `/local-owner` answers `404` through the tunnel.
- Cloudflare terminates TLS, so it can see the traffic. That is an accepted
  risk in the [threat model](./threat-model.md).

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
   - The path must be empty. Pairing's `/pair` and the socket's `/ws` live at
     the root.
   - Leave "HTTP Host Header" under the additional settings empty.
     Cloudflare then passes your hostname through, which is what the server
     allows. Anything else is refused with `403`.
   - Route only the environment server through this tunnel. The dashboard can
     add more hostnames or services; the server cannot stop that, but it
     notices and says so (see `sharedIngress` below).
4. **Give the server the token and hostname.** Either for one run:

   ```sh
   # PowerShell: $env:OPENMANAGER_TUNNEL_TOKEN = '<token>'
   export OPENMANAGER_TUNNEL_TOKEN='<token>'
   node apps/server/dist/main.js --tunnel-hostname om.example.com
   ```

   or for the background service, which saves the token in the data
   directory and remembers the rest:

   ```sh
   export OPENMANAGER_TUNNEL_TOKEN='<token>'
   node apps/server/dist/main.js service install --tunnel-hostname om.example.com
   ```

5. **Check it.** `service status` (or the log) should reach
   `Tunnel: https://om.example.com (connected ...)` within a few seconds of
   the start. Open `https://om.example.com/health` from a phone on mobile data:
   it answers `{"status":"ok"}`.

The token is a secret: anyone who has it can run a connector for your tunnel
and receive its traffic. If it leaks, refresh it in the dashboard and give the
server the new one.

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
  there, or replacing it, takes effect without restarting the server.
- `--tunnel-token-file` and `--cloudflared` without `--tunnel-hostname` are
  refused. The environment variables without a hostname are ignored.

## How the server runs `cloudflared`

The server starts the connector once it is listening:

```
cloudflared tunnel --no-autoupdate --output json --loglevel info
  --metrics 127.0.0.1:0 --management-diagnostics=false run
```

with the token in the child's `TUNNEL_TOKEN` environment variable. The rest of
the child's environment is the server's, minus every `TUNNEL_*` variable
(each is a `cloudflared` setting that could redirect the tunnel or raise its
log level) and every `OPENMANAGER_*` variable. The log level is pinned to
`info` because at `debug` `cloudflared` logs request headers, and the socket
credential travels in one. Its log lines go to the server log at `debug`, with
the token cut out of any line that contains it.

The connector's origin comes from the dashboard (step 3), not from the
command line. The server reads it back from the connector's `/config` and
reports `sharedIngress: true` when any rule sends traffic anywhere but its own
loopback port.

### States

The server publishes one state, logged on every change and written to
`<data-dir>/tunnel-status.json`, which `service status` shows:

| State               | Meaning                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `starting`          | The connector runs but has no connection to Cloudflare yet.                                                 |
| `checking`          | Connected to Cloudflare; the server is checking that the hostname leads back to it.                         |
| `connected`         | Connected, and `https://<hostname>/bootstrap` answered with this environment's ID. Only now is `route` set. |
| `self_check_failed` | Connected, but the hostname does not lead here. `reason` says how.                                          |
| `down`              | The connector exited, or lost every connection to Cloudflare. It is reconnecting or restarting.             |
| `binary_missing`    | No `cloudflared` at `--cloudflared`, or none on `PATH`.                                                     |
| `token_missing`     | No `OPENMANAGER_TUNNEL_TOKEN` and no token in the token file.                                               |
| `stopped`           | The server is shutting down.                                                                                |

`reason` values:

- `token_invalid`: `cloudflared` cannot read the token (`down`).
- `tunnel_rejected`: the token reads, but Cloudflare refuses it, usually a
  deleted tunnel or a refreshed token (`starting`).
- `exited`, `reconnecting`, `unready`, `start_timeout`, `resumed_stale`: why
  the connector is down or was replaced (`down`).
- `other_environment`: the hostname answers as a different environment, for
  example the dashboard points it at another machine or port.
- `tunnel_unreachable`: Cloudflare answered `530`; the hostname's tunnel has
  no connector. Usually a hostname that belongs to a different tunnel.
- `http_<status>`: anything else, for example `http_403` when Cloudflare
  Access sits in front of the hostname. Let `/bootstrap` through Access, or
  the check cannot pass.
- `not_openmanager`, `unreachable`: the hostname answered with something that
  is not an environment, or not at all (DNS not there yet, timeout).

A failing tunnel never stops the server: local access keeps working whatever
the tunnel does.

### Recovery

`cloudflared` reconnects dropped connections on its own. The server checks the
connector's `/ready` every 5 seconds and steps in when that is not enough:

- **Crash or exit:** restarted after 1 s, doubling to at most 60 s. A
  connector that stays connected for a minute earns a fresh 1 s backoff. A
  token `cloudflared` cannot read waits the full 60 s between attempts.
- **Lost connections:** shown as `down` (`reconnecting`) at once. A connector
  still without a connection after 60 s is restarted.
- **Never connected:** a connector that has not connected 90 s after starting
  is restarted.
- **Sleep and resume:** a 5-second tick that arrives 30 s or more late means
  the machine slept. The server then probes at once and repeats the
  hostname check. A connector that claims to be connected but whose hostname
  check fails right after a wake is holding connections Cloudflare already
  dropped, and is restarted once. A restart that was waiting out its backoff
  runs at once.
- **Missing binary or token:** retried every 60 s, so installing
  `cloudflared` or saving the token recovers without a restart.

A passed hostname check is repeated every 10 minutes, in case the dashboard
changed; a failed one is retried after 15 s, doubling to 5 minutes.

### What a client sees

Cloudflare's own answers already map to the client's
[failure reasons](./environment-routes.md#the-route-in-use-fallback-and-reconnect):
`530` while the connector is down is `route_down`, `502` while the connector
runs but the server does not is `environment_offline`. Measured with a quick
tunnel: killing the server gives `502` at once; killing the connector gives a
`502` for a moment, then `530`.

## Background service

`service install` with a tunnel:

- saves `OPENMANAGER_TUNNEL_TOKEN`, when set, to the token file
  (`<data-dir>/tunnel-token`, readable only by you on Linux) and never writes
  the token into the logon task or the systemd unit, which other tools and
  accounts can read;
- refuses to install without a token, either in that variable or already in
  the token file;
- finds `cloudflared` now and bakes its absolute path in as `--cloudflared`,
  so the service does not depend on the `PATH` its supervisor provides, and
  refuses to install without one;
- bakes `--tunnel-hostname` and `--tunnel-token-file` in as flags.

To change the token later, overwrite the token file (or rerun `install` with
the variable set); the next connector start uses it. `service restart` forces
one.

`service status` adds a `Tunnel:` line, and `service status --json` a
`tunnel` object with the published status.

When the server stops normally it stops the connector. On Linux and WSL,
systemd also ends anything left in the unit. On Windows, a server that is
killed outright (Task Manager, `Stop-Process`) cannot, and its `cloudflared`
keeps running. That orphan is harmless, since it serves the same hostname
and origin as its replacement, but it lingers until you end it or sign out.

## Limits and follow-ups

- **Not built: reporting the route to clients.** The server knows its route
  once `connected`, but does not yet tell clients; a device adds
  `https://<hostname>` like any other address, through pairing or by typing
  it. See
  [environment-routes.md](./environment-routes.md#server-reported-routes).
- **One failed-credential budget for every device.** All tunnel traffic
  arrives from `cloudflared` on `127.0.0.1`, so devices behind the tunnel share
  one `auth_failure` and `pairing` budget. Tracked as a follow-up in the
  Cloudflare project.
- **Changing the hostname** is an owner action: rerun `install` (or restart
  with the new flag). Devices add the new address once, as the decision
  record describes; the old one stays listed as unavailable until forgotten.
