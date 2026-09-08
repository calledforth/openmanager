import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentRuntime,
  ProviderHealthMonitor,
  SessionReaper,
  providers,
} from '@agentpack/runtime'
import { describe, expect, it, vi } from 'vitest'
import { mountAgentRuntime } from '../src/agent-runtime.js'
import { createLogger } from '../src/logger.js'
import { startServer } from '../src/server.js'

describe('environment agent runtime', () => {
  it('mounts the desktop provider registrations and runtime services headlessly', async () => {
    const runtime = mountAgentRuntime(createLogger('silent'))
    try {
      expect(runtime).toBeInstanceOf(AgentRuntime)
      expect(runtime.health).toBeInstanceOf(ProviderHealthMonitor)
      expect(runtime.reaper).toBeInstanceOf(SessionReaper)
      expect(runtime.getProvider('opencode')).toBe(providers.opencode)
      expect(runtime.getProvider('cursor')).toBe(providers.cursor)
      expect(runtime.getProvider('claude')).toBe(providers.claude)
    } finally {
      await runtime.shutdown()
    }
  })

  it('shuts down the mounted runtime with the server', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openmanager-runtime-test-'))
    try {
      const server = await startServer({ port: 0, dataDir, logLevel: 'silent' })
      const shutdown = vi.spyOn(server.runtime, 'shutdown')

      await server.close()
      await server.close()

      expect(shutdown).toHaveBeenCalledOnce()
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
