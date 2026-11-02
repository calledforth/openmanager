import { useEffect, useState } from 'react'
import { presentToolPart, type ToolOutcome } from './toolPresenter'
import { activityRow, ToolLine } from './ToolLine'

type ImageToolPart = {
  state?: { status?: string }
  time?: { start?: number; end?: number }
}

const ENDED: Record<ToolOutcome, string> = {
  failed: 'Image generation failed',
  declined: 'Image generation declined',
  cancelled: 'Image generation cancelled',
}

function secondsBetween(start: number | undefined, end: number): number {
  if (start === undefined) return 0
  return Math.max(0, Math.round((end - start) / 1000))
}

export function ImageGenerationToolPart({ part }: { part: ImageToolPart }) {
  const { isRunning: running, outcome } = presentToolPart({ state: part.state })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [running])

  const elapsed = secondsBetween(part.time?.start, part.time?.end ?? now)
  const verb = running ? 'Generating image' : outcome ? ENDED[outcome] : 'Generated image'
  const detail = running ? `for ${elapsed}s` : outcome ? undefined : `in ${elapsed}s`

  return (
    <div className={activityRow} aria-live="polite">
      <ToolLine verb={verb} detail={detail} isRunning={running} />
    </div>
  )
}
