import type {
  Options,
  PermissionMode,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

/** The slice of `@anthropic-ai/claude-agent-sdk` this package depends on.
 *
 * Narrow on purpose. The real `Query` carries ~30 control requests and the
 * module exports another dozen free functions; naming only what is used keeps
 * the fake in `test-sdk.ts` honest (a fake that has to implement 30 methods
 * gets implemented as `as any`, and then the tests stop proving anything) and
 * makes the next SDK bump a compile error on the four members that matter
 * rather than a silent behaviour change across all of them. */
export interface ClaudeQuerySession extends AsyncIterable<SDKMessage> {
  /** Abort the running turn. Resolves to an interrupt receipt on CLIs that
   * advertise one, `undefined` on older ones — neither is load-bearing here,
   * because the runtime waits for the turn's own `result` either way. */
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  /** Resolves once the CLI has answered `initialize`. This is the moment the
   * subprocess is known to be alive, authenticated and usable — everything the
   * runtime emits as `initialized` comes from here. */
  initializationResult(): Promise<SDKControlInitializeResponse>
  /** Synchronous and fire-and-forget: it *starts* the SDK's cleanup and
   * returns without awaiting it. See `ClaudeSessionRuntime.settleExit`. */
  close(): void
  /** `AsyncGenerator.return`, which awaits the same memoised cleanup `close()`
   * kicks off — including the SDK's own bounded wait for the child to exit.
   * The one handle we have on "the process is actually gone". */
  return(value?: undefined): Promise<unknown>
}

/** The module itself, injectable.
 *
 * Tests substitute this wholesale rather than reaching into a live runtime,
 * for the same reason `AcpConnectionFactory` exists: a test that overwrites
 * private fields stops exercising startup, and startup ordering is most of
 * what this runtime does. */
export type ClaudeSdk = {
  query(args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQuerySession
  /** Undefined when the transcript is not on disk — how a resume of a session
   * the CLI never wrote is distinguished from one that failed for some other
   * reason. */
  getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<SDKSessionInfo | undefined>
}

/** The real module, imported on first use.
 *
 * Dynamic because the bundle is ~1.2 MB and nothing loads it unless somebody
 * actually starts a Claude session or probes the provider; a static import
 * would put it on the desktop main process's startup path for every user,
 * including the ones who only use the ACP providers. */
export async function loadClaudeSdk(): Promise<ClaudeSdk> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return {
    query: (args) => sdk.query(args),
    getSessionInfo: (sessionId, options) => sdk.getSessionInfo(sessionId, options),
  }
}
