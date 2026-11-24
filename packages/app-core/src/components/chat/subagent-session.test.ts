// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Subagent } from '@openmanager/protocol'
import { ThemeProvider } from '../../providers/theme-provider'
import { liveSubagentStatus, SubagentReadOnlyFooter, subagentIdentity } from './SubagentSession'

const record = (status: Subagent['status']): Subagent => ({
  subagentId: 'sub-1',
  parentSessionId: 'parent',
  turnId: 'turn-1',
  depth: 1,
  origin: 'native',
  providerId: 'claude',
  title: 'Map callers',
  status,
  background: false,
  promptable: false,
  stoppable: true,
  stats: {},
  startedAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
})

describe('liveSubagentStatus', () => {
  it('believes the child over a record the parent thread stopped updating', () => {
    // Opened while running; the parent's thread was let go, the child finished.
    expect(liveSubagentStatus({ status: 'idle' }, 'completed', record('running'))).toEqual({
      status: 'completed',
    })
    expect(
      liveSubagentStatus(
        { status: 'waiting', waitingOn: 'permission' },
        'running',
        record('running'),
      ),
    ).toEqual({ status: 'waiting', waitingOn: 'permission' })
    expect(liveSubagentStatus({ status: 'running' }, 'running', record('completed'))).toEqual({
      status: 'running',
    })
  })

  it('never calls a stopped or interrupted subagent done', () => {
    expect(liveSubagentStatus({ status: 'idle' }, 'interrupted', null)).toEqual({
      status: 'interrupted',
    })
    expect(liveSubagentStatus({ status: 'idle' }, 'interrupted', record('cancelled'))).toEqual({
      status: 'cancelled',
    })
    // Neither its turns nor a settled record say how it ended.
    expect(liveSubagentStatus({ status: 'idle' }, undefined, null)).toEqual({
      status: 'interrupted',
    })
    expect(liveSubagentStatus({ status: 'error' }, undefined, null)).toEqual({ status: 'failed' })
  })
})

describe('the read-only footer', () => {
  const footer = (identity: ReturnType<typeof subagentIdentity>) =>
    renderToStaticMarkup(
      createElement(
        ThemeProvider,
        null,
        createElement(SubagentReadOnlyFooter, {
          parentTitle: 'Harden auth',
          identity,
          onOpenParent: () => undefined,
        }),
      ),
    )

  it('says what the subagent ran on, how it ended and for how long', () => {
    const done = {
      ...record('completed'),
      agentType: 'Explore',
      modelId: 'claude-opus-5-5-20261101',
      stats: { durationMs: 15_000 },
    }
    const identity = subagentIdentity(
      { title: 'Map callers', providerId: 'claude', status: 'idle' },
      done,
      'completed',
    )
    expect(identity).toMatchObject({ agentType: 'Explore', model: 'claude-opus-5-5' })
    const html = footer(identity)
    expect(html).toContain('Only the parent agent can message this subagent.')
    expect(html).toContain('claude-opus-5-5')
    expect(html).toContain('Done 15s')
    expect(html).toContain('Open parent')
  })

  it('names what a waiting one waits on', () => {
    const html = footer(
      subagentIdentity(
        { title: 'Deploy', providerId: 'claude', status: 'waiting', waitingOn: 'permission' },
        record('running'),
      ),
    )
    expect(html).toContain('Waiting for your permission')
  })
})
