# @openmanager/protocol

Shared runtime schemas and inferred TypeScript types for the OpenManager
environment boundary. Zod is the only runtime dependency. Source code has no
Node, Electron, Convex, or agent-provider dependencies.

## Consume from a workspace app

Add `"@openmanager/protocol": "workspace:*"` to the app's dependencies, then:

```ts
import { EnvelopeSchema, type Envelope } from '@openmanager/protocol'

const incoming: unknown = JSON.parse(receivedText)
const result = EnvelopeSchema.safeParse(incoming)
if (result.success) {
  const envelope: Envelope = result.data
  // Dispatch the validated envelope.
}
```

The package exports TypeScript source, following the other shared workspace
packages. Desktop and future web/server TypeScript bundlers can import it
without a separate build. `pnpm --filter @openmanager/protocol build` also
emits standard ESM JavaScript and declarations to `dist/`; plain Node can import
the emitted `dist/index.js`. No browser or Node ambient types are enabled in
the library's TypeScript configuration.

## Wire contract

The public API includes `CommandEnvelopeSchema`, `ResponseEnvelopeSchema`,
`EventEnvelopeSchema`, `ErrorEnvelopeSchema`, and their discriminated union,
`EnvelopeSchema`. Each exports a corresponding inferred type without the
`Schema` suffix.

Use `ClientMessageSchema` at server ingress (commands only) and
`ServerMessageSchema` at client ingress (responses, errors, events). The general
`EnvelopeSchema` is useful for tooling but does not enforce direction.

See [the envelope contract](./docs/envelopes.md) for ID rules, response correlation,
error codes, recovery policies, malformed-message handling, and JSON examples.
`RequestIdSchema`, `MessageNameSchema`, `ErrorCodeSchema`, `ProtocolErrorSchema`,
and `ERROR_RETRY_POLICY` are public exports with corresponding inferred types.

The [proof slice](./docs/proof-slice.md) adds `ProofCommandSchema`, per-command
`ProofResponseSchemas` and `parseProofResult`, `ProofEventSchema`, and exact
environment/session/thread subscription scopes. Use the domain schemas directly
on incoming JSON when dispatching this slice.

The [replay contract](./docs/replay.md) adds per-scope cursors, the
`subscription.replay` command with replay/snapshot results, `subscription.event`
live delivery, and the `decideReplay`/`parseReplayResult` helpers.

The [negotiation contract](./docs/negotiation.md) adds the protocol version,
HTTP bootstrap schema, open-ended capability names, client bootstrap states,
and the application-level WebSocket handshake. Use `evaluateBootstrap` to gate
a client from one bootstrap response and `negotiateProtocolHandshake` /
`parseProtocolHandshakeResult` at the WebSocket boundary.

The [heartbeat contract](./docs/heartbeat.md) defines portable server-initiated
ping/pong messages, fixed timing, client reconnect behavior, and server cleanup
behavior. Its pure state helpers drive transport timers without depending on a
browser or Node runtime.

These schemas validate structure and domain payloads; they do not execute
commands or provide HTTP/WebSocket transports. Duplicate-command behavioral
tests belong to subsequent work.
Keep the environment protocol separate from `@agentpack/contract`.

## Checks

```sh
pnpm --filter @openmanager/protocol build
pnpm --filter @openmanager/protocol typecheck
pnpm --filter @openmanager/protocol lint
pnpm --filter @openmanager/protocol test
```

Root `pnpm test` runs this suite before the desktop suite. Tests cover the public
exports, directional validation, ID boundaries, errors, and shared JSON fixtures
round-tripped in Node and a browser bundle without Node globals. Desktop has a
separate package-import smoke test. CI runs
the package build, typecheck, lint, and tests before desktop validation.

## Node server consumers

Headless Node applications can import `@openmanager/protocol/node` after running
`pnpm --filter @openmanager/protocol build`. This subpath supplies emitted
JavaScript and declarations, including for applications using Node's native
TypeScript stripping. The root export remains source-based for bundler consumers.
