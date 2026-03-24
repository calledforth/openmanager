import { ConvexReactClient } from 'convex/react'

export const convexUrl = import.meta.env.CONVEX_URL as string
export const convex = convexUrl ? new ConvexReactClient(convexUrl) : null
