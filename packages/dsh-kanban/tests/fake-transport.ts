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
  /** The artifact content served by file(); keyed by path for per-fixture control. */
  fileValues = new Map<string, string>()
  failFile = false
  fileCalls: string[] = []
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

  async file(path: string): Promise<string> {
    this.fileCalls.push(path)
    if (this.failFile) throw new Error('file boom')
    const content = this.fileValues.get(path)
    if (content === undefined) throw new Error('file-not-found')
    return content
  }

  subscribe(listener: (payload?: KanbanEventPayload) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(payload: KanbanEventPayload): void {
    for (const listener of this.listeners) listener(payload)
  }
}
