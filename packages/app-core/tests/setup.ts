// jsdom has no ResizeObserver; the Fluid sidebar's scroll area measures with
// one. Nothing resizes in tests, so it never needs to fire.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// jsdom lays nothing out, so it has no `checkVisibility` (and every element
// has no client rects). Stand one in that reads what jsdom does know: an
// element is hidden under `hidden` or an inline `display: none`. A test that
// needs CSS-hidden elements (a breakpoint) stubs it further.
function displayed(element: Element): boolean {
  if (element.hasAttribute('hidden')) return false
  if (element instanceof HTMLElement && element.style.display === 'none') return false
  return element.parentElement ? displayed(element.parentElement) : true
}

if (typeof Element !== 'undefined' && !('checkVisibility' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'checkVisibility', {
    configurable: true,
    writable: true,
    value(this: Element) {
      return this.isConnected && displayed(this)
    },
  })
}
