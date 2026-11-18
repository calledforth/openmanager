// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitPullRequestIcon, NotePencilIcon } from '@phosphor-icons/react'
import {
  PanelDeck,
  PanelKeys,
  usePanelKeys,
  type PanelView,
} from '../src/components/side-panel/PanelDeck'
import { TooltipProvider } from '../src/components/fluid/ui/tooltip'
import { diffLines, diffStat } from '../src/components/scratchpad/line-diff'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('diffLines', () => {
  it('finds an append', () => {
    const lines = diffLines('a\nb', 'a\nb\nc')
    expect(lines.map((line) => line.kind)).toEqual(['same', 'same', 'added'])
    expect(diffStat(lines)).toEqual({ added: 1, removed: 0 })
  })

  it('pairs a changed line as a removal and an addition', () => {
    const lines = diffLines('- [ ] ship\nnotes', '- [x] ship\nnotes')
    expect(lines).toEqual([
      { kind: 'removed', text: '- [ ] ship' },
      { kind: 'added', text: '- [x] ship' },
      { kind: 'same', text: 'notes' },
    ])
  })

  it('treats an empty page as no lines', () => {
    expect(diffLines('', 'hello')).toEqual([{ kind: 'added', text: 'hello' }])
    expect(diffLines('hello', '')).toEqual([{ kind: 'removed', text: 'hello' }])
    expect(diffLines('', '')).toEqual([])
  })

  it('treats identical text as unchanged', () => {
    expect(diffStat(diffLines('x\ny', 'x\ny'))).toEqual({ added: 0, removed: 0 })
  })
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function press(key: string, target: EventTarget = document.body) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

let viewKeys: string[] = []

function PrView() {
  usePanelKeys((event) => {
    if (event.key === 'j') {
      viewKeys.push('j')
      return true
    }
    return false
  })
  return <div data-testid="prs">prs</div>
}

function Harness({ active = true }: { active?: boolean }) {
  const [current, setCurrent] = useState<string | null>(null)
  const views: PanelView[] = [
    {
      id: 'prs',
      shortcut: 'p',
      label: 'Pull requests',
      icon: GitPullRequestIcon,
      content: <PrView />,
    },
    {
      id: 'scratchpad',
      shortcut: 's',
      label: 'Scratchpad',
      icon: NotePencilIcon,
      content: <textarea data-testid="pad" />,
    },
  ]
  return (
    <TooltipProvider>
      <span data-testid="current">{current ?? 'home'}</span>
      <PanelDeck views={views} current={current} onNavigate={setCurrent} active={active} />
    </TooltipProvider>
  )
}

const current = () => container.querySelector('[data-testid="current"]')?.textContent

describe('PanelDeck', () => {
  beforeEach(() => {
    viewKeys = []
  })

  it('opens a view by its key and steps back home with Esc', () => {
    act(() => root.render(<Harness />))
    expect(current()).toBe('home')
    press('p')
    expect(current()).toBe('prs')
    press('s')
    expect(current()).toBe('scratchpad')
    press('Escape')
    expect(current()).toBe('home')
  })

  it('moves through the home list and opens the highlighted view', () => {
    act(() => root.render(<Harness />))
    press('j')
    press('Enter')
    expect(current()).toBe('scratchpad')
  })

  it('gives the view its keys first', () => {
    act(() => root.render(<Harness />))
    press('p')
    press('j')
    expect(viewKeys).toEqual(['j'])
    expect(current()).toBe('prs')
  })

  it('ignores keys typed into a field', () => {
    act(() => root.render(<Harness />))
    press('s')
    const pad = container.querySelector('[data-testid="pad"]')!
    press('p', pad)
    expect(current()).toBe('scratchpad')
  })

  it('ignores keys while the panel is shut', () => {
    act(() => root.render(<Harness active={false} />))
    press('p')
    expect(current()).toBe('home')
  })

  it('gives no keys to a view on its way out', () => {
    act(() => root.render(<Harness />))
    press('p')
    press('Escape')
    expect(current()).toBe('home')
    press('j')
    expect(viewKeys).toEqual([])
  })

  it('leaves Enter to a focused button', () => {
    act(() => root.render(<Harness />))
    const card = container.querySelector('ul[aria-label="Open in the panel"] button')!
    press('Enter', card)
    expect(current()).toBe('home')
  })
})

describe('PanelKeys', () => {
  beforeEach(() => {
    viewKeys = []
  })

  it("answers a lone view's keys while active", () => {
    act(() =>
      root.render(
        <PanelKeys active>
          <PrView />
        </PanelKeys>,
      ),
    )
    press('j')
    expect(viewKeys).toEqual(['j'])
  })

  it('stays quiet while inactive', () => {
    act(() =>
      root.render(
        <PanelKeys active={false}>
          <PrView />
        </PanelKeys>,
      ),
    )
    press('j')
    expect(viewKeys).toEqual([])
  })
})
