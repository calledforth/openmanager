import '@testing-library/jest-dom/vitest'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

window.scrollTo = () => undefined

// jsdom has no ResizeObserver; the Fluid sidebar's scroll area and the tabs
// measure with one. Nothing resizes in tests, so it never needs to fire.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// jsdom's selector engine (nwsapi) answers `:modal` by re-checking
// `:fullscreen` across the document, and floating-ui asks `:modal` /
// `:popover-open` every time it repositions a tooltip or menu. One test that
// returned focus to a tooltip trigger spent ~10 s and 14.7M `matches` calls
// here. Nothing in jsdom is ever fullscreen or a modal top-layer element.
if (typeof Element !== 'undefined') {
  const nativeMatches = Element.prototype.matches
  Element.prototype.matches = function matches(this: Element, selector: string) {
    if (selector === ':fullscreen' || selector === ':modal') return false
    return nativeMatches.call(this, selector)
  }
}
