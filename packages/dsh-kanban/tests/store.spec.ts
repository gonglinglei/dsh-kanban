import { describe, expect, it, vi } from 'vitest'
import { BoardStore } from '../src/client/store.ts'
import { FakeTransport } from './fake-transport.ts'

function project(overrides: Partial<{ id: string; status: string }> = {}) {
  return { id: overrides.id ?? 'p1', status: overrides.status ?? 'designing' }
}

describe('BoardStore', () => {
  it('start() pulls the initial state and subscribes to the stream', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 3, projects: [project()] as never, tasks: [] }
    const store = new BoardStore(transport)
    const unsubscribe = store.start()
    await vi.waitFor(() => {
      expect(store.getSnapshot().revision).toBe(3)
    })
    // A streamed payload replaces the snapshot and notifies subscribers.
    const listener = vi.fn()
    const stop = store.subscribe(listener)
    transport.emit({ revision: 4, projects: [], tasks: [] })
    expect(store.getSnapshot().revision).toBe(4)
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    unsubscribe()
  })

  it('apply() forwards the action and adopts the response snapshot', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 5, projects: [project({ id: 'p9' })] as never, tasks: [] }
    const store = new BoardStore(transport)
    await store.apply({ kind: 'confirm-plan', projectId: 'p9' })
    expect(transport.actions).toEqual([{ kind: 'confirm-plan', projectId: 'p9' }])
    expect(store.getSnapshot().revision).toBe(5)
    expect(store.getError()).toBeNull()
  })

  it('readFile() delegates to the transport without touching the snapshot', async () => {
    const transport = new FakeTransport()
    transport.fileValues.set('/w/plan.md', '# 方案')
    const store = new BoardStore(transport)
    await expect(store.readFile('/w/plan.md')).resolves.toBe('# 方案')
    expect(transport.fileCalls).toEqual(['/w/plan.md'])
    expect(store.getSnapshot().revision).toBe(0)
  })

  it('captures action failures as the last error and clears it on the next success', async () => {
    const transport = new FakeTransport()
    const store = new BoardStore(transport)
    transport.failAction = true
    await store.apply({ kind: 'delete-project', projectId: 'p1' })
    expect(store.getError()).toContain('action boom')
    transport.failAction = false
    await store.apply({ kind: 'delete-project', projectId: 'p1' })
    expect(store.getError()).toBeNull()
  })

  it('refresh() failure surfaces the error without throwing', async () => {
    const transport = new FakeTransport()
    const store = new BoardStore(transport)
    transport.failState = true
    await store.refresh()
    expect(store.getError()).toContain('state boom')
  })
})
