/** Test-only transport fakes. Shipping paths must not import this entry.
 *
 * Plain Node loads this from `dist` (the server's convergence child does), so
 * nothing here may reach a TypeScript-only package. The Codex doubles do (the
 * generated protocol), so they have their own entry,
 * `@agentpack/runtime/testing/codex`. */
export { FakeAcpConnection, FakeConnectionFactory } from './session/test-connection.js'
export type { FakeWire } from './session/test-connection.js'
export { FakeClaudeQuery, FakeClaudeSdk } from './session/claude/test-sdk.js'
