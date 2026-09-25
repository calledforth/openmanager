import type { ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { SizeProvider } from '../components/fluid/lib/size-context'
import { TooltipProvider } from '../components/fluid/ui/tooltip'

/**
 * The Fluid Functionalism context Tend mounts at its root: motion that
 * honours the OS reduced-motion preference, the compact control ladder, and
 * one tooltip group so adjacent tips open without re-waiting the delay. Shape,
 * icon and surface contexts fall back to sane defaults without a provider.
 */
export function FluidProviders({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <SizeProvider size="compact">
        <TooltipProvider>{children}</TooltipProvider>
      </SizeProvider>
    </MotionConfig>
  )
}
