import { TextPart } from './TextPart'
import { ToolCallPart } from './ToolCallPart'
import { ThinkingPart } from './ThinkingPart'
import { StepMeta } from './StepMeta'

interface Part {
  type: string
  id: string
  [key: string]: unknown
}

function FallbackPart({ part }: { part: Part }) {
  if (part.type === 'step-start' || part.type === 'snapshot' || part.type === 'agent') return null
  return (
    <div className="text-[11px] text-muted-foreground py-0.5 font-medium italic">
      {part.type}
      {(part as Record<string, unknown>).tool ? `: ${(part as Record<string, unknown>).tool}` : ''}
    </div>
  )
}

export function MessageParts({ parts, isStreaming }: { parts: Part[]; isStreaming?: boolean }) {
  if (!parts || parts.length === 0) return null

  const seen = new Set<string>()
  const deduped = parts.filter((p) => {
    const id = p.id ?? (p as { callID?: string }).callID
    if (id) {
      if (seen.has(id)) return false
      seen.add(id)
    }
    return true
  })

  return (
    <>
      {deduped.map((part, idx) => {
        const key = part.id ?? (part as { callID?: string }).callID ?? `part_${idx}`
        switch (part.type) {
          case 'text': {
            const text = (part.text as string) ?? ''
            if (part.synthetic || part.ignored) return null
            return <TextPart key={key} text={text} />
          }
          case 'tool':
            return <ToolCallPart key={key} part={part as Parameters<typeof ToolCallPart>[0]['part']} />
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
          case 'step-finish':
            return (
              <StepMeta
                key={key}
                reason={part.reason as string}
                cost={part.cost as number}
                tokens={part.tokens as { input?: number; output?: number }}
                model={part.model as string}
                duration={
                  part.time && typeof part.time === 'object'
                    ? ((part.time as Record<string, number>).end ?? 0) -
                      ((part.time as Record<string, number>).start ?? 0)
                    : undefined
                }
              />
            )
          case 'retry':
            return (
              <div key={key} className="text-sm text-amber-400 py-1">
                Retrying (attempt {(part.attempt as number) ?? '?'})
                {part.error ? `: ${part.error}` : ''}
              </div>
            )
          case 'subtask':
            return (
              <div key={key} className="text-sm text-violet-400 py-1">
                Subtask: {(part.description as string) ?? (part.prompt as string) ?? 'running'}
              </div>
            )
          case 'compaction':
            return (
              <div key={key} className="text-[11px] text-muted-foreground py-1 italic">
                Session compacted
              </div>
            )
          default:
            return <FallbackPart key={key} part={part} />
        }
      })}
    </>
  )
}
