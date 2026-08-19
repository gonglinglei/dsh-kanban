/**
 * The React consumption contract of BoardStore: React calls subscribe /
 * getSnapshot / getError as extracted function references (no receiver).
 * This is the seam that produced the GUI white screen — unbound prototype
 * methods throw TypeError the moment useSyncExternalStore calls them.
 */
import { describe, expect, it } from 'vitest'
import { BoardStore } from '../src/client/store.ts'
import { FakeTransport } from './fake-transport.ts'

describe('BoardStore consumed the way useSyncExternalStore consumes it', () => {
  it('subscribe works as an extracted callback', () => {
    const store = new BoardStore(new FakeTransport())
    const extractedSubscribe = store.subscribe
    const listener = () => {}
    // React calls subscribe(callback) with no receiver — this must not throw.
    expect(() => {
      const unsubscribe = extractedSubscribe(listener)
      unsubscribe()
    }).not.toThrow()
  })

  it('getSnapshot works as an extracted callback and returns the live snapshot', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 7, projects: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    const extractedGetSnapshot = store.getSnapshot
    expect(extractedGetSnapshot()).toEqual({ revision: 7, projects: [] })
  })

  it('getError works as an extracted callback', () => {
    const store = new BoardStore(new FakeTransport())
    const extractedGetError = store.getError
    expect(extractedGetError()).toBeNull()
  })

  it('extracted subscribe delivers notifications (the store stays usable via React)', () => {
    const transport = new FakeTransport()
    const store = new BoardStore(transport)
    // Wire the transport into the store first; start() also kicks a refresh
    // whose async resolution lands after this synchronous test body.
    const stop = store.start()
    const extractedSubscribe = store.subscribe
    const extractedGetSnapshot = store.getSnapshot
    let calls = 0
    const unsubscribe = extractedSubscribe(() => { calls += 1 })
    transport.emit({ revision: 1, projects: [] })
    expect(calls).toBe(1)
    expect(extractedGetSnapshot().revision).toBe(1)
    unsubscribe()
    stop()
  })
})
