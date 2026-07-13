import { ConvexReactClient } from 'convex/react'

let convexClient: ConvexReactClient | null = null

export function createConvexClient(url: string): ConvexReactClient {
  convexClient = new ConvexReactClient(url)
  return convexClient
}

export function getConvexClient(): ConvexReactClient | null {
  return convexClient
}
