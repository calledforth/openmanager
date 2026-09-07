# Envelope contract

This contract defines the provider-neutral client/environment boundary. Both
ends import the same schemas from `@openmanager/protocol`. Schemas validate wire
structure; the execution host must enforce the behavioral rules below. No
transport, request registry, deduplication store, or command executor is provided
by this package.

## Direction and shapes

| Type       | Direction       | Required fields besides `type`          |
| ---------- | --------------- | --------------------------------------- |
| `command`  | Client → server | `requestId`, `name`, `payload`          |
| `response` | Server → client | `requestId`, `payload`                  |
| `error`    | Server → client | `requestId`, `error: { code, message }` |
| `event`    | Server → client | `name`, `payload`                       |

Use `ClientMessageSchema` at server ingress and `ServerMessageSchema` at client
ingress. `EnvelopeSchema` accepts all four types for tools that inspect both
directions. All payloads must be JSON values; use explicit `null` for no payload.
Missing payloads and nested `undefined`, functions, and non-finite numbers are
invalid. Domain schemas must additionally validate the command/event name and
its associated payload before dispatch.

Names are 1–128 ASCII characters: lowercase letter first, then lowercase letters
or digits, optionally separated by single `.`, `_`, or `-` characters. Examples:
`session.create`, `turn.interrupt`, `session.updated`. These examples illustrate
the naming convention, not domain schemas implemented in this change.

Unknown object fields on envelopes and `error` objects are stripped, preserving
the scaffold's additive-field compatibility policy. `error.details`, when
present, is retained as JSON so a code-specific schema can validate it. JSON
payload fields are preserved for the domain validator. Unknown envelope types
and error codes fail validation. A parser must never turn a failed parse into a
successful response. Version/capability negotiation has a
[separate contract](./negotiation.md).

## Identity and responses

`requestId` is an opaque, case-sensitive client-generated string of 1–128 ASCII
letters, digits, underscores, or hyphens. A UUID is a suitable generation strategy;
the schema does not require a particular UUID version. IDs are not trimmed,
case-folded, or coerced. They are not authentication credentials or session IDs.

Generate a fresh ID for every new logical command. Keep it unchanged when
recovering the outcome of that same command. A client must avoid ID reuse across
its connections to an environment. A server must isolate request identities by
authenticated client and environment; an ID alone must not expose another
client's result. The authentication mechanism and retention window are defined
by the future execution host/reconnect contract.

Every valid command has exactly one logical terminal result: either `response`
or a correlated `error`, echoing its request ID exactly. A success with no result
uses `payload: null`. Events can arrive before or after that terminal result and
do not settle the command. Concurrent command results can arrive in any order;
match by ID, never by arrival position or command name.

Duplicate delivery is not a new command: within the host's supported recovery
window, the same identity and same command must join the pending execution or
replay its identical terminal result, without a second effect. A different
command using an existing identity is a connection-level protocol violation:
reject it with an uncorrelated `conflict` (`requestId: null`) and close that
connection. Do not overwrite or execute the original command. The uncorrelated
error preserves the original command's one terminal result; the client must
reconcile its pending commands after disconnect. Clients must never intentionally
issue concurrent different commands with the same ID.
Deduplication storage and retention belong to the host. The reusable
[behavioral conformance tests](./conformance.md) verify the observable guarantee;
schema validation alone cannot guarantee exactly-once execution.

A disconnect or local timeout is **not** a terminal server error. The command
may already have run. Preserve its identity and reconcile through the host's
supported recovery mechanism; do not blindly submit a new ID. Until the host
defines recovery/retention semantics, automatic resubmission is not supported.
Clients ignore already-settled identical results, and treat conflicting results
for one identity as a protocol failure rather than applying both.

## Invalid messages and uncorrelated errors

An error has `requestId: null` only when no safe command identity is available,
for example invalid JSON, a missing/invalid ID, ambiguous ID reuse, or a
connection-level failure.
It never settles a particular pending command. Omission of `requestId` is invalid.
When a malformed command has a valid ID that the server can safely associate
with the sender, return a correlated `validation` error with that ID. A valid
command must never receive `null` as its terminal result's ID.

Clients cannot send responses, events, or error envelopes. Servers cannot send
commands. Reject invalid direction before dispatch. The connection owner decides
whether an invalid message warrants closing the transport; error envelopes are
not an instruction to echo another error and create an error loop.

## Errors and recovery

`error.code` is stable and machine-readable. `error.message` is nonempty text
(at most 4096 characters) suitable for display, without stack traces, credentials,
or provider internals. Clients branch on the code, never on message text.

Every correlated error terminates that logical command. `ERROR_RETRY_POLICY`
describes whether a **new attempt with a new ID** may be appropriate after the
client handles the error. Replaying the failed ID still returns the same error.

| Code                 | Meaning                                                                                                                 | Exported policy / client action                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `auth`               | Authentication or authorization prevents execution; no effect occurred.                                                 | `after_auth`: sign in/refresh or obtain access before a new attempt. Never loop while access remains denied.                     |
| `validation`         | Invalid envelope, unknown command, or invalid payload; no effect occurred.                                              | `after_change`: fix the request first. Terminal for the unchanged request.                                                       |
| `not_found`          | A referenced resource does not exist or is not visible; no effect occurred.                                             | `after_change`: refresh state or select another resource.                                                                        |
| `conflict`           | State precondition failed or a request identity was reused for a different command; the rejected attempt had no effect. | `after_change`: reconcile state or fix ID generation. The original command may still run for an ID collision.                    |
| `capability_missing` | This environment cannot perform the operation; no effect occurred.                                                      | `never`: disable it for this environment/capability set.                                                                         |
| `protocol_incompatible` | Client and environment protocol versions differ; no command was dispatched.                                        | `after_upgrade`: show the incompatibility state and retry only after the client or environment changes version.                  |
| `unavailable`        | Temporary capacity/dependency failure **before any effect**.                                                            | `after_backoff`: retry with bounded backoff and a new ID.                                                                        |
| `internal`           | Unexpected execution failure; effects may already have occurred.                                                        | `reconcile`: show failure and recover/check the outcome before considering a new attempt. Never automatically repeat a mutation. |

Use `internal`, not `unavailable`, whenever the host cannot guarantee that no
effect occurred. None of these policies makes arbitrary commands idempotent.
Unknown error codes are protocol validation failures, not retryable errors.

## JSON examples

Client command:

```json
{
  "type": "command",
  "requestId": "req-1",
  "name": "example.command",
  "payload": { "text": "hello" }
}
```

Exactly one of these terminal results for that command:

```json
{ "type": "response", "requestId": "req-1", "payload": { "accepted": true } }
```

```json
{
  "type": "error",
  "requestId": "req-1",
  "error": { "code": "validation", "message": "Invalid payload" }
}
```

Independent event and uncorrelated malformed-message error:

```json
{ "type": "event", "name": "example.event", "payload": { "text": "hello" } }
```

```json
{
  "type": "error",
  "requestId": null,
  "error": { "code": "validation", "message": "Invalid request ID" }
}
```

Executable examples live in `tests/fixtures.ts`. Both Node tests and a browser
bundle round-trip the same fixtures through JSON serialization and the public
directional schemas.
