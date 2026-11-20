import { describe, expect, it, vi } from 'vitest'
import { providers } from '../../providers/index.js'
import { ProviderProbeRuntimeFactory } from '../ProviderRuntimeFactory.js'

/** The real `codex` on this machine through the real factory arm. Opt in with
 * `OPENMANAGER_LIVE_CODEX=1`; needs a signed-in Codex, spends no tokens. */
const live = process.env.OPENMANAGER_LIVE_CODEX === '1'

describe.skipIf(!live)('Codex probe, live', () => {
  it('reports the account as signed in and lists models', { timeout: 60_000 }, async () => {
    const factory = new ProviderProbeRuntimeFactory({
      configs: providers,
      host: { log: vi.fn() },
      connections: () => {
        throw new Error('no ACP here')
      },
    })
    const probe = factory.create('codex', process.cwd())
    try {
      const result = await probe.probe()
      expect(result.authenticated).toBe(true)
      expect(result.agentInfo?.name).toBe('Codex')
      expect(result.models?.availableModels?.length).toBeGreaterThan(0)
      expect(result.models?.currentModelId).toBeTruthy()
    } finally {
      await probe.dispose()
    }
  })
})
