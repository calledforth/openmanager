// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  EnvironmentPlatformIcon,
  environmentOsName,
} from '../src/components/ui/EnvironmentPlatformIcon'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = async (node: ReactNode) => {
  await act(async () => root.render(node))
  return container.querySelector('svg')
}

describe('EnvironmentPlatformIcon', () => {
  it("shows a Linux or WSL environment's distro logo, named", async () => {
    const icon = await render(
      <EnvironmentPlatformIcon platform="wsl" distro={{ id: 'ubuntu', name: 'Ubuntu' }} />,
    )
    expect(icon?.dataset.distro).toBe('ubuntu')
    expect(icon?.getAttribute('aria-label')).toBe('Ubuntu (WSL)')
    expect(icon?.querySelector('title')?.textContent).toBe('Ubuntu (WSL)')
  })

  it('finds a derivative by its parent, and keeps its own name', async () => {
    const icon = await render(
      <EnvironmentPlatformIcon
        platform="linux"
        distro={{ id: 'some-respin', name: 'Some Respin', like: ['nothing', 'arch'] }}
      />,
    )
    expect(icon?.dataset.distro).toBe('some-respin')
    expect(icon?.querySelector('path')?.getAttribute('d')).toBeTruthy()
    expect(icon?.getAttribute('aria-label')).toBe('Some Respin')
  })

  it('keeps Tux for a distro it has no logo for', async () => {
    const icon = await render(
      <EnvironmentPlatformIcon platform="linux" distro={{ id: 'mystery', name: 'Mystery OS' }} />,
    )
    expect(icon?.dataset.distro).toBeUndefined()
    expect(icon?.dataset.platform).toBe('linux')
    expect(icon?.getAttribute('aria-label')).toBe('Mystery OS')
  })

  it('ignores a distro off Linux, and shows nothing for an unknown platform', async () => {
    const icon = await render(
      <EnvironmentPlatformIcon platform="windows" distro={{ id: 'ubuntu' }} aria-hidden />,
    )
    expect(icon?.dataset.platform).toBe('windows')
    expect(icon?.dataset.distro).toBeUndefined()
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(await render(<EnvironmentPlatformIcon platform={undefined} />)).toBeNull()
  })
})

describe('environmentOsName', () => {
  it('says the distro where there is one, and the platform otherwise', () => {
    expect(environmentOsName('wsl', { id: 'debian', name: 'Debian GNU/Linux' })).toBe(
      'Debian GNU/Linux (WSL)',
    )
    expect(environmentOsName('linux', { id: 'fedora' })).toBe('Fedora')
    expect(environmentOsName('linux', { id: 'mystery' })).toBe('mystery')
    expect(environmentOsName('wsl')).toBe('WSL')
    expect(environmentOsName('macos', { id: 'ubuntu' })).toBe('macOS')
    expect(environmentOsName(undefined)).toBeUndefined()
  })
})
