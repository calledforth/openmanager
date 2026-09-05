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

## Scaffold boundary

The public API includes `CommandEnvelopeSchema`, `ResponseEnvelopeSchema`,
`EventEnvelopeSchema`, `ErrorEnvelopeSchema`, and their discriminated union,
`EnvelopeSchema`. Each exports a corresponding inferred type without the
`Schema` suffix.

These initial shapes validate envelope structure only. Commands have a string
`requestId`, a string `name`, and a JSON `payload`; responses have a `requestId`
and JSON `payload`; events have a `name` and JSON `payload`. Error envelopes have
a `requestId` and an `error` containing string `code` and `message` fields.
Use `null` for an empty payload. Like Zod objects by default, these schemas
strip unknown envelope fields. They do not validate domain payloads or implement
command execution.

These are scaffolding shapes, not a finalized wire protocol. Detailed ID rules,
error codes and retry semantics, domain commands, subscriptions, cursors,
negotiation, heartbeat, and behavioral contract tests belong to subsequent work.
Keep the environment protocol separate from `@agentpack/contract`.

## Checks

```sh
pnpm --filter @openmanager/protocol build
pnpm --filter @openmanager/protocol typecheck
pnpm --filter @openmanager/protocol lint
pnpm --filter @openmanager/protocol test
```

Root `pnpm test` runs this suite before the desktop suite. Tests cover the public
exports, JSON envelope validation, inferred types, and a browser bundle executed
without Node globals. Desktop has a separate package-import smoke test. CI runs
the package build, typecheck, lint, and tests before desktop validation.
