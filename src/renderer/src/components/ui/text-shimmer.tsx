import React, { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
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

  const MotionComponent = useMemo(() => motion.create(Component), [Component])

  return (
    <MotionComponent
      className={cn('relative inline-block bg-clip-text', className)}
      style={{
        backgroundSize: '250% 100%',
        backgroundImage: `linear-gradient(
          90deg,
          currentColor 0%,
          currentColor 40%,
          color-mix(in oklab, currentColor, transparent 70%) 50%,
          currentColor 60%,
          currentColor 100%
        )`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      }}
      initial={{ backgroundPosition: '100% center' }}
      animate={shouldAnimate ? { backgroundPosition: '0% center' } : undefined}
      transition={{
        repeat: Infinity,
        duration,
        ease: 'linear',
      }}
    >
      {children}
    </MotionComponent>
  )
}

export const TextShimmer = React.memo(TextShimmerComponent)
