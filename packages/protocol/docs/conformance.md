# Command and event conformance tests

The protocol test suite includes a reusable, transport-independent harness in
`tests/contract-harness.ts`. Server and client implementations provide small
adapters to the harness; the harness supplies schema-valid JSON messages and
checks their observable effects. It does not depend on HTTP, WebSocket, or an
execution-provider API.

Import the harness through its test-only package subpath:

```ts
import {
  verifyDuplicateCommandContract,
  verifyGapReplayContract,
  verifyOutOfOrderEventContract,
} from '@openmanager/protocol/contract-tests'
```

## Duplicate commands

`verifyDuplicateCommandContract(createSubject, command)` runs the same command
identity through two fresh subjects:

1. Two concurrent deliveries exercise the in-flight join path.
2. A delivery followed by the same delivery exercises settled-result replay.

The subject exposes only `dispatch(unknown)` and `effectCount()`. The harness
validates the command and terminal envelopes, checks exact request correlation,
requires one effect, and compares the complete terminal results as wire JSON values.
Both successful responses and correlated errors are terminal results and must be
stable for the retained request identity.

## Out-of-order events

`verifyOutOfOrderEventContract(createSubject, fixture, policy)` delivers sequence
`N + 2` before `N + 1`. A client declares one of the two allowed policies:

- `resequence`: accept and buffer `N + 2`, keep the applied cursor at `N`, then
  apply `N + 1` and `N + 2` in order.
- `reject`: reject `N + 2` without changing applied state, then accept `N + 1`.

Advancing the applied cursor across the gap fails the contract. The adapter's
observation returns its current cursor and applied durable records so the harness
can validate their schemas, order, continuity, and identity.
An adapter maps its implementation's rejection signal to a thrown error or
rejected promise for `deliverLive`; buffering resolves without applying the event.

## Replay after a gap

`verifyGapReplayContract(createSubject, fixture)` first exposes the client to a
live gap, then supplies a schema-valid replay response for the complete missing
range. It requires the final cursor and applied records to contain every sequence
exactly once. It delivers the last event once more after recovery to verify that
a late duplicate cannot create a second effect.

The fixture itself is validated with `CursorSchema`, `DurableEventSchema`,
`SubscriptionEventSchema`, `ReplayCommandSchema`, and `parseReplayResult` before
an adapter receives it. This keeps failures about implementation behavior
separate from malformed test data.

The package's `contract.test.ts` runs the harness against small conforming
subjects for both event policies. It also runs deliberately broken subjects to
prove the harness detects duplicate effects, unstable results, bad correlation,
gap-skipping, replay duplicates, and replay holes. Root `pnpm test` and
`pnpm run ci:protocol` include these tests automatically.
