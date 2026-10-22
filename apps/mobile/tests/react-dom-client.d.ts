// The app renders with React Native; only the jsdom tests mount through
// react-dom, so its types are declared here rather than added as a package.
declare module 'react-dom/client' {
  import type { ReactNode } from 'react'

  export interface Root {
    render(children: ReactNode): void
    unmount(): void
  }

  export function createRoot(container: Element | DocumentFragment): Root
}
