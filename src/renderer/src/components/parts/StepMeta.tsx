interface StepMetaProps {
  reason?: string
  cost?: number
  tokens?: { input?: number; output?: number }
  model?: string
  duration?: number
}

export function StepMeta({ cost, tokens, model, duration }: StepMetaProps) {
  const parts: string[] = []
  if (model) parts.push(model)
  if (duration != null) parts.push(`${(duration / 1000).toFixed(1)}s`)
  if (tokens?.input != null || tokens?.output != null) {
    const inp = tokens?.input ?? 0
    const out = tokens?.output ?? 0
    parts.push(`${inp + out} tokens`)
  }
  if (cost != null && cost > 0) parts.push(`$${cost.toFixed(4)}`)

  if (parts.length === 0) return null

  return (
    <div className="flex gap-3 py-1 text-[11px] text-muted-foreground border-t border-border mt-1">
      {parts.map((p, i) => (
        <span key={i} className="tabular-nums">{p}</span>
      ))}
    </div>
  )
}
