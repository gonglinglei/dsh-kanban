/**
 * A controllable fake of the kanban host transport shared by the store and
 * board suites.
 */
import type { KanbanAction, KanbanEventPayload, KanbanSnapshot } from '../src/protocol.ts'
import type { KanbanHostTransport } from '../src/client/host-api.ts'

export class FakeTransport implements KanbanHostTransport {
  stateValue: KanbanSnapshot = { revision: 0, projects: [], tasks: [] }
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
