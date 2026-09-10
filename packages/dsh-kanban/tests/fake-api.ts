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
    cancelled: [] as string[],
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
    cancel: async (request: { payload: { sessionId: string } }) => {
      this.sessions.cancelled.push(request.payload.sessionId)
      return { result: { ok: true as const, value: { accepted: true as const } } }
    },
  }

  create: KanbanApi['create'] = async request => {
    const response = await this.sessions.create({ payload: request })
    if (!response.result.ok) throw new Error(response.result.error.message)
    return response.result.value
  }

  rename: KanbanApi['rename'] = async request => {
    const response = await this.sessions.rename({ payload: request })
    if (!response.result.ok) throw new Error(response.result.error.message)
    return response.result.value
  }

  prompt: KanbanApi['prompt'] = async request => {
    const response = await this.sessions.prompt({ payload: request })
    if (!response.result.ok) throw new Error(response.result.error.message)
    return response.result.value
  }

  list: KanbanApi['list'] = async () => {
    const response = await this.sessions.list()
    if (!response.result.ok) throw new Error(response.result.error.message)
    return response.result.value
  }

  inspect: KanbanApi['inspect'] = async sessionId => ({
    events: this.sessions.histories.get(sessionId) ?? [],
  })

  cancel: KanbanApi['cancel'] = async request => {
    const response = await this.sessions.cancel({ payload: request })
    if (!response.result.ok) throw new Error(response.result.error.message)
    return response.result.value
  }
}
