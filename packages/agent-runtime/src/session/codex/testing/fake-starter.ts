import type { HostLogEntry } from '../../../host.js'
import { CodexAppServerClient, type ClientMethod } from '../CodexAppServerClient.js'
import type { CodexStarter, CodexStartRequest } from '../start.js'
import {
  buildAccountResponse,
  buildFeature,
  buildModel,
  buildPermissionProfiles,
} from './builders.js'
import { FakeCodexAppServer, type FakeCodexAppServerOptions } from './FakeCodexAppServer.js'

/** A `CodexStarter` that starts a fake app-server per call, wired through a
 * real `CodexAppServerClient` and handshake, so the service process, a probe
 * or a session runtime can be driven end to end without Codex.
 *
 * Each fake answers what the service process asks at boot (a signed-in
 * account, one model page, the built-in permission profiles, no managed
 * policy, the relied-on feature flags on) unless `setup` scripts it
 * otherwise; a `respond` there takes precedence. */
export function fakeCodexStarter(
  setup: (server: FakeCodexAppServer, index: number) => void = () => undefined,
  options: FakeCodexAppServerOptions = {},
) {
  const servers: FakeCodexAppServer[] = []
  /** Every log line the clients wrote. */
  const logs: HostLogEntry[] = []
  const log = (entry: HostLogEntry): void => {
    logs.push(entry)
  }
  /** Every start request, in order. */
  const requests: CodexStartRequest[] = []
  const start: CodexStarter = async (request) => {
    requests.push(request)
    const server = new FakeCodexAppServer({ pid: 5000 + servers.length, ...options })
    // Defaults first: `respond` puts the newest answer in front, so
    // whatever `setup` scripts wins.
    serveDiscovery(server)
    setup(server, servers.length)
    servers.push(server)
    const client = new CodexAppServerClient(server, {
      log,
      terminateGraceMs: 50,
      requestTimeoutMs: 2_000,
      exitDrainMs: 10,
    })
    await client.initialize({ clientVersion: 'test' })
    return client
  }
  return {
    start,
    servers,
    requests,
    logs,
    get last(): FakeCodexAppServer {
      const server = servers.at(-1)
      if (!server) throw new Error('no fake codex app-server has been started yet')
      return server
    },
  }
}

/** What the service process asks at boot, answered the way a signed-in
 * 0.170 with no managed policy answers it. */
function serveDiscovery(server: FakeCodexAppServer): void {
  const defaults: Array<[ClientMethod, unknown]> = [
    ['account/read', buildAccountResponse()],
    ['model/list', { data: [buildModel('gpt-6.2-sol', { isDefault: true })], nextCursor: null }],
    ['permissionProfile/list', { data: buildPermissionProfiles(), nextCursor: null }],
    ['configRequirements/read', { supportsIndependentSpeedModes: true, requirements: null }],
    [
      'experimentalFeature/list',
      {
        data: [buildFeature('fast_mode', true), buildFeature('guardian_approval', true)],
        nextCursor: null,
      },
    ],
    // The user's config sets no web search mode.
    ['config/read', { config: { web_search: null }, origins: {}, layers: null }],
  ]
  for (const [method, answer] of defaults) server.respond(method, answer as never)
}
