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

The runtime exports `projectAgentEvent` from `@agentpack/runtime`. The mapper
takes an `AgentEvent` plus host context. The host supplies every public identity
and classifies completion/failure; provider IDs, request IDs, stop reasons,
process details and diagnostics are never used as protocol identities or copied
to payloads. Missing required context throws instead of falling back to a
provider value. Every non-null result is validated by `ProofEventSchema`.

| `AgentEventName` | Protocol event | Disposition |
| --- | --- | --- |
| `process_spawned` | — | Host health only |
| `process_exited` | `turn.failed` / `turn.interrupted` | Active turns only; host classifies crash/exit/interrupt |
| `initialized` | — | Host health/catalog only |
| `authenticated` | — | Host health only |
| `session_created` | `session.created` | Host session/workspace IDs |
| `session_loaded` | `session.updated` | Host session ID |
| `session_deleted` | `session.deleted` | Host session ID |
| `prompt_started` | `turn.started` | Host turn and user-message IDs |
| `prompt_completed` | `turn.completed` / `turn.interrupted` / `turn.failed` | Host completion classification |
| `user_message_chunk` | `message.delta` | Host user-message ID |
| `agent_message_chunk` | `message.delta` | Host assistant-message ID |
| `agent_thought_chunk` | `message.reasoning` | Host assistant-message ID |
| `tool_call` | `tool.updated` | Host tool-call ID; raw input/output omitted |
| `tool_call_update` | `tool.updated` | Host tool-call ID; raw input/output omitted |
| `tool_call_content` | — | Deferred protocol family |
| `plan_update` | — | Deferred protocol family |
| `subtask_update` | — | Deferred protocol family |
| `permission_request` | `interaction.requested` | Host interaction/tool IDs |
| `permission_resolved` | `interaction.resolved` | Host interaction ID |
| `question_request` | `interaction.requested` | Host interaction ID |
| `question_resolved` | `interaction.resolved` | Host interaction ID |
| `plan_review_request` | `interaction.requested` | Host interaction ID |
| `plan_review_resolved` | `interaction.resolved` | Host interaction ID |
| `current_model_update` | — | Provider profile service |
| `current_mode_update` | — | Provider profile service |
| `config_option_update` | — | Provider profile service |
| `session_info_update` | `session.updated` | Only portable title data |
| `usage_update` | — | Deferred protocol family |
| `available_commands_update` | — | Provider profile service |
| `extension_request` | — | Opaque provider extension stays host-side |
| `extension_resolved` | — | Opaque provider extension stays host-side |
| `extension_notification` | — | Opaque provider extension stays host-side |
| `rpc_error` | `turn.notice` / `turn.failed` | Active turns only; generic message |
| `runtime_error` | `turn.notice` / `turn.failed` | Active turns only; generic message |
| `auth_required` | `turn.failed` | Active turns only; `authentication_required` |
| `capability_missing` | `turn.failed` | Active turns only; `capability_missing` |

`turn.failed.reason` is a provider-neutral enum:
`provider_process_exited`, `provider_process_crashed`, `provider_error`,
`authentication_required`, or `capability_missing`. Provider exit codes, signals,
error text and opaque detail objects remain available only to host diagnostics.
Recoverable notices are transient. Durable mapped events receive a host epoch and
a contiguous sequence in their exact scope before entering the append callback;
that callback is the SQLite insertion seam.

Node and isolated-browser tests validate every command/response/event fixture.
Runtime tests verify projection, host identities, omission of provider fields,
reasoning without text, recovery, and plan continuation.
