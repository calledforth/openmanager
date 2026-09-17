// How an unfinished assistant message gets its content, by who owns the session.
//
// Convex desktop only. The v2 WebSocket path does not use this split: there is
// no IPC overlay and no Convex `stream_chunks` subscription. ChatView still
// calls these helpers, but the environment host hardcodes `isDriven` true so
// the local store is the environment-client projection. Desktop must drop the
// overlay at thin-shell cutover rather than reintroduce `driven`.
// See docs/driven-behavior-design.md.
//
// Not driven (mobile, a second desktop): subscribe to the Convex chunk stream —
// the only channel that reaches this client at all.
//
// Driven (the desktop actually running the agent): tokens arrive over IPC at
// zero latency, so the Convex stream is not worth a round trip per token. But
// the IPC store lives in renderer memory and starts empty after every reload,
// so the turn so far is fetched once from Convex as a snapshot, and IPC carries
// everything after it. See StreamingMessagesStore.ensureHydrated.

export function shouldUseRemoteStreaming(
  role: string,
  isFinal: boolean | undefined,
  isDriven: boolean,
): boolean {
  return role === 'assistant' && isFinal !== true && !isDriven
}

export function shouldHydrateLocalStream(
  role: string,
  isFinal: boolean | undefined,
  isDriven: boolean,
): boolean {
  return role === 'assistant' && isFinal !== true && isDriven
}
