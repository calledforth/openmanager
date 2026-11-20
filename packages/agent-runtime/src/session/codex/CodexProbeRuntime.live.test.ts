import { describe, expect, it, vi } from 'vitest'
import { providers } from '../../providers/index.js'
import { ProviderProbeRuntimeFactory } from '../ProviderRuntimeFactory.js'

/** The real `codex` on this machine through the real factory arm. Opt in with
 * `OPENMANAGER_LIVE_CODEX=1`; needs a signed-in Codex, spends no tokens. */
const live = process.env.OPENMANAGER_LIVE_CODEX === '1'

describe.skipIf(!live)('Codex probe, live', () => {
  it('reports the account, catalog and policy from the service process', { timeout: 60_000 }, async () => {
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
      expect(result.accountLabel).toBeTruthy()
      expect(result.agentInfo?.name).toBe('Codex')
      expect(result.update?.state).toMatch(/current|behind/)
      const models = result.models?.availableModels ?? []
      expect(models.length).toBeGreaterThan(0)
      expect(result.models?.currentModelId).toBeTruthy()
      // Every model says what it reads and offers its efforts with Codex's
      // own descriptions and a default.
      for (const model of models) {
        expect(typeof model.supportsImageInput).toBe('boolean')
        const effort = model.configOptions?.find((option) => option.id === 'effort')
        if (effort?.type === 'select') {
          expect(effort.currentValue).toBeTruthy()
          expect(effort.options.every((option) => option.description)).toBe(true)
        }
      }
      expect(result.policy).toBeDefined()

      // A second probe asks the same process.
      const service = factory.codexService('codex')
      const pid = service.status.pid
      await factory.create('codex', process.cwd()).probe()
      expect(service.status).toMatchObject({ state: 'running', pid, starts: 1 })

      // And it reads limits outside any session.
      const limits = await service.readRateLimits()
      expect(limits.rateLimits).toBeDefined()
      expect(service.state.rateLimits).toBeDefined()
    } finally {
      await probe.dispose()
      await factory.shutdown()
    }
  })
})
