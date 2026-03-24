# How `driven` Works — Desktop vs Remote Clients

## The Core Question

How do we know if a client should read tokens directly from the local SSE path or from Convex-backed state?

---

## Correct Rule

`driven` is **per session owner**, not per workspace and not just "who currently has a sidecar".

A session is `driven` on a client only when `session.clientId === currentClientId`. That stable `clientId` is created once in Electron main, persisted under `userData`, and exposed to the renderer through preload. Local per-message overlay state still exists, but it only applies inside sessions owned by the current desktop.

```tsx
const isDriven = session.clientId === currentClientId;

const displayMessages = messages.map((dbMsg) => {
  const localMsg = streamingMessages.get(dbMsg.externalId);

  if (isDriven && localMsg && !dbMsg.isFinal) {
    return {
      ...dbMsg,
      content: localMsg.content,
      parts: localMsg.parts,
    };
  }

  return dbMsg;
});
```

Why this matters:
- Same machine, same workspace, different session owner: sidecar connectivity is irrelevant if the session belongs to another `clientId`.
- Owner desktop: receives IPC token deltas and renders local overlay state immediately.
- Remote laptop or mobile: never receives owner IPC, so it reads from Convex only.

---

## Data Sources

Desktop client that owns the stream:
- Receives token updates over IPC from the main-process SSE bridge.
- Renders in-progress message state from local memory.
- Writes sentence-level remote updates to Convex for other clients.
- Owns job execution for that session through `pending_jobs.targetClientId`.

Remote or non-owning client:
- Reads message metadata from Convex.
- Reads streaming cursor updates from Convex for the actively streaming message.
- Reads finalized message content from Convex once the stream completes.
- May still enqueue work into the session, but execution is routed back to the owner client.

---

## Implementation Pattern

### Step 1: Forward tokens to the renderer

```typescript
case 'message.part.delta': {
  this.mainWindow.webContents.send('stream:token', {
    sessionExternalId: sid,
    messageExternalId: msgId,
    partId,
    delta,
  });
  break;
}
```

### Step 2: Hold local per-message streaming state

```tsx
const [streamingMessages, setStreamingMessages] = useState<Map<string, LocalMessage>>(new Map());

useEffect(() => {
  const cleanup = window.electronAPI.onStreamToken(({ messageExternalId, delta }) => {
    setStreamingMessages((prev) => {
      const msg = prev.get(messageExternalId) ?? { content: '', parts: [] };
      return new Map(prev).set(messageExternalId, {
        ...msg,
        content: msg.content + delta,
      });
    });
  });

  return cleanup;
}, []);
```

### Step 3: Prefer local state only for owned sessions

```tsx
const displayMessages = messages.map((dbMsg) => {
  const localMsg = streamingMessages.get(dbMsg.externalId);
  if (isDriven && localMsg && !dbMsg.isFinal) {
    return { ...dbMsg, content: localMsg.content, parts: localMsg.parts };
  }
  return dbMsg;
});
```

### Step 4: Drop local state when final DB state lands

```tsx
useEffect(() => {
  for (const msg of messages) {
    if (msg.isFinal && streamingMessages.has(msg.externalId)) {
      setStreamingMessages((prev) => {
        const next = new Map(prev);
        next.delete(msg.externalId);
        return next;
      });
    }
  }
}, [messages, streamingMessages]);
```

---

## The Key Insight

The correct question is not "is this workspace connected?" The correct question is "does this session belong to my stable local `clientId`?"

If yes, render owner IPC plus local overlay state.
If no, render Convex-backed metadata, cursor, and finalized content.
