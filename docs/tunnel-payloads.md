# Payloads over a tunnel

How much an environment sends a remote client, measured on 2026-10-06 through
a Cloudflare quick tunnel to a throwaway environment server. The client was the
web app in Chromium, recorded with the DevTools protocol. Real turns ran on
OpenCode with its free Big Pickle model.

Socket sizes are WebSocket payload bytes. The environment turns off
`permessage-deflate`, so that is close to what crosses the wire, before TLS and
framing. HTTP sizes are as received, after Cloudflare's compression.

## Numbers

| What                                                  | Frames    | Received                                 | Sent        |
| ----------------------------------------------------- | --------- | ---------------------------------------- | ----------- |
| `GET /bootstrap`                                      | 1 request | 2.7 KB of JSON, 1.0 to 1.1 KB compressed |             |
| Connect: handshake and the catalog reads, no sessions | 12        | 76 KB                                    | 1.7 KB      |
| `provider.catalog.get` within that                    | 1         | 71 KB                                    |             |
| `session.list`, per session                           |           | about 22 KB                              |             |
| Open a session with one earlier turn                  | 4         | 25 KB                                    | 0.8 KB      |
| One streamed answer of 150 words, no tools            | 49        | 64 KB                                    | 0.8 KB      |
| First turn of a new session, two tool calls           | 37        | 105 KB                                   | 1.6 KB      |
| Idle, per hour                                        | about 330 | about 40 KB                              | about 15 KB |

## Where the bytes go

**The model list, again and again.** A session's composer state carries the
provider's whole model list. For OpenCode on this machine that is about 21 KB.
It is in every session summary `session.list` returns, in `session.open`, and
in every `session.composer.updated` event: once per turn, and three times on a
new session's first turn. The provider catalog carries every provider's list
again: 71 KB on each connect, and 34 KB more in a `provider.catalog.updated`
during the first turn.

**Envelopes around stream deltas.** Each `message.delta` frame was about
890 bytes for 40 to 60 bytes of text. The rest is the subscription cursor
(scope with environment, session and thread IDs, epoch, sequence), the event
ID, a timestamp, and the message and turn IDs. The 150-word answer was 41
deltas: 36 KB for about 1 KB of text.

**Idle traffic.** The environment pings every 15 seconds, and a ping and its
pong are 68 bytes each: about 16 KB an hour each way. They also keep the socket
inside Cloudflare's idle timeout. The rest of an idle hour is provider health:
a burst of about seven `provider_health_changed` events (2.4 KB) every few
minutes as providers are checked again, about 25 KB an hour.

## What moves eagerly and what stays lazy

Nothing sends the repository. Files stay on the environment; the agent reads
them there, and a client only sees what the agent says about them. The folder
browser lists one folder when it is opened. There is no terminal, so there is
no scrollback to send.

History is paged. Opening a session asks for the newest page (50 messages) and
older pages come with **Load older messages**. One gap: every history page
carries all of the thread's turns, not only the page's (a known follow-up from
the session pagination work).

Images are uploaded once, when they are attached (`PUT`, the file's own size,
at most 25 MB). Each client that shows one fetches it once per page load
(`GET`, `no-store`, kept in memory as an object URL). Images are not
re-encoded. This was not measured end to end here: the free model refuses
images, so the composer would not attach one.

What is eager today, on every connect and every reconnect:

- the provider catalog, 71 KB;
- a page of up to 100 session summaries, each with its model list. A person
  with 100 OpenCode sessions downloads about 2.2 MB every time a phone wakes or
  the tunnel blips.

A single socket message over 1 MB also closes the socket: the environment
treats it as a slow consumer (`1008`). A session list with about 48 OpenCode
sessions on one page crosses that line. The model list should stay lazy:
fetched with the model picker, or referenced from the catalog by revision,
and left out of session summaries.

## What it means for the free tunnel

Cloudflare does not meter tunnel traffic, and these volumes are small. A day of
personal use, say 8 connected hours, 100 turns and 20 reconnects with 50
sessions, comes to about 0.4 MB of idle traffic, 6.5 MB of turns and 20 MB of
reconnects. Reconnects are the cost to cut, for a phone's data plan and for
time on a slow link, more than for the tunnel.

## Limits that apply

Quick tunnels allow 200 requests in flight. That cap is not relevant: remote
access uses a named tunnel, and a client holds one socket and makes an
occasional HTTP request.

Per-connection limits are what matter:

- The environment closes a socket whose unsent data would pass 1 MB (`1008`
  `slow_consumer`), checked per message. A slow link makes this likelier, and a
  single message over 1 MB always trips it.
- A client command may be at most 64 KB.
- Cloudflare closes a connection that is silent for about 100 seconds; the
  15-second heartbeat keeps it open. A Cloudflare restart can still drop a
  socket at any time, and the client resumes from its cursor.
- A request body through Cloudflare's Free plan may be at most 100 MB; the
  environment's own cap on an upload is 25 MB.

## No Worker on the token or terminal path

Nothing in this repository adds a Cloudflare Worker: there is no Worker
script, no `wrangler` configuration and no `workers.dev` route. The tunnel
decision rules one out, since it would sit on the path that carries
credentials, prompts and agent output. A browser sends its token, over the
socket subprotocol, straight to the tunnel hostname, and `cloudflared` hands it
to the environment's loopback listener. The static host for the web app
serves files only. There is no terminal; agent output uses the same socket.

## How the failure states were checked

The same setup was used to see what a browser gets when each part fails. See
[environment-routes.md](environment-routes.md#the-route-in-use-fallback-and-reconnect)
for how the client reads each one.

| Failure                                   | What the browser sees                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloudflared` stopped, server running     | Cloudflare answers `530`; `fetch` throws, a `no-cors` request is opaque, the socket closes `1006`                                                |
| Server killed, tunnel running             | Cloudflare answers `502`; the same as above                                                                                                      |
| Server stopped on purpose, tunnel running | The socket closes `1001` `server_shutdown`, then as above                                                                                        |
| Wrong or revoked token                    | `/bootstrap` answers normally; before this change the upgrade's `401` reached the browser as `1006`, now the socket closes `4401` `unauthorized` |
| Quick tunnel gone for about 15 minutes    | The hostname stops resolving; every request throws                                                                                               |
