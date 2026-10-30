// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  blurReductionFor,
  createTabTargets,
  glassBlurProps,
  INSIDE_TARGET,
  type GlassTarget,
} from '../src/ui/glass-target'

// The layers as Android lays them out, on react-native-web: the blur
// records what it was told to draw, and the target is the view it stands for.
vi.mock('react-native', async () => {
  // @ts-expect-error -- react-native-web ships no types; it stands in for react-native here.
  const web = (await import('react-native-web')) as Record<string, unknown>
  return {
    ...web,
    Platform: { ...(web.Platform as object), OS: 'android' },
    PixelRatio: { get: () => 2.625 },
  }
})
type Drawn = { blurTarget?: GlassTarget; blurMethod?: string }
const blurs: Drawn[] = []
vi.mock('expo-blur', () => ({
  BlurTargetView: ({ ref, children }: { ref?: (node: unknown) => void; children?: ReactNode }) => (
    <section ref={ref as never}>{children}</section>
  ),
  BlurView: (props: Drawn) => {
    blurs.push(props)
    return null
  },
}))
vi.mock('../src/theme/ThemeProvider', () => {
  const theme = new Proxy({}, { get: () => '#888888' })
  return { usePhoneTheme: () => theme }
})
vi.mock('../src/ui/haptics', () => ({ tap: () => undefined }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => undefined }) }))
// The pill's sliding highlight: its values read at rest, nothing animates here.
vi.mock('react-native-reanimated', async () => {
  // @ts-expect-error -- react-native-web ships no types.
  const web = (await import('react-native-web')) as { View: unknown }
  return {
    default: { View: web.View },
    useSharedValue: (value: number) => ({ value }),
    useAnimatedStyle: (style: () => object) => style(),
    withSpring: (value: number) => value,
  }
})
vi.mock('phosphor-react-native', () => {
  const Icon = () => null
  return { GearSixIcon: Icon, ListIcon: Icon, MagnifyingGlassIcon: Icon, TrayIcon: Icon }
})

;(globalThis as { __DEV__?: boolean }).__DEV__ = true
const { Glass, GlassContent, GlassLayer, GlassTargetProvider } = await import('../src/ui/Glass')
const { Screen, TabTargetsContext } = await import('../src/ui/Screen')
const { PillNav } = await import('../src/ui/PillNav')

/** The last thing each Glass drew, by the label inside it. */
function Labelled({ label }: { label: string }) {
  return (
    <Glass>
      <span data-label={label} />
    </Glass>
  )
}
const lastTarget = () => blurs.at(-1)?.blurTarget?.current ?? null

let container: HTMLDivElement
let root: Root
const render = async (node: ReactNode) => {
  await act(async () => root.render(node))
}
const sections = () => [...container.querySelectorAll('section')]

beforeEach(() => {
  blurs.length = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('glassBlurProps', () => {
  it('blurs a layer target on Android only, at the mockups radius', () => {
    const target = { current: null } as GlassTarget
    expect(glassBlurProps(target, 'android', 2.625)).toEqual({
      blurTarget: target,
      blurMethod: 'dimezisBlurViewSdk31Plus',
      blurReductionFactor: blurReductionFor(2.625),
    })
    expect(glassBlurProps(target, 'ios', 3)).toEqual({})
    expect(glassBlurProps(target, 'web', 1)).toEqual({})
  })

  it('draws the tint alone with no target, and never inside one', () => {
    expect(glassBlurProps(null, 'android', 2.625)).toEqual({})
    expect(glassBlurProps(INSIDE_TARGET, 'android', 2.625)).toEqual({})
  })

  it('maps intensity N to a Gaussian of N dp', () => {
    // radius = N / reduction × 4 px; sigma = 0.57735 × radius; one dp = pixelRatio px.
    for (const ratio of [1, 2, 2.625, 3.5]) {
      const radius = (24 / blurReductionFor(ratio)) * 4
      expect(0.57735 * radius).toBeCloseTo(24 * ratio, 5)
    }
  })
})

describe('tab targets', () => {
  it('holds one target per tab and tells only when one changes', () => {
    const targets = createTabTargets()
    const heard = vi.fn()
    targets.subscribe(heard)
    const a = { current: null } as GlassTarget
    targets.set('index', a)
    targets.set('index', a)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(targets.get('index')).toBe(a)
    expect(targets.get('settings')).toBeNull()
    targets.set('index', null)
    expect(targets.get('index')).toBeNull()
    expect(heard).toHaveBeenCalledTimes(2)
  })
})

describe('glass layers', () => {
  it('blurs the content beside it, also when drawn before the content', async () => {
    await render(
      <GlassLayer>
        <Labelled label="header" />
        <GlassContent>
          <p>rows</p>
        </GlassContent>
        <Labelled label="dock" />
      </GlassLayer>,
    )
    const [content] = sections()
    expect(content).toBeDefined()
    // The last render of each: both glass draw the layer's content.
    const drawn = blurs.slice(-2)
    expect(drawn.map((blur) => blur.blurTarget?.current)).toEqual([content, content])
    expect(drawn.every((blur) => blur.blurMethod === 'dimezisBlurViewSdk31Plus')).toBe(true)
  })

  it('never blurs from inside the content, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await render(
      <GlassLayer>
        <GlassContent>
          <Labelled label="misplaced" />
        </GlassContent>
      </GlassLayer>,
    )
    expect(blurs.at(-1)?.blurTarget).toBeUndefined()
    expect(blurs.at(-1)?.blurMethod).toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Glass inside a GlassContent'))
  })

  it('gives a layer inside content its own target (the camera in the pairing page)', async () => {
    await render(
      <GlassLayer>
        <GlassContent>
          <GlassLayer>
            <GlassContent>
              <p>feed</p>
            </GlassContent>
            <Labelled label="hint" />
          </GlassLayer>
        </GlassContent>
        <Labelled label="sheet" />
      </GlassLayer>,
    )
    const [outer, inner] = sections()
    // The hint blurs the feed's layer; the page's sheet blurs the page.
    const lastTwo = blurs.slice(-2).map((blur) => blur.blurTarget?.current)
    expect(lastTwo).toContain(inner)
    expect(lastTwo).toContain(outer)
    expect(inner).not.toBe(outer)
  })

  it('hands its target out, and takes it back when it goes', async () => {
    const heard: Array<unknown> = []
    function Host() {
      const [shown, setShown] = useState(true)
      ;(globalThis as { hide?: () => void }).hide = () => setShown(false)
      return shown ? (
        <GlassLayer onTarget={(target) => heard.push(target?.current ?? null)}>
          <GlassContent />
        </GlassLayer>
      ) : null
    }
    await render(<Host />)
    expect(heard.at(-1)).toBe(sections()[0])
    await act(async () => (globalThis as { hide?: () => void }).hide?.())
    expect(heard.at(-1)).toBeNull()
  })

  it('lets glass drawn elsewhere blur a target it is given', async () => {
    const target = { current: document.createElement('section') } as unknown as GlassTarget
    await render(
      <GlassTargetProvider target={target}>
        <Labelled label="tab bar" />
      </GlassTargetProvider>,
    )
    expect(lastTarget()).toBe(target.current)
  })
})

describe('the tab bar', () => {
  const props = (index: number) =>
    ({
      state: {
        index,
        routes: [
          { key: 'index-1', name: 'index' },
          { key: 'inbox-1', name: 'inbox' },
          { key: 'settings-1', name: 'settings' },
        ],
      },
      navigation: { emit: () => ({ defaultPrevented: false }), navigate: () => undefined },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    }) as unknown as Parameters<typeof PillNav>[0]

  it('blurs the screen in front, and follows the tab the moment it changes', async () => {
    const targets = createTabTargets()
    const page = (index: number) => (
      <TabTargetsContext.Provider value={targets}>
        <Screen tab="index">
          <GlassContent>
            <p>sessions</p>
          </GlassContent>
        </Screen>
        <Screen tab="settings">
          <GlassContent>
            <p>settings</p>
          </GlassContent>
        </Screen>
        <PillNav {...props(index)} targets={targets} />
      </TabTargetsContext.Provider>
    )
    await render(page(0))
    const [sessions, settings] = sections()
    // The pill and the search button: both on the sessions screen.
    expect(blurs.slice(-2).map((blur) => blur.blurTarget?.current)).toEqual([sessions, sessions])
    await render(page(2))
    expect(blurs.slice(-2).map((blur) => blur.blurTarget?.current)).toEqual([settings, settings])
    // A tab whose screen is not drawn yet: the tint alone, never another tab's.
    await render(page(1))
    expect(blurs.slice(-2).map((blur) => blur.blurTarget)).toEqual([undefined, undefined])
  })
})
