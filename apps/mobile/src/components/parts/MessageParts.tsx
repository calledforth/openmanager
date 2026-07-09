import { Fragment, useMemo, type ReactNode } from 'react'
import { View } from 'react-native'

import { AppText } from '../ui/AppText'
import { CollapsibleSteps } from './CollapsibleSteps'
import { TextPart } from './TextPart'
import { ThinkingPart } from './ThinkingPart'
import { ToolRow } from './ToolRow'

// Port of the desktop `MessageParts`: dedupe by id, and once a final text
// answer follows a run of tool/reasoning steps (and streaming has settled),
// collapse those steps behind a "Worked N steps" summary. Streaming keeps
// everything expanded so the live trail stays visible.

interface Part {
  type: string
  id: string
  [key: string]: unknown
}

function getPartKey(part: Part, index: number): string {
  const callId = (part as { callID?: string }).callID
  if (part.id) return part.id
  if (callId) return callId
  if (part.type === 'tool') return `tool:${String(part.tool ?? 'unknown')}:${index}`
  return `${part.type}:${index}`
}

function FallbackPart({ part }: { part: Part }) {
  if (
    part.type === 'step-start' ||
    part.type === 'step-finish' ||
    part.type === 'snapshot' ||
    part.type === 'agent'
  ) {
    return null
  }
  return (
    <AppText
      variant="text-12-regular"
      className="py-0.5 text-textMuted"
      style={{ fontStyle: 'italic' }}
    >
      {part.type}
      {(part as Record<string, unknown>).tool ? `: ${(part as Record<string, unknown>).tool}` : ''}
    </AppText>
  )
}

function renderPart(part: Part, index: number, isStreaming?: boolean): ReactNode {
  const key = getPartKey(part, index)

  switch (part.type) {
    case 'text': {
      const text = (part.text as string) ?? ''
      if (part.synthetic || part.ignored) return null
      return <TextPart key={key} text={text} />
    }
    case 'tool':
      return <ToolRow key={key} part={part as Parameters<typeof ToolRow>[0]['part']} />
    case 'reasoning': {
      const partTime =
        part.time && typeof part.time === 'object'
          ? (part.time as Record<string, number>)
          : undefined
      const reasoningStreaming = partTime ? typeof partTime.end !== 'number' : !!isStreaming
      return (
        <ThinkingPart
          key={key}
          text={(part.text as string) ?? ''}
          isStreaming={reasoningStreaming}
        />
      )
    }
    case 'retry':
      return (
        <AppText key={key} variant="text-12-regular" className="py-0.5 text-textMuted">
          Retrying (attempt {(part.attempt as number) ?? '?'})
          {part.error ? `: ${String(part.error)}` : ''}
        </AppText>
      )
    case 'subtask':
      return (
        <AppText key={key} variant="text-12-regular" className="py-0.5 text-textMuted">
          Subtask: {(part.description as string) ?? (part.prompt as string) ?? 'running'}
        </AppText>
      )
    case 'compaction':
      return (
        <AppText
          key={key}
          variant="text-12-regular"
          className="py-0.5 text-textMuted"
          style={{ fontStyle: 'italic' }}
        >
          Session compacted
        </AppText>
      )
    default:
      return <FallbackPart key={key} part={part} />
  }
}

function isToolOrExploringStep(part: Part): boolean {
  return (
    part.type === 'tool' ||
    part.type === 'reasoning' ||
    part.type === 'retry' ||
    part.type === 'subtask'
  )
}

export function MessageParts({ parts, isStreaming }: { parts: Part[]; isStreaming?: boolean }) {
  const safeParts = parts ?? []

  const deduped = useMemo(() => {
    const seen = new Set<string>()
    return safeParts.filter((part, index) => {
      const id = part.id ?? (part as { callID?: string }).callID ?? getPartKey(part, index)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }, [safeParts])

  const { stepParts, hasFinalText, stepsCount, finalParts } = useMemo(() => {
    let lastTextIdx = -1
    for (let i = deduped.length - 1; i >= 0; i -= 1) {
      if (deduped[i].type === 'text' && !deduped[i].synthetic && !deduped[i].ignored) {
        const text = (deduped[i].text as string) ?? ''
        if (text.trim()) {
          lastTextIdx = i
          break
        }
      }
    }

    const hasToolsBefore =
      lastTextIdx > 0 && deduped.slice(0, lastTextIdx).some(isToolOrExploringStep)
    const nextHasFinalText = lastTextIdx > 0 && hasToolsBefore
    const nextStepParts = nextHasFinalText ? deduped.slice(0, lastTextIdx) : deduped
    const nextFinalParts = nextHasFinalText ? deduped.slice(lastTextIdx) : []

    let nextStepsCount = 0
    if (nextHasFinalText) {
      for (const part of nextStepParts) {
        if (
          part.type === 'tool' ||
          part.type === 'reasoning' ||
          part.type === 'retry' ||
          part.type === 'subtask' ||
          (part.type === 'text' && (part.text as string)?.trim())
        ) {
          nextStepsCount += 1
        }
      }
    }

    return {
      stepParts: nextStepParts,
      hasFinalText: nextHasFinalText,
      stepsCount: nextStepsCount,
      finalParts: nextFinalParts,
    }
  }, [deduped])

  if (safeParts.length === 0) return null

  const renderedSteps = <>{stepParts.map((part, idx) => renderPart(part, idx, isStreaming))}</>

  if (hasFinalText && !isStreaming) {
    return (
      <View>
        <CollapsibleSteps stepsCount={stepsCount}>{renderedSteps}</CollapsibleSteps>
        {finalParts.map((part, idx) => (
          <Fragment key={`final:${idx}`}>
            {renderPart(part, stepParts.length + idx, isStreaming)}
          </Fragment>
        ))}
      </View>
    )
  }

  return (
    <View>
      {renderedSteps}
      {hasFinalText
        ? finalParts.map((part, idx) => (
            <Fragment key={`final:${idx}`}>
              {renderPart(part, stepParts.length + idx, isStreaming)}
            </Fragment>
          ))
        : null}
    </View>
  )
}
