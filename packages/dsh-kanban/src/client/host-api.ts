/**
 * Kanban host transport (browser half): same-origin fetch for state/actions
 * and an EventSource stream for live updates, with a visibilitychange refetch
 * fallback. Mirrors the dsh-web-ui task-board HttpTaskBoardHostTransport
 * pattern (Apache-2.0).
 */
import {
  KANBAN_API_PREFIX,
  type ArchiveEntry, type KanbanAction, type KanbanActionEnvelope, type KanbanEventPayload, type KanbanSnapshot,
} from '../protocol.ts'

const REQUEST_TIMEOUT_MS = 15_000

export interface KanbanHostTransport {
  state(): Promise<KanbanSnapshot>
  action(action: KanbanAction): Promise<KanbanSnapshot>
  /** Read one project artifact (plan.md preview); kept out of the snapshot on purpose. */
  file(path: string): Promise<string>
  /**
   * Read the archived records. On-demand like file(): the archive is
   * deliberately absent from the hot snapshot (a host that declares
   * CAPABILITY_TASK_ARCHIVE serves it at GET /kanban/archive).
   * @param projectId - narrow to one project's cluster (used by a display page
   *   that must pull back archived siblings for a complete dependency graph).
   *   `undefined` means "no filter"; never pass `''` (the route rejects blank).
   */
  archive(projectId?: string): Promise<ArchiveEntry[]>
  subscribe(listener: (payload?: KanbanEventPayload) => void): () => void
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  let body: (T & { error?: string }) | undefined
  if (text !== '') {
    try {
      body = JSON.parse(text) as T & { error?: string }
    } catch {
      throw new Error(`kanban host returned non-JSON response (HTTP ${response.status})`)
    }
  }
  if (!response.ok) {
    throw new Error(body?.error ?? `kanban request failed: HTTP ${response.status}`)
  }
  if (body === undefined) throw new Error(`kanban host returned empty response (HTTP ${response.status})`)
  return body
}

export class HttpKanbanHostTransport implements KanbanHostTransport {
  async state(): Promise<KanbanSnapshot> {
    const body = await this.request<{ ok: boolean; snapshot: KanbanSnapshot }>(`${KANBAN_API_PREFIX}/state`, { cache: 'no-store' })
    return body.snapshot
  }

  async action(action: KanbanAction): Promise<KanbanSnapshot> {
    const envelope: KanbanActionEnvelope = { requestId: uuid(), action }
    const body = await this.request<{ ok: boolean; snapshot: KanbanSnapshot }>(`${KANBAN_API_PREFIX}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
    return body.snapshot
  }

  async file(path: string): Promise<string> {
    const body = await this.request<{ ok: boolean; content: string }>(
      `${KANBAN_API_PREFIX}/file?path=${encodeURIComponent(path)}`,
      { cache: 'no-store' },
    )
    return body.content
  }

  async archive(projectId?: string): Promise<ArchiveEntry[]> {
    const query = projectId === undefined ? '' : `?projectId=${encodeURIComponent(projectId)}`
    const body = await this.request<{ ok: boolean; archive: ArchiveEntry[] }>(
      `${KANBAN_API_PREFIX}/archive${query}`,
      { cache: 'no-store' },
    )
    return body.archive
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    try {
      return await readJson<T>(await fetch(url, { ...init, signal: controller.signal }))
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`kanban host request timed out after ${REQUEST_TIMEOUT_MS / 1_000}s`)
      throw error
    } finally {
      globalThis.clearTimeout(timeout)
    }
  }

  subscribe(listener: (payload?: KanbanEventPayload) => void): () => void {
    const events = new EventSource(`${KANBAN_API_PREFIX}/events`)
    events.onmessage = (message: MessageEvent<string>): void => {
      try {
        const parsed = JSON.parse(message.data) as KanbanEventPayload
        if (parsed === null || typeof parsed !== 'object' || typeof parsed.revision !== 'number') throw new Error('invalid event frame')
        listener(parsed)
      } catch {
        listener()
      }
    }
    // The heartbeat and reconnect gaps are covered by a refetch whenever the
    // tab becomes visible again.
    const onVisible = (): void => { if (document.visibilityState === 'visible') listener() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      events.close()
    }
  }
}
