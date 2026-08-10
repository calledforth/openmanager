import { useEffect, useState } from 'react'
import { activityRow, ToolLine } from './ToolLine'

type ImageToolPart = {
  state?: { status?: string }
  time?: { start?: number; end?: number }
}

function secondsBetween(start: number | undefined, end: number): number {
  if (start === undefined) return 0
  return Math.max(0, Math.round((end - start) / 1000))
}

export function ImageGenerationToolPart({ part }: { part: ImageToolPart }) {
  const running = part.state?.status === 'pending' || part.state?.status === 'running'
  const failed = part.state?.status === 'error'
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [running])

  const elapsed = secondsBetween(part.time?.start, part.time?.end ?? now)
  const verb = running ? 'Generating image' : failed ? 'Image generation failed' : 'Generated image'
  const detail = running ? `for ${elapsed}s` : `in ${elapsed}s`

  return (
    <div className={activityRow} aria-live="polite">
      <ToolLine verb={verb} detail={detail} isRunning={running} />
    </div>
  )
}
