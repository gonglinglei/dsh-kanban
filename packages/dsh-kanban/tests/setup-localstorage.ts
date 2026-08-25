/**
 * Vitest jsdom setup: rebind localStorage to the real jsdom Storage.
 *
 * Vitest's populateGlobal getter for `localStorage` resolves to undefined
 * in the populated test global even though the underlying jsdom window has
 * a working Storage (jsdom 25 + vitest 3 quirk). Rebind it here so suites
 * exercising localStorage behave like a browser. No-op outside jsdom.
 */
const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window
if (jsdomWindow !== undefined && typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: jsdomWindow.localStorage,
    configurable: true,
    writable: true,
  })
}
