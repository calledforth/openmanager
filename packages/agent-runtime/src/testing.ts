/** Test-only transport fakes. Shipping paths must not import this entry. */
export { FakeAcpConnection, FakeConnectionFactory } from './session/test-connection.js'
export type { FakeWire } from './session/test-connection.js'
export { FakeClaudeQuery, FakeClaudeSdk } from './session/claude/test-sdk.js'
