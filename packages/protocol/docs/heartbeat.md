# Liveness and flow control

Version 19 (docs/sync-foundations.md §7.2, F5a). Two separate mechanisms:
**liveness** decides whether a peer is still there; **flow control** bounds what
the server holds for a connection. Neither depends on how fast the link is.

## Liveness

| Message     | Direction       | Payload    | Meaning                                  |
| ----------- | --------------- | ---------- | ---------------------------------------- |
| `beat`      | Client → server | none       | "still here"                             |
| `ack`       | Client → server | `received` | flow control; also proves liveness       |
| `keepalive` | Server → client | none       | sent when the server has written nothing |

`HEARTBEAT_POLICY`:

- the client sends a `beat` when it has sent nothing for **10 s**. Commands
  and acks count as beats;
- the server closes a connection (`4000 heartbeat_timeout`) when **no inbound
  frame** has arrived for **30 s**. It never looks at downstream bytes, so a
  slow download cannot trip it. A frame that arrives after the deadline (a
  starved timer, a machine that slept) is judged by the same rule first;
- the server sends a `keepalive` when it has written nothing for **15 s** and
  no fragmented message is half-written;
- the client closes (`4000 heartbeat_timeout`) and reconnects after **45 s**
  with no frame of any kind received. It resets on every frame (text, binary
  fragment or keepalive) before parsing.

Because a browser surfaces a frame only when all of it has arrived, the
client's watchdog needs each frame within 45 s; fragment sizing (below) keeps
that true down to about 12 B/s in steady state, and about 182 B/s for frames
already in flight when the rate suddenly drops (8 KiB cap).

## Framing

A message that fits in one fragment is an ordinary text frame. A larger one is
sent as consecutive binary frames: one flag byte (`1` more follow, `2` last)
then a slice of the message's UTF-8 bytes. Fragments of one message are never
interleaved with any other frame. The receiver concatenates the slices and
decodes once, at the last fragment.

Fragment size, flag included: `clamp(measured rate × 2 s, 512 B, 8 KiB)`,
1 KiB until the first rate is measured.

## Flow control

- The client acknowledges the total payload bytes received (`ack.received`):
  every 32 KiB, or 250 ms after the last frame while anything is
  unacknowledged. A text frame counts its UTF-8 length, a binary frame its byte
  length.
- The server writes only while `sent − acked < window`. The window starts at
  256 KiB and follows twice the measured bandwidth-delay product, up to 4 MiB.
- Live frames of subscribed scopes waiting for the window are bounded at
  1 MiB per connection. Past the bound, every scope with frames in the queue
  goes **lagging**: its queued frames are dropped and the server sends
  `subscription.lagging {subscriptionId, cursor}` (the last record it wrote).
  Responses, readings (coalesced to the latest) and the message being written
  are never dropped.
- When the queue has drained below half the bound and the window is open, the
  server builds a catch-up for each lagging scope from that cursor (replay or
  snapshot, by the same rule as `subscription.replay`), resumes live delivery
  in the same tick, and sends `subscription.catchup` with the replay-answer
  payload. The client applies it like a replay answer.

Nothing is lost: the event log is the truth, and dropping queued frames only
moves their delivery into the catch-up.
