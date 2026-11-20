// The Codex test doubles: `@agentpack/runtime/testing/codex`. Shipping paths
// must not import this. It is TypeScript source for vitest (it reaches the
// generated protocol, which is .ts only), so it is not part of
// `@agentpack/runtime/testing`, which plain Node loads from `dist`.
export {
  FakeCodexAppServer,
  FakeCodexAppServerFactory,
  isWireNotification,
  isWireRequest,
  isWireResponse,
} from './FakeCodexAppServer.js'
export type {
  CodexServerRequestResults,
  FakeClientRequest,
  FakeCodexAppServerOptions,
  FakeServerAnswer,
  FakeServerRequest,
  Responder,
  RespondOptions,
  ServerRequestResult,
  WireError,
  WireMessage,
  WireRequest,
} from './FakeCodexAppServer.js'
export { FakeCodexThread, FakeCodexTurn } from './FakeCodexThread.js'
export type { CommandScript } from './FakeCodexThread.js'
export { ReplayCodexAppServer } from './ReplayCodexAppServer.js'
export type { ReplayCodexAppServerOptions, ReplayMatch, ReplayMismatch } from './ReplayCodexAppServer.js'
export {
  CODEX_FIXTURE_FORMAT,
  CODEX_FIXTURES,
  codexMockAppServerPath,
  fixtureMessages,
  parseCodexFixture,
  readCodexFixture,
  serializeCodexFixture,
} from './fixture.js'
export type {
  CodexFixture,
  CodexFixtureEntry,
  CodexFixtureExit,
  CodexFixtureHeader,
  CodexFixtureName,
} from './fixture.js'
export { createCodexMockExecutable } from './mock-executable.js'
export * as codexBuilders from './builders.js'
