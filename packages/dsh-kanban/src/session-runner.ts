/**
 * Kanban session runner: drives real dsh sessions through the host Session
 * Controller.
 *
 * Launch = create (with cwd) + rename + prompt(mode:'queue').
 * Completion = inspecting the Session event log for the first turn/end after
 * the launch timestamp; a turn/end whose data.reason.kind is 'error' is a
 * failure. The poll loop lives in spawner.ts.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionController, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Project, TaskNode } from './protocol.ts'

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

/** The host Session Controller surface the runner uses. */
export interface KanbanApi {
  create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }> }): Promise<unknown>
  list(request: { cursor?: string }): Promise<{ items: readonly KanbanSessionSummary[] }>
  inspect(sessionId: string): Promise<{ events: readonly KanbanHistoryEvent[] }>
  /** Stop the session's active turn. */
  cancel(request: { sessionId: string }): Promise<unknown>
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

/**
 * Adapt the branded current Session Controller contract to the small,
 * string-based surface persisted by the kanban ledger.
 */
export function createKanbanApi(controller: SessionController): KanbanApi {
  const sessionId = (value: string): SessionId => value as SessionId
  const signal = (): AbortSignal => new AbortController().signal
  return {
    create: async request => controller.create(request),
    rename: async request => controller.rename({ ...request, sessionId: sessionId(request.sessionId) }),
    prompt: async request => controller.prompt({
      ...request,
      requestId: request.requestId as SessionRequestId,
      sessionId: sessionId(request.sessionId),
    }, signal()),
    list: async request => controller.list(request, signal()),
    inspect: async value => {
      const inspection = await controller.inspect(sessionId(value), signal())
      return { events: inspection.events.map(event => ({ event })) }
    },
    cancel: async request => controller.cancel({ sessionId: sessionId(request.sessionId) }),
  }
}

function requestId(): string {
  return `kanban-${crypto.randomUUID()}`
}

function isErrorTurnEnd(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const reason = (data as { reason?: unknown }).reason
  return typeof reason === 'object' && reason !== null && (reason as { kind?: unknown }).kind === 'error'
}

/** The design agent's plan file name (inside the per-project artifact dir). */
export const PLAN_FILE = 'plan.md'

/** The design agent's decomposition file name (inside the per-project artifact dir). */
export const DECOMPOSITION_FILE = 'tasks.json'

/**
 * The execution agent's task-additions request file name (inside the
 * per-project artifact dir). Same schema as tasks.json; consumed (renamed
 * to *.consumed.json) by the host when an execute turn settles.
 */
export const TASK_ADDITIONS_FILE = 'tasks-additions.json'

/**
 * The per-project artifact directory: every artifact a project produces
 * lives under <workspaceDir>/.kanban/projects/<projectId>/, so projects
 * sharing one workspaceDir never overwrite or delete each other's files.
 * This is the single place artifact paths are derived from.
 */
export function projectDir(project: Project): string {
  return join(project.workspaceDir, '.kanban', 'projects', project.id)
}

/** The plan file the design agent writes for this project. */
export function planPathFor(project: Project): string {
  return join(projectDir(project), PLAN_FILE)
}

/** The decomposition file the design agent writes for this project. */
export function decompositionPathFor(project: Project): string {
  return join(projectDir(project), DECOMPOSITION_FILE)
}

/** The task-additions request file an execution agent may write mid-run. */
export function taskAdditionsPathFor(project: Project): string {
  return join(projectDir(project), TASK_ADDITIONS_FILE)
}

/** The directory holding this project's task-leaf artifacts. */
export function projectArtifactsDir(project: Project): string {
  return join(projectDir(project), 'artifacts')
}

/**
 * The plan path a prompt should point at: a persisted planPath (e.g. a
 * legacy project whose plan still sits at the workspace root) wins;
 * otherwise the per-project artifact dir.
 */
function planPathHint(project: Project): string {
  return project.planPath ?? planPathFor(project)
}

/** The design agent's task prompt: produce the plan (and optionally the decomposition), then stop. */
export function designPrompt(project: Project): string {
  return [
    '你是 dsh-kanban 的设计 agent。请为以下项目目标产出一份可执行的方案。',
    '',
    `项目：${project.title}`,
    `工作目录：${project.workspaceDir}`,
    `目标：${project.goal}`,
    '',
    '要求：',
    `1. 把方案写入 ${planPathFor(project)}（Markdown）。`,
    '2. 方案必须包含：目标拆解、执行步骤、验收标准。',
    '3. 判断任务本身是否已经具体到可直接执行。如果不可直接执行，额外把拆解清单写入',
    `   ${decompositionPathFor(project)}，格式如下：`,
    '   { "decomposed": true, "tasks": [',
    '     { "title": "子任务标题", "kind": "clarify", "question": "需要创建人明确的问题" },',
    '     { "title": "子任务标题", "kind": "research" },',
    '     { "title": "子任务标题", "kind": "design", "subtasks": [ ... ] },',
    '     { "title": "子任务标题", "kind": "execute" }',
    '   ] }',
    '   kind 取值：clarify=需与创建人明确目标/输入（必须带 question）；research=需提前调研；',
    '   design=复杂设计的一部分（可嵌套 subtasks 继续拆解）；execute=任务的具体执行。',
    '   拆解可以嵌套任意深度，只有最底层（没有 subtasks）的任务会被执行。',
    '   子任务之间有先后依赖时，用 dependsOn 声明（值为同项目其他子任务的标题，嵌套子任务用',
    '   "父标题 > 子标题" 的完整路径）：如编码实现依赖架构设计、测试验证依赖编码实现时：',
    '     { "title": "编码实现", "kind": "execute", "dependsOn": ["架构设计"] },',
    '     { "title": "测试验证", "kind": "execute", "dependsOn": ["编码实现"] }',
    '   有依赖关系的子任务必须在依赖完成后才能开始，请务必声明清楚。',
    '4. 如果任务可直接执行，不要写 tasks.json。',
    '5. 全部完成后结束你的回合，不要继续做其他事。',
  ].join('\n')
}

/** The parent long-running project's identity, injected into execute prompts. */
export interface ParentProjectContext {
  title: string
  goal: string
}

/** The one-line affiliation context appended to execute prompts. */
function parentContextLine(parent: ParentProjectContext | undefined): string[] {
  return parent === undefined ? [] : [`本项目隶属于长期项目：${parent.title} — ${parent.goal}`]
}

/**
 * The mid-execution split instructions appended to execute prompts (both
 * project-level and leaf-level): the agent may request new task leaves by
 * writing the task-additions file; the host materializes and schedules
 * them after the turn ends.
 */
function taskAdditionsLines(project: Project): string[] {
  return [
    '',
    '如果在执行过程中发现方案未覆盖、且必须新增的独立工作项：',
    `1. 把它们写入 ${taskAdditionsPathFor(project)}，格式与 tasks.json 完全相同`,
    '   （decomposed/tasks/title/kind/dependsOn），dependsOn 可引用本项目任何已有子任务的标题路径；',
    '2. 只拆分超出当前任务范围的新工作，不要重复拆分你正在执行的任务本身；',
    '3. 写完后继续完成你职责范围内的剩余工作，然后结束回合；',
    '   宿主会在回合结束后把新增任务物化到看板并按依赖自动调度。',
  ]
}

/** The execution agent's task prompt: read the confirmed plan and execute it. */
export function executePrompt(project: Project, parent?: ParentProjectContext): string {
  return [
    '你是 dsh-kanban 的执行 agent。方案已经人工确认，请执行。',
    '',
    `项目：${project.title}`,
    `工作目录：${project.workspaceDir}`,
    `方案文件：${planPathHint(project)}`,
    ...parentContextLine(parent),
    '',
    '要求：按照方案逐步执行，全部完成后结束你的回合。',
    ...taskAdditionsLines(project),
  ].join('\n')
}

/** The design-resume prompt: apply the human's feedback, then stop. */
export function resumePrompt(project: Project): string {
  return [
    '设计需要修改。人工反馈如下：',
    '',
    project.feedback ?? '（无具体反馈，请自行检查方案质量后改进）',
    '',
    `请修改 ${planPathHint(project)} 后结束你的回合。`,
  ].join('\n')
}

/** The execution-resume prompt: the host restarted mid-run, continue in this session. */
export function executeResumePrompt(project: Project): string {
  return [
    '你是 dsh-kanban 的执行 agent。宿主已重启，你的任务尚未完成，请继续。',
    '',
    `项目：${project.title}`,
    `工作目录：${project.workspaceDir}`,
    `方案文件：${planPathHint(project)}`,
    '',
    '请检查当前进度，继续按方案执行，全部完成后结束你的回合。',
  ].join('\n')
}

/** The artifact file of a research/design leaf. */
export function taskArtifactPath(project: Project, taskId: string): string {
  return join(projectArtifactsDir(project), `${taskId}.md`)
}

/** The research leaf prompt: investigate the question, write the report, stop. */
export function researchTaskPrompt(task: TaskNode, project: Project): string {
  return [
    '你是 dsh-kanban 的调研 agent。请针对以下调研子任务做前期调研。',
    '',
    `子任务：${task.titlePath}`,
    `所属项目：${project.title}（目标：${project.goal}）`,
    `项目方案：${planPathHint(project)}`,
    '',
    `要求：把调研结论写入 ${taskArtifactPath(project, task.id)}（Markdown），写完结束你的回合。`,
  ].join('\n')
}

/** The design-part leaf prompt: produce this part of the design, stop. */
export function designTaskPrompt(task: TaskNode, project: Project): string {
  return [
    '你是 dsh-kanban 的设计 agent。请完成以下设计子任务（它是项目复杂设计的一部分）。',
    '',
    `子任务：${task.titlePath}`,
    `所属项目：${project.title}（目标：${project.goal}）`,
    `项目方案：${planPathHint(project)}`,
    '',
    `要求：把该部分设计写入 ${taskArtifactPath(project, task.id)}（Markdown），写完结束你的回合。`,
  ].join('\n')
}

/** The execute leaf prompt: run this leaf with the plan and clarification context. */
export function executeTaskPrompt(
  task: TaskNode,
  project: Project,
  clarifications: ReadonlyArray<{ question: string; answer: string }>,
  parent?: ParentProjectContext,
): string {
  const lines = [
    '你是 dsh-kanban 的执行 agent。请执行以下子任务。',
    '',
    `子任务：${task.titlePath}`,
    `所属项目：${project.title}`,
    `工作目录：${project.workspaceDir}`,
    `项目方案：${planPathHint(project)}`,
    ...parentContextLine(parent),
  ]
  if (clarifications.length > 0) {
    lines.push('', '已确认的目标澄清记录：')
    for (const item of clarifications) lines.push(`- 问：${item.question}；答：${item.answer}`)
  }
  lines.push('', '要求：按方案执行该子任务，全部完成后结束你的回合。', ...taskAdditionsLines(project))
  return lines.join('\n')
}

export class KanbanSessionRunner {
  constructor(private readonly api: KanbanApi) {}

  /** Create + rename + prompt a fresh design session; returns the session id. */
  async launchDesign(project: Project): Promise<string> {
    this.clearStaleArtifacts(project)
    return this.launch(project, designPrompt(project), `${project.title}·设计`)
  }

  /**
   * A fresh design round must start from a clean directory: a leftover
   * plan.md/tasks.json from a previous round of THIS project would either
   * be reused by the agent ("the plan already exists") or materialized as a
   * stale decomposition on confirm. Only this project's own artifact
   * directory is cleared — other projects sharing the workspaceDir keep
   * their in-flight files. Resume rounds (rejections) never clear.
   */
  private clearStaleArtifacts(project: Project): void {
    rmSync(projectDir(project), { recursive: true, force: true })
  }

  /** Create + rename + prompt a fresh execution session; returns the session id. */
  async launchExecute(project: Project, parent?: ParentProjectContext): Promise<string> {
    return this.launch(project, executePrompt(project, parent), `${project.title}·执行`)
  }

  /** Create + rename + prompt a research leaf session; returns the session id. */
  async launchResearch(task: TaskNode, project: Project): Promise<string> {
    return this.launch(project, researchTaskPrompt(task, project), `${task.titlePath.split(' > ').at(-1)}·调研`)
  }

  /** Create + rename + prompt a design-part leaf session; returns the session id. */
  async launchDesignTask(task: TaskNode, project: Project): Promise<string> {
    return this.launch(project, designTaskPrompt(task, project), `${task.titlePath.split(' > ').at(-1)}·设计`)
  }

  /** Create + rename + prompt an execute leaf session; returns the session id. */
  async launchExecuteTask(
    task: TaskNode,
    project: Project,
    clarifications: ReadonlyArray<{ question: string; answer: string }>,
    parent?: ParentProjectContext,
  ): Promise<string> {
    return this.launch(project, executeTaskPrompt(task, project, clarifications, parent), `${task.titlePath.split(' > ').at(-1)}·执行`)
  }

  /** Prompt the project's existing design session with the rejection feedback. */
  async resumeDesign(project: Project): Promise<string> {
    return this.resume(project, resumePrompt(project))
  }

  /** Prompt the project's existing execution session to continue after a host restart. */
  async resumeExecute(project: Project): Promise<string> {
    return this.resume(project, executeResumePrompt(project))
  }

  /** Prompt the project's attached session with the given text; returns the session id. */
  private async resume(project: Project, text: string): Promise<string> {
    if (project.sessionId === undefined) throw new Error('resume requested but no session is attached')
    return this.resumeTaskSession(project.sessionId, text)
  }

  /** Prompt an already-attached session (project or task leaf) with the given text. */
  async resumeTaskSession(sessionId: string, text: string): Promise<string> {
    try {
      await this.api.prompt({
        requestId: requestId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  /** Whether the plan file exists on disk (the design turn's required artifact). */
  planExists(project: Project): boolean {
    // A persisted planPath (legacy root-level plan) wins for resume compat;
    // fresh projects check their own per-project artifact path.
    return existsSync(planPathHint(project))
  }

  /** Create + rename + prompt one fresh session; returns the session id. */
  private async launch(project: Project, promptText: string, title: string): Promise<string> {
    // The user may point a project at a directory that does not exist yet;
    // the design agent needs both it and the per-project artifact directory
    // before it can write plan.md.
    mkdirSync(project.workspaceDir, { recursive: true })
    mkdirSync(projectDir(project), { recursive: true })
    const created = await this.api.create({ cwd: project.workspaceDir })
    const sessionId = created.sessionId
    try {
      await this.api.rename({ sessionId, title })
      await this.api.prompt({
        requestId: requestId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptText }],
      })
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  /**
   * Best-effort cancel of a session's active turn. Every failure is
   * swallowed: the session may already have ended (or never existed on this
   * host), and a kanban terminate/delete must never be blocked by the RPC.
   */
  async cancelSession(sessionId: string): Promise<void> {
    try {
      await this.api.cancel({ sessionId })
    } catch {
      // Best-effort semantics: the board state change commits regardless.
    }
  }

  /** Count of running sessions (one sessions.list RPC per poll tick). */
  async listRunning(): Promise<{ known: true; count: number; items: KanbanSessionSummary[] } | { known: false }> {
    try {
      const response = await this.api.list({})
      const items = [...response.items]
      return { known: true, count: items.filter(item => item.running).length, items }
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
      try {
        items = (await this.api.list({})).items
      } catch {
        return { outcome: 'pending' }
      }
    }
    const summary = items.find(item => item.sessionId === sessionId)
    if (summary === undefined) return { outcome: 'cancelled', error: 'execution session no longer exists' }
    if (summary.running) return { outcome: 'pending' }
    const events = [...(await this.api.inspect(summary.sessionId)).events]
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
