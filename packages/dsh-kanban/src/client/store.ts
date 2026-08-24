/**
 * Board store: the browser's single view over the host ledger. The host is
 * authoritative; every mutation goes through apply() and every live update
 * lands through the transport subscription. Framework-free — the React view
 * reads it with useSyncExternalStore.
 */
import type { KanbanAction, KanbanSnapshot } from '../protocol.ts'
import type { KanbanHostTransport } from './host-api.ts'

export class BoardStore {
  private snapshot: KanbanSnapshot = { revision: 0, projects: [], tasks: [] }
  private lastError: string | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly transport: KanbanHostTransport) {}

  /** Subscribe to the SSE stream and fetch the initial state; returns the disposer. */
  start(): () => void {
    const unsubscribe = this.transport.subscribe((payload) => {
      if (payload !== undefined) {
        this.snapshot = payload
        this.notify()
      } else {
        void this.refresh()
      }
    })
    void this.refresh()
    return () => {
      unsubscribe()
    }
  }

  /**
   * The snapshot read face. Arrow property: React calls it as an extracted
   * function reference (no receiver), and an unbound prototype method would
   * throw TypeError and white-screen the board.
   */
  getSnapshot = (): KanbanSnapshot => {
    return this.snapshot
  }

  /**
   * The last action/refresh failure, or null when healthy. Arrow property for
   * the same extracted-call reason as getSnapshot.
   */
  getError = (): string | null => {
    return this.lastError
  }

  /**
   * Subscribe to snapshot changes. Arrow property: React calls it as an
   * extracted function reference (no receiver).
   */
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Re-pull the full snapshot from the host. */
  async refresh(): Promise<void> {
    try {
      this.snapshot = await this.transport.state()
      this.lastError = null
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    this.notify()
  }

  /** Send one human action; the host's response snapshot becomes the new view. */
  async apply(action: KanbanAction): Promise<void> {
    try {
      this.snapshot = await this.transport.action(action)
      this.lastError = null
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
