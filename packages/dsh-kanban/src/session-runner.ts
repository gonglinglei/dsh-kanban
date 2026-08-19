/**
 * Kanban session runner: drives real dsh sessions through the host API
 * proxy (the dsh-web-ui task-board HostExecutionRunner pattern, Apache-2.0).
 *
 * Launch = sessions.create (with cwd) + rename + prompt(mode:'queue').
 * Completion = polling sessions.history for the first turn/end event after
 * the launch timestamp; a turn/end whose data.reason.kind is 'error' is a
 * failure. The poll loop lives in spawner.ts.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from './protocol.ts'

/** One RPC request (rpcId echoes back in the response). */
export interface KanbanRpcRequest<T> {
  rpcId: string
  payload: T
}

/** One RPC response (the narrow shape the runner needs). */
export type KanbanRpcResponse<T> =
  | { result: { ok: true; value: T } }
  | { result: { ok: false; error: { code: string; message: string } } }

/** One session-list row (the narrow slice the runner inspects). */
export interface KanbanSessionSummary {
  sessionId: string
  running: boolean
  completed?: boolean
  blank?: boolean
  agentPreset?: string
}

/** One history event (the narrow slice the runner inspects). */
export interface KanbanHistoryEvent {
  event: { type: string; seq?: number; time?: number; data: unknown }
}

/** The host API surface the runner uses (a structural slice of ctx.apiProxy). */
export interface KanbanApi {
  sessions: {
    create(request: KanbanRpcRequest<{ cwd?: string; workspaceId?: string; agentPreset?: string }>): Promise<KanbanRpcResponse<{ sessionId: string }>>
    rename(request: KanbanRpcRequest<{ sessionId: string; title: string }>): Promise<KanbanRpcResponse<unknown>>
    prompt(request: KanbanRpcRequest<{ sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }> }>): Promise<KanbanRpcResponse<unknown>>
    list(request: KanbanRpcRequest<unknown>): Promise<KanbanRpcResponse<{ items: KanbanSessionSummary[] }>>
    history(request: KanbanRpcRequest<{ sessionId: string; maxMessages?: number; beforeSeq?: number }>): Promise<KanbanRpcResponse<{ events: KanbanHistoryEvent[]; hasMore: boolean }>>
  }
}

/** One execution's resolved outcome. */
export type ExecutionInspection =
  | { outcome: 'pending' }
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'cancelled'; error: string }

/** A post-create launch failure that still identifies the session. */
export class SessionLaunchError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    super(`execution session ${sessionId} failed during launch: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'SessionLaunchError'
  }
}

function request<T>(payload: T): KanbanRpcRequest<T> {
  return { rpcId: `kanban-${crypto.randomUUID()}`, payload }
}

function failure(error: { code: string; message: string }): Error {
  return new Error(`${error.code}: ${error.message}`)
}

function isErrorTurnEnd(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const reason = (data as { reason?: unknown }).reason
  return typeof reason === 'object' && reason !== null && (reason as { kind?: unknown }).kind === 'error'
}

/** The design agent's task prompt: produce the plan, then stop. */
export function designPrompt(project: Project): string {
  return [
    '你是 dsh-kanban 的设计 agent。请为以下项目目标产出一份可执行的方案。',
    '',
    `项目：${project.title}`,
    `工作目录：${project.workspaceDir}`,
    `目标：${project.goal}`,
    '',
    '要求：',
    `1. 把方案写入 ${join(project.workspaceDir, 'plan.md')}（Markdown）。`,
    '2. 方案必须包含：目标拆解、执行步骤、验收标准。',
    '3. 写完方案后结束你的回合，不要继续做其他事。',
  ].join('\n')
}

/** The execution agent's task prompt: read the confirmed plan and execute it. */
export function executePrompt(project: Project): string {
  return [
    '你是 dsh-kanban 的执行 agent。方案已经人工确认，请执行。',
    '',
    `项目：${project.title}`,
    `工作目录：${project.workspaceDir}`,
    `方案文件：${project.planPath ?? join(project.workspaceDir, 'plan.md')}`,
    '',
    '要求：按照方案逐步执行，全部完成后结束你的回合。',
  ].join('\n')
}

/** The design-resume prompt: apply the human's feedback, then stop. */
export function resumePrompt(project: Project): string {
  return [
    '设计需要修改。人工反馈如下：',
    '',
    project.feedback ?? '（无具体反馈，请自行检查方案质量后改进）',
    '',
    `请修改 ${join(project.workspaceDir, 'plan.md')} 后结束你的回合。`,
  ].join('\n')
}

export class KanbanSessionRunner {
  constructor(private readonly api: KanbanApi) {}

  /** Create + rename + prompt a fresh design session; returns the session id. */
  async launchDesign(project: Project): Promise<string> {
    return this.launch(project, designPrompt(project), `${project.title}·设计`)
  }

  /** Create + rename + prompt a fresh execution session; returns the session id. */
  async launchExecute(project: Project): Promise<string> {
    return this.launch(project, executePrompt(project), `${project.title}·执行`)
  }

  /** Prompt the project's existing design session with the rejection feedback. */
  async resumeDesign(project: Project): Promise<string> {
    if (project.sessionId === undefined) throw new Error('resume requested but no session is attached')
    const sessionId = project.sessionId
    try {
      const prompted = await this.api.sessions.prompt(request({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: resumePrompt(project) }],
      }))
      if (!prompted.result.ok) throw failure(prompted.result.error)
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  /** Whether the plan file exists on disk (the design turn's required artifact). */
  planExists(project: Project): boolean {
    return existsSync(join(project.workspaceDir, 'plan.md'))
  }

  /** Create + rename + prompt one fresh session; returns the session id. */
  private async launch(project: Project, promptText: string, title: string): Promise<string> {
    // The user may point a project at a directory that does not exist yet;
    // the design agent needs it before it can write plan.md.
    mkdirSync(project.workspaceDir, { recursive: true })
    const created = await this.api.sessions.create(request({ cwd: project.workspaceDir }))
    if (!created.result.ok) throw failure(created.result.error)
    const sessionId = created.result.value.sessionId
    try {
      const renamed = await this.api.sessions.rename(request({ sessionId, title }))
      if (!renamed.result.ok) throw failure(renamed.result.error)
      const prompted = await this.api.sessions.prompt(request({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptText }],
      }))
      if (!prompted.result.ok) throw failure(prompted.result.error)
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  /** Count of running sessions (one sessions.list RPC per poll tick). */
  async listRunning(): Promise<{ known: true; count: number; items: KanbanSessionSummary[] } | { known: false }> {
    try {
      const response = await this.api.sessions.list(request({}))
      return response.result.ok
        ? { known: true, count: response.result.value.items.filter(item => item.running).length, items: response.result.value.items }
        : { known: false }
    } catch {
      return { known: false }
    }
  }

  /**
   * Resolve one execution's outcome. The caller may pass the session list it
   * already fetched this poll tick; otherwise the runner lists sessions itself.
   * @param sessionId - the session under inspection.
   * @param startedAt - launch timestamp (epoch millis); 0 inspects the whole history.
   * @param sessions - the poll tick's session list, when already fetched.
   */
  async inspect(sessionId: string, startedAt = 0, sessions?: readonly KanbanSessionSummary[]): Promise<ExecutionInspection> {
    let items: readonly KanbanSessionSummary[]
    if (sessions !== undefined) {
      items = sessions
    } else {
      const response = await this.api.sessions.list(request({}))
      if (!response.result.ok) return { outcome: 'pending' }
      items = response.result.value.items
    }
    const summary = items.find(item => item.sessionId === sessionId)
    if (summary === undefined) return { outcome: 'cancelled', error: 'execution session no longer exists' }
    if (summary.running) return { outcome: 'pending' }
    const events: KanbanHistoryEvent[] = []
    let beforeSeq: number | undefined
    let reachedExecutionBoundary = false
    for (let page = 0; page < 100; page += 1) {
      const history = await this.api.sessions.history(request({
        sessionId: summary.sessionId,
        maxMessages: 100,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      }))
      if (!history.result.ok) return { outcome: 'pending' }
      events.push(...history.result.value.events)
      const oldestTime = history.result.value.events.reduce<number | undefined>((oldest, entry) => {
        const time = entry.event.time
        return typeof time !== 'number' ? oldest : oldest === undefined ? time : Math.min(oldest, time)
      }, undefined)
      if (!history.result.value.hasMore || (oldestTime !== undefined && oldestTime <= startedAt)) {
        reachedExecutionBoundary = true
        break
      }
      const oldestSeq = history.result.value.events.reduce<number | undefined>((oldest, entry) => {
        const seq = entry.event.seq
        return typeof seq !== 'number' ? oldest : oldest === undefined ? seq : Math.min(oldest, seq)
      }, undefined)
      if (oldestSeq === undefined || oldestSeq === beforeSeq) return { outcome: 'pending' }
      beforeSeq = oldestSeq
    }
    if (!reachedExecutionBoundary) return { outcome: 'pending' }
    const turnEnd = events
      .filter(entry => entry.event.type === 'turn/end' && (
        startedAt <= 0 || (typeof entry.event.time === 'number' && entry.event.time >= startedAt)
      ))
      .sort((a, b) => (a.event.seq ?? Number.MAX_SAFE_INTEGER) - (b.event.seq ?? Number.MAX_SAFE_INTEGER))[0]
    if (turnEnd === undefined) return { outcome: 'pending' }
    return isErrorTurnEnd(turnEnd.event.data)
      ? { outcome: 'failed', error: 'agent turn ended with an error' }
      : { outcome: 'succeeded' }
  }
}
