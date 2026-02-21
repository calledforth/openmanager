import React, { useState, useEffect } from 'react'
import { cn } from '../../lib/utils'

interface TextShimmerProps {
  children: React.ReactNode
  as?: React.ElementType
  className?: string
  duration?: number
  delay?: number
}

function TextShimmerComponent({
  children,
  as: Component = 'span',
  className,
  duration = 2,
  delay = 0,
}: TextShimmerProps) {
  const [shouldAnimate, setShouldAnimate] = useState(delay === 0)

  useEffect(() => {
    if (delay > 0) {
      const timer = setTimeout(() => setShouldAnimate(true), delay * 1000)
      return () => clearTimeout(timer)
    }
  }, [delay])

  if (!shouldAnimate) {
    return <Component className={className}>{children}</Component>
  }

  return (
    <Component
      className={cn('inline', className)}
      style={{
        backgroundImage: 'linear-gradient(90deg, var(--color-muted-foreground) 0%, var(--color-muted-foreground) 35%, rgba(255,255,255,0.9) 50%, var(--color-muted-foreground) 65%, var(--color-muted-foreground) 100%)',
        backgroundSize: '300% 100%',
        backgroundClip: 'text',
        WebkitBackgroundClip: 'text',
        color: 'transparent',
        animation: `text-shimmer ${duration}s ease-in-out infinite`,
      }}
    >
      {children}
    </Component>
  )
}

export const TextShimmer = React.memo(TextShimmerComponent)
