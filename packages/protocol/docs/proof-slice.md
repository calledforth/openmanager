# Proof slice

The first domain families cover environment discovery, workspaces, sessions,
threads, text prompts, turns, streamed messages and user interactions. This is
a shared wire contract and an opt-in agent-event mapper, not a running server.
HTTP version/capability bootstrap, persistence, authorization, reconnect, replay,
files, git and terminal operations are separate work.

## Parsing

Parse the original decoded JSON directly with `ProofCommandSchema` or
`ProofEventSchema`. Do not first parse a domain event with the generic envelope
schema: its additive-field policy strips the domain's scope, event ID and timestamp.
The generic envelopes remain available for inspection and future message families.

Responses carry no command name. Retain the pending command's name beside its
request ID and call `parseProofResult(pendingCommand, decodedJson)`. This selects
the correct payload schema from `ProofResponseSchemas` and verifies the request
ID for both success and error results. An uncorrelated error (`requestId: null`)
must go to the connection handler; it cannot settle a pending command.

```ts
import { ProofCommandSchema, parseProofResult } from '@openmanager/protocol'

const command = ProofCommandSchema.parse({
  type: 'command',
  requestId: 'request-1',
  name: 'session.list',
  payload: { workspaceId: 'workspace-1' },
})
const result = parseProofResult(command, {
  type: 'response',
  requestId: 'request-1',
  payload: { sessions: [] },
})
```

## Commands and terminal successes

All commands execute within the authenticated connection's environment. Resource
IDs refer to host-owned identities, not a provider's session or thread IDs.

| Command                    | Payload                             | Success payload                                        |
| -------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `environment.get`          | `null`                              | `{ environment }` with environment ID and display name |
| `workspace.list`           | `null`                              | `{ workspaces }`                                       |
| `session.list`             | `{ workspaceId }`                   | `{ sessions }`                                         |
| `session.create`           | `{ workspaceId, title? }`           | `{ session, thread }` with the initial thread          |
| `session.open`             | `{ sessionId }`                     | `{ session, threads, messages, turns, interactions }`  |
| `turn.send`                | `{ sessionId, threadId, text }`     | `{ turn, userMessage }`                                |
| `turn.interrupt`           | `{ sessionId, threadId, turnId }`   | `{ turnId }` acknowledging the interrupt request       |
| `interaction.respond`      | `{ sessionId, threadId, response }` | `null`                                                 |
| `subscription.subscribe`   | `{ scope }`                         | `{ subscriptionId, scope }`                            |
| `subscription.unsubscribe` | `{ subscriptionId }`                | `null`                                                 |

`environment.get` provides domain discovery over the command channel. It does
not replace the future HTTP bootstrap or promise version negotiation.

`session.open` loads current state; it does not start a turn or implicitly
subscribe. Collections are complete for this initial proof slice; pagination
is not implied. Consistent snapshot/live handoff is specified with replay work.
Each open interaction includes its thread ID. The host must enforce resource
ownership, session/thread/turn membership, and consistent references in results.
Shape validation alone cannot establish those database relationships.

`turn.send` accepts a text prompt; multimodal prompt submission is outside the
initial command family. Success means the host accepted the turn and assigned
identities, not that generation has completed. A host permits at most one active
turn per thread for this slice and returns `conflict` for an incompatible send.
`turn.interrupt` targets a specific turn so a late request cannot cancel the next
turn. Success acknowledges cancellation, while an eventual lifecycle event
determines the final state. An already terminal turn may acknowledge as a no-op.

Interaction responses are discriminated by `kind`: permission selects an option,
question supplies answers, and plan accepts/rejects. All kinds allow cancellation.
The host checks that the interaction is still pending, belongs to the target
thread, and that option/question IDs and answer cardinality match the original
request. An expired or already settled interaction is a conflict. Interaction IDs
are distinct from command request IDs. Option/question/todo IDs are local opaque
tokens within that interaction and are not global provider resource identities.
Plan continuation explicitly distinguishes `same_turn` from `follow_up_turn`;
acceptance must not trigger a second execution when the original turn continues.

## Subscriptions and event ownership

Scopes are exact, non-recursive streams:

| Scope       | Required fields                                          | Events owned by this scope                            |
| ----------- | -------------------------------------------------------- | ----------------------------------------------------- |
| Environment | `{ type: 'environment', environmentId }`                 | workspace changes, session creation/metadata/deletion |
| Session     | `{ type: 'session', environmentId, sessionId }`          | thread creation                                       |
| Thread      | `{ type: 'thread', environmentId, sessionId, threadId }` | turns, messages, tool summaries, interactions         |

An environment subscription does not implicitly deliver every thread's content.
An active chat normally subscribes to the environment, selected session, and
selected thread. The host verifies all scope IDs against the authenticated
environment and access rights; knowing an ID grants no access. Scope objects are
strict so an extra/misplaced ID cannot silently widen a subscription.

Each subscribe command allocates a connection-local subscription ID. Its success
establishes the subscription before live delivery begins. Repeating that command
with the same request identity follows the envelope deduplication rules; a new
command may create another subscription to the same scope. Unsubscribe is
idempotent for an absent ID in that connection and removes only that subscription.
Events already in flight may arrive afterward. Disconnect releases all live
subscriptions; reconnect must establish new ones. Sequence/cursor semantics and
gap-free snapshot/replay handoff are intentionally deferred to the replay contract.

Events have a host-assigned `eventId`, an ISO-8601 `timestamp` with a UTC offset,
and exactly one owning `scope`. The same logical event retains its event ID if
delivered to multiple subscribers. Timestamps are informational, not ordering
keys; provider sequence numbers are never synchronization cursors.

The public event families are listed in `ProofEventSchemas` and illustrated in
`tests/proof-fixtures.ts`. A turn starts with a user message; message/reasoning
deltas and tool summaries follow, then a completed/interrupted/failed event.
`turn.notice` is nonterminal. `message.reasoning` preserves start/delta/stop even
when no text exists, and zero is a valid token reading. Interaction requested and
resolved events carry the same host interaction identity and their owning turn.

Later file/git/terminal families can use an appropriate existing scope or add an
explicit new scope under protocol versioning. They must not smuggle new scope
types through the generic JSON payload or widen the meaning of existing scopes.

## Mapping agent events

The runtime exports `projectAgentEvent` from `@agentpack/runtime/protocol`.
`@openmanager/protocol` retains Zod as its only runtime dependency and does not
import `@agentpack/contract`.

The mapper takes an `AgentEvent` plus host context. The host resolves provider
identities and supplies event/environment/workspace/session/thread IDs, and the
turn/message/interaction/tool IDs required for the particular event. Missing
required context throws instead of falling back to a provider ID. The host also
supplies `completionState`; provider stop-reason strings are not a portable enum.

Mapped families: session created/loaded/deleted/info updates, prompt start/end,
user and agent message chunks, reasoning chunks, tool call/update summaries,
permission/question/plan requests and resolutions, and turn-scoped runtime/RPC
errors. Recoverable errors become `turn.notice`; terminal errors become
`turn.failed`. Error messages are generic; detailed provider diagnostics stay
host-side. Projection validates the final event through `ProofEventSchema`.

The mapping is intentionally lossy: process/auth/config/usage/extension events,
tool content, plan progress and subtask updates have no family in this proof
slice and return `null`. Errors outside a known turn also remain host-side.
Raw tool input/output, metadata, provider IDs, provider sequence numbers and
opaque extension payloads are never spread into protocol events. Content blocks
and interaction fields are individually schema-validated; unknown fields are
stripped. This mapper is opt-in and is not wired into production transport yet.

Node and isolated-browser tests validate every command/response/event fixture.
Runtime tests verify projection, host identities, omission of provider fields,
reasoning without text, recovery, and plan continuation.
