# Heartbeat and idle-timeout contract

OpenManager uses an application-level heartbeat on every handshaken WebSocket.
The server initiates it because browser WebSocket clients cannot originate or
inspect WebSocket protocol ping/pong frames. Native transports may also use
protocol-level keepalives, but those do not replace this portable contract.

An environment implementing this contract advertises the
`connection.heartbeat` capability during bootstrap and handshake.

## Wire messages

The server sends a ping with a fresh, opaque ID:

```json
{ "type": "ping", "heartbeatId": "hb-42" }
```

The client immediately echoes that ID in a pong:

```json
{ "type": "pong", "heartbeatId": "hb-42" }
```

`HeartbeatPingSchema` and `HeartbeatPongSchema` validate these messages.
`ServerMessageSchema` accepts pings and `ClientMessageSchema` accepts pongs.
They are connection-control messages, not commands: they have no request ID,
terminal response, durable sequence, replay cursor, or subscription scope.
Unknown or stale pong IDs never acknowledge the current ping.

## Timing

`HEARTBEAT_POLICY` is normative for protocol version 1:

| Setting | Value | Meaning |
| --- | ---: | --- |
| `serverPingIntervalMs` | 15,000 ms | Time from handshake, or one sent ping, to the next ping |
| `pongTimeoutMs` | 10,000 ms | Maximum time the server waits for that ping's matching pong |
| `clientIdleTimeoutMs` | 45,000 ms | Maximum time the client accepts without any valid server message |

Each peer measures elapsed time with its own monotonic clock; timestamps never
cross the wire. Exactly one ping may be outstanding. A pong received at its
deadline is late. On timer or machine-sleep recovery, evaluate the overdue
timeout before sending more traffic.

The client resets its idle deadline after every valid server message, including
a ping. Other valid server traffic also proves that the connection is alive.
The server still requires a matching pong for an outstanding ping because that
proves the client received server traffic and can respond.

## Timeout behavior

After a client reaches `clientIdleTimeoutMs`, it closes the stale transport with
code `4000` and reason `heartbeat_timeout`, treats the connection as
disconnected, and enters its normal bounded-backoff reconnect loop. Pending
command identities and durable replay cursors follow the existing recovery
contract; a heartbeat timeout does not settle or blindly repeat a command.

After a server waits `pongTimeoutMs` without a matching pong, it closes the
socket with the same code and reason. It immediately releases every live
subscription and other connection-scoped resource for that socket. Durable
event history remains scope-owned so a later connection can recover through
replay or snapshot.

The pure helpers make those requirements explicit without owning a clock,
timer, socket, reconnect scheduler, or subscription registry:

- `advanceServerHeartbeat` returns `send_ping`, `wait`, or a `disconnect`
  action with `releaseSubscriptions: true`.
- `acceptHeartbeatPong` clears only a current, timely ping.
- `observeServerActivity` extends the client's liveness deadline.
- `advanceClientHeartbeat` returns a `disconnect` action with
  `enterReconnectLoop: true` when the deadline is reached.
- `respondToHeartbeat` creates the required pong for a validated ping.
