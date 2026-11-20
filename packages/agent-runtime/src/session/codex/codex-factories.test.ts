import { describe, expect, it, vi } from 'vitest'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { providers } from '../../providers/index.js'
import {
  ProviderProbeRuntimeFactory,
  ProviderSessionRuntimeFactory,
} from '../ProviderRuntimeFactory.js'
import type { CodexAppServerClient } from './CodexAppServerClient.js'
import { CodexProbeRuntime } from './CodexProbeRuntime.js'

const unusedTransport = () => {
  throw new Error('a Codex runtime must never build the ACP transport')
}

describe('Codex arms of the runtime factories', () => {
  it('builds a Codex probe that starts through the injected seam', async () => {
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
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/work' }))
    await probe.dispose()
  })

  it('refuses a Codex session plainly until turns exist', () => {
    const start = vi.fn(async () => ({}) as CodexAppServerClient)
    const factory = new ProviderSessionRuntimeFactory({
      configs: providers,
      host: { log: vi.fn() },
      permissions: new PermissionBroker(),
      interactions: new InteractionBroker(),
      connections: unusedTransport,
      codexStart: start,
    })
    expect(() => factory.create({ threadId: 't', providerId: 'codex', cwd: '/work' })).toThrow(
      /not available in this build yet/,
    )
    expect(start).not.toHaveBeenCalled()
  })
})
