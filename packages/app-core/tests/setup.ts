// jsdom has no ResizeObserver; the Fluid sidebar's scroll area measures with
// one. Nothing resizes in tests, so it never needs to fire.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
