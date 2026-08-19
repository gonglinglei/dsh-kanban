/**
 * A controllable fake of the host API slice (KanbanApi) shared by the
 * session-runner and spawner suites.
 */
import type { KanbanApi, KanbanHistoryEvent, KanbanSessionSummary } from '../../src/session-runner.ts'

export class FakeApi implements KanbanApi {
  sessions = {
    nextId: 0,
    created: [] as Array<{ cwd?: string; workspaceId?: string }>,
    renamed: [] as Array<{ sessionId: string; title: string }>,
    prompted: [] as Array<{ sessionId: string; text: string }>,
    summaries: new Map<string, KanbanSessionSummary>(),
    histories: new Map<string, KanbanHistoryEvent[]>(),
    create: async (request: { payload: { cwd?: string; workspaceId?: string } }) => {
      const sessionId = `sess-${++this.sessions.nextId}`
      this.sessions.created.push(request.payload)
      this.sessions.summaries.set(sessionId, { sessionId, running: true })
      return { result: { ok: true as const, value: { sessionId } } }
    },
    rename: async (request: { payload: { sessionId: string; title: string } }) => {
      this.sessions.renamed.push(request.payload)
      return { result: { ok: true as const, value: {} } }
    },
    prompt: async (request: { payload: { sessionId: string; content: Array<{ type: 'text'; text: string }> } }) => {
      this.sessions.prompted.push({ sessionId: request.payload.sessionId, text: request.payload.content[0]?.text ?? '' })
      return { result: { ok: true as const, value: {} } }
    },
    list: async () => ({
      result: { ok: true as const, value: { items: [...this.sessions.summaries.values()] } },
    }),
    history: async (request: { payload: { sessionId: string } }) => ({
      result: { ok: true as const, value: { events: this.sessions.histories.get(request.payload.sessionId) ?? [], hasMore: false } },
    }),
  }
}
