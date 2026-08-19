import { describe, expect, it, vi } from 'vitest'
import type { KanbanAction, KanbanEventPayload, KanbanSnapshot } from '../src/protocol.ts'
import type { KanbanHostTransport } from '../src/client/host-api.ts'
import { BoardStore } from '../src/client/store.ts'

class FakeTransport implements KanbanHostTransport {
  stateValue: KanbanSnapshot = { revision: 0, projects: [] }
  actions: KanbanAction[] = []
  failState = false
  failAction = false
  private listeners = new Set<(payload?: KanbanEventPayload) => void>()

  async state(): Promise<KanbanSnapshot> {
    if (this.failState) throw new Error('state boom')
    return this.stateValue
  }

  async action(action: KanbanAction): Promise<KanbanSnapshot> {
    this.actions.push(action)
    if (this.failAction) throw new Error('action boom')
    return this.stateValue
  }

  subscribe(listener: (payload?: KanbanEventPayload) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(payload: KanbanEventPayload): void {
    for (const listener of this.listeners) listener(payload)
  }
}

function project(overrides: Partial<{ id: string; status: string }> = {}) {
  return { id: overrides.id ?? 'p1', status: overrides.status ?? 'designing' }
}

describe('BoardStore', () => {
  it('start() pulls the initial state and subscribes to the stream', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 3, projects: [project()] as never }
    const store = new BoardStore(transport)
    const unsubscribe = store.start()
    await vi.waitFor(() => {
      expect(store.getSnapshot().revision).toBe(3)
    })
    // A streamed payload replaces the snapshot and notifies subscribers.
    const listener = vi.fn()
    const stop = store.subscribe(listener)
    transport.emit({ revision: 4, projects: [] })
    expect(store.getSnapshot().revision).toBe(4)
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    unsubscribe()
  })

  it('apply() forwards the action and adopts the response snapshot', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 5, projects: [project({ id: 'p9' })] as never }
    const store = new BoardStore(transport)
    await store.apply({ kind: 'confirm-plan', projectId: 'p9' })
    expect(transport.actions).toEqual([{ kind: 'confirm-plan', projectId: 'p9' }])
    expect(store.getSnapshot().revision).toBe(5)
    expect(store.getError()).toBeNull()
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
