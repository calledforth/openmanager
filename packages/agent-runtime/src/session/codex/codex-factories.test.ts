import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { providers } from '../../providers/index.js'
import {
  ProviderProbeRuntimeFactory,
  ProviderSessionRuntimeFactory,
} from '../ProviderRuntimeFactory.js'
import { CodexProbeRuntime } from './CodexProbeRuntime.js'
import { CodexSessionRuntime } from './CodexSessionRuntime.js'

const unusedTransport = () => {
  throw new Error('a Codex runtime must never build the ACP transport')
}

describe('Codex arms of the runtime factories', () => {
  it('builds a Codex probe served by a service process started through the injected seam', async () => {
    const start = vi.fn(async () => {
      throw Object.assign(new Error('not installed'), { code: 'ENOENT' })
    })
    const factory = new ProviderProbeRuntimeFactory({
      configs: providers,
      host: { log: vi.fn() },
      connections: unusedTransport,
      codexStart: start,
    })
    const probe = factory.create('codex', '/work')
    expect(probe).toBeInstanceOf(CodexProbeRuntime)
    await expect(probe.probe()).rejects.toMatchObject({ code: 'ENOENT' })
    // The service process serves the environment, not one workspace.
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ cwd: homedir() }))
    await probe.dispose()
    // Probes of one provider share one service process.
    expect(factory.codexService('codex')).toBe(factory.codexService('codex'))
    await factory.shutdown()
  })

  it('builds a Codex session runtime that starts through the injected seam', async () => {
    const start = vi.fn(async () => {
      throw Object.assign(new Error('not installed'), { code: 'ENOENT' })
    })
    const factory = new ProviderSessionRuntimeFactory({
      configs: providers,
      host: { log: vi.fn() },
      permissions: new PermissionBroker(),
      interactions: new InteractionBroker(),
      connections: unusedTransport,
      codexStart: start,
    })
    const runtime = factory.create({ threadId: 't', providerId: 'codex', cwd: '/work' })
    expect(runtime).toBeInstanceOf(CodexSessionRuntime)
    await expect(runtime.start()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/work' }))
    expect(runtime.phase).toBe('exited')
  })
})
