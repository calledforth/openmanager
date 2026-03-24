import { useMemo, type ReactNode } from 'react'
import { TextPart } from './TextPart'
import { ToolCallPart } from './ToolCallPart'
import { BashToolPart } from './BashToolPart'
import { EditToolPart } from './EditToolPart'
import { ThinkingPart } from './ThinkingPart'
import { CollapsibleSteps } from './CollapsibleSteps'
import { canonicalizeToolName } from './ToolRegistry'

interface Part {
  type: string
  id: string
  [key: string]: unknown
}

function getPartKey(part: Part, index: number): string {
  const callId = (part as { callID?: string }).callID
  if (part.id) return part.id
  if (callId) return callId
  if (part.type === 'tool') {
    return `tool:${String(part.tool ?? 'unknown')}:${index}`
  }
  return `${part.type}:${index}`
}

function FallbackPart({ part }: { part: Part }) {
  if (part.type === 'step-start' || part.type === 'snapshot' || part.type === 'agent' || part.type === 'step-finish') {
    return null
  }
  return (
    <div className="text-[11px] text-muted-foreground py-0.5 font-medium italic px-2">
      {part.type}
      {(part as Record<string, unknown>).tool ? `: ${(part as Record<string, unknown>).tool}` : ''}
    </div>
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
    case 'tool': {
      const toolName = canonicalizeToolName((part.tool as string) ?? '')
      if (toolName === 'Bash') {
        return <BashToolPart key={key} part={part as Parameters<typeof BashToolPart>[0]['part']} />
      }
      if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
        return <EditToolPart key={key} part={part as Parameters<typeof EditToolPart>[0]['part']} />
      }
      return <ToolCallPart key={key} part={part as Parameters<typeof ToolCallPart>[0]['part']} />
    }
    case 'reasoning':
      return (
        <ThinkingPart
          key={key}
          text={(part.text as string) ?? ''}
          isStreaming={isStreaming}
          duration={
            part.time && typeof part.time === 'object'
              ? ((part.time as Record<string, number>).end ?? Date.now()) -
                ((part.time as Record<string, number>).start ?? Date.now())
              : undefined
          }
        />
      )
    case 'retry':
      return (
        <div key={key} className="text-xs text-amber-400 py-0.5 px-2">
          Retrying (attempt {(part.attempt as number) ?? '?'})
          {part.error ? `: ${part.error}` : ''}
        </div>
      )
    case 'subtask':
      return (
        <div key={key} className="text-xs text-violet-400 py-0.5 px-2">
          Subtask: {(part.description as string) ?? (part.prompt as string) ?? 'running'}
        </div>
      )
    case 'compaction':
      return (
        <div key={key} className="text-[11px] text-muted-foreground py-0.5 italic px-2">
          Session compacted
        </div>
      )
    default:
      return <FallbackPart key={key} part={part} />
  }
}

function isToolOrExploringStep(part: Part): boolean {
  return (
    part.type === 'tool' || part.type === 'reasoning' || part.type === 'retry' || part.type === 'subtask'
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

    const hasToolsBefore = lastTextIdx > 0 && deduped.slice(0, lastTextIdx).some(isToolOrExploringStep)
    const nextHasFinalText = lastTextIdx > 0 && hasToolsBefore
    const nextStepParts = nextHasFinalText ? deduped.slice(0, lastTextIdx) : deduped
    const nextFinalParts = nextHasFinalText ? deduped.slice(lastTextIdx) : []

    let nextStepsCount = 0
    if (nextHasFinalText) {
      for (const part of nextStepParts) {
        if (part.type === 'tool' || (part.type === 'text' && (part.text as string)?.trim())) {
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
      <>
        <CollapsibleSteps stepsCount={stepsCount}>{renderedSteps}</CollapsibleSteps>
        {finalParts.map((part, idx) => renderPart(part, stepParts.length + idx, isStreaming))}
      </>
    )
  }

  return (
    <>
      {renderedSteps}
      {hasFinalText && finalParts.map((part, idx) => renderPart(part, stepParts.length + idx, isStreaming))}
    </>
  )
}
