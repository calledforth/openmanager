# Protocol and capability negotiation

The HTTP bootstrap is the first versioned boundary between a client and an
environment. Its protocol-owned fields are:

```json
{
  "protocolVersion": 7,
  "environmentId": "env-local",
  "capabilities": ["session.read", "turn.send"]
}
```

`BootstrapResponseSchema` requires a positive safe-integer protocol version, an
opaque environment ID, and a unique list of capability names. Capability names
follow the message-name syntax and are open-ended so a newer host can advertise
features an older client does not know. Unknown advertised capabilities do not
make an otherwise compatible bootstrap fail.

The bootstrap schema preserves unknown top-level fields. The HTTP owner can add
connection metadata such as an environment label or WebSocket URL without this
base parser discarding it. An extension must still validate those fields with
its own schema before using them.

## Client decision

`PROTOCOL_VERSION` is the version implemented by this package. A breaking wire
change increments it; additive capabilities and bootstrap fields do not.
Compatibility is deliberately exact. Clients and hosts must not
guess that different versions are compatible. Version 2 adds `interaction.expired`;
version-1 peers are rejected before subscriptions so expiry cannot be silently
ignored or repeatedly encountered during replay. Version 3 adds
`availableCommands` to the session composer selection: that object is strict, so
a version-2 peer would reject every session summary and
`session.composer.updated` event that carries the new field. Version 4 adds
`usage` to the same selection, for the same reason. Version 5 adds
`promptCapabilities` to the provider composer profile and `supportsImageInput`
to its model rows: both objects are strict, so a version-4 peer would reject
every `provider.catalog.get` response and `provider.catalog.updated` event.
Version 6 adds the draft's `preference` and `modeId` to `session.create`. That
payload is not strict, so a version-5 environment would drop both and start the
chat in the wrong mode instead of refusing it. Version 7 adds `artifactIds` to
`session.create`, which a version-6 environment would drop along with the
images, and lets an upload ticket name a workspace in place of a session for a
draft; the upload result then carries `workspaceId` and no `sessionId`.

Call `evaluateBootstrap` with the parsed HTTP body and the capabilities required
by the current client path:

```ts
const state = evaluateBootstrap(body, {
  requiredCapabilities: ['session.read', 'turn.send'],
})

switch (state.state) {
  case 'ready':
    connect(state.bootstrap)
    break
  case 'incompatible_protocol':
    showUpgradeState(state.clientProtocolVersion, state.serverProtocolVersion)
    break
  case 'capability_missing':
    disableUnsupportedFeatures(state.missingCapabilities)
    break
}
```

Version incompatibility takes precedence over capability checks because a
different version may assign different meaning to a capability name. Every
state retains the validated bootstrap, so the client can identify the
environment and render a stable state from this response without opening a
WebSocket or inspecting message text.

## WebSocket application handshake

After the transport opens, the first application command is
`protocol.handshake`. It carries the client's protocol version and the
capabilities required for that connection:

```json
{
  "type": "command",
  "requestId": "handshake-1",
  "name": "protocol.handshake",
  "payload": {
    "protocolVersion": 7,
    "requiredCapabilities": ["session.read"]
  }
}
```

The host must complete this handshake before dispatching any other command or
creating subscriptions. `negotiateProtocolHandshake` applies the same decision
as the HTTP bootstrap and returns exactly one correlated result:

- A compatible handshake returns a `response` whose payload is the bootstrap.
- A version mismatch returns `protocol_incompatible` with structured client and
  server versions. Its retry policy is `after_upgrade`.
- Missing required capabilities return `capability_missing` with a structured
  `missingCapabilities` list.

The host sends the returned error and closes the socket without executing later
messages. Both older-client/newer-host and newer-client/older-host mismatches use
the same stable error code. `parseProtocolHandshakeResult` checks request
correlation and rejects a success whose version contradicts the request.

Handshake error details are valid JSON retained by the general
`ServerMessageSchema`; the specialized parser validates their code-specific
shape. Clients branch on `error.code` and structured details, never message
text.

This package defines and tests application-level negotiation behavior. It does
not implement an HTTP route, open or close a WebSocket, authenticate a client,
or own an environment label/URL. Those transport and bootstrap fields belong to
the future server and client integrations.
