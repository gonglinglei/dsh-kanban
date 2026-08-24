/**
 * Wire protocol between the kanban browser half and the host half:
 * statuses, actions, the action envelope, and the snapshot/event payloads.
 * Mirrors the dsh-web-ui task-board protocol pattern (Apache-2.0).
 */

/** HTTP prefix of every kanban host route. */
export const KANBAN_API_PREFIX = '/kanban'

/** One node's board status. The state machine is shared by projects and task leaves. */
export type ProjectStatus =
  | 'backlog'
  | 'designing'
  | 'awaiting-clarification'
  | 'awaiting-review'
  | 'executing'
  | 'done'
  | 'blocked'

/** Who triggered a transition; the state machine enforces per-actor edges. */
export type Actor = 'human' | 'agent' | 'system'

/** Append-only operation-log entry: who moved the project, from where to where. */
export interface HistoryEntry {
  /** Epoch millis of the transition. */
  at: number
  actor: Actor
  from: ProjectStatus
  to: ProjectStatus
  note?: string
}

/** One project card. */
export interface Project {
  id: string
  title: string
  /** Absolute working directory the agents execute in. */
  workspaceDir: string
  /** One-line goal entered at creation. */
  goal: string
  status: ProjectStatus
  /** Per-project mutation counter (optimistic-concurrency evidence). */
  version: number
  createdAt: number
  updatedAt: number
  /** Last activity timestamp; the stale timer compares against it. */
  lastActivityAt: number
  /** Design output (markdown), written by the design agent; absent until design reports. */
  planPath?: string
  /** The current/last agent session driving this project. */
  sessionId?: string
  sessionRole?: 'design' | 'execute'
  /** Feedback from the latest human rejection. */
  feedback?: string
  /** Append-only transition log. */
  history: HistoryEntry[]
}

/** What a decomposed task leaf is about: clarify with the creator, research first, produce one design part, or execute. */
export type TaskKind = 'clarify' | 'research' | 'design' | 'execute'

/** One decomposed task leaf (the decomposition tree is flattened into leaves; inner nodes only contribute title paths). */
export interface TaskNode {
  id: string
  projectId: string
  /** Leaf title chain from the project root, e.g. "登录页 → 前端 → 表单校验". */
  titlePath: string
  kind: TaskKind
  status: ProjectStatus
  /** The clarifying question (clarify leaves). */
  question?: string
  /** The creator's answer (clarify leaves); awaiting-review until confirmed. */
  answer?: string
  /** Research/design artifact file (markdown). */
  artifactPath?: string
  /** The current/last agent session driving this leaf. */
  sessionId?: string
  sessionRole?: 'research' | 'design' | 'execute'
  version: number
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  /** Append-only transition log. */
  history: HistoryEntry[]
}

/** Full board state served by /state and pushed over /events. */
export interface KanbanSnapshot {
  revision: number
  projects: Project[]
  tasks: TaskNode[]
}

/** Human-triggerable actions (the HTTP /action surface). */
export type KanbanAction =
  | { kind: 'create-project'; title: string; workspaceDir: string; goal: string }
  | { kind: 'confirm-plan'; projectId: string }
  | { kind: 'reject-plan'; projectId: string; feedback: string }
  | { kind: 'transition'; projectId: string; to: ProjectStatus; note?: string }
  | { kind: 'delete-project'; projectId: string }
  | { kind: 'answer-clarification'; projectId: string; taskId: string; answer: string }
  | { kind: 'confirm-task'; projectId: string; taskId: string }

/** One POST /action body. */
export interface KanbanActionEnvelope {
  requestId: string
  action: KanbanAction
}

/** SSE /events frame payload (full snapshot; the browser refetches on visibility anyway). */
export type KanbanEventPayload = KanbanSnapshot

/** Parse a JSON body into an action envelope, or undefined when malformed. */
export function parseActionEnvelope(body: string): KanbanActionEnvelope | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const envelope = parsed as Partial<KanbanActionEnvelope>
  if (typeof envelope.requestId !== 'string' || envelope.requestId === '') return undefined
  const action = envelope.action
  if (typeof action !== 'object' || action === null) return undefined
  const kind = (action as { kind?: unknown }).kind
  switch (kind) {
    case 'create-project': {
      const a = action as { title?: unknown; workspaceDir?: unknown; goal?: unknown }
      if (typeof a.title !== 'string' || a.title.trim() === '') return undefined
      if (typeof a.workspaceDir !== 'string' || a.workspaceDir.trim() === '') return undefined
      if (typeof a.goal !== 'string' || a.goal.trim() === '') return undefined
      return { requestId: envelope.requestId, action: { kind, title: a.title, workspaceDir: a.workspaceDir, goal: a.goal } }
    }
    case 'confirm-plan': {
      const a = action as { projectId?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      return { requestId: envelope.requestId, action: { kind, projectId: a.projectId } }
    }
    case 'reject-plan': {
      const a = action as { projectId?: unknown; feedback?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (typeof a.feedback !== 'string') return undefined
      return { requestId: envelope.requestId, action: { kind, projectId: a.projectId, feedback: a.feedback } }
    }
    case 'transition': {
      const a = action as { projectId?: unknown; to?: unknown; note?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (typeof a.to !== 'string') return undefined
      if (a.note !== undefined && typeof a.note !== 'string') return undefined
      const to = a.to as ProjectStatus
      if (!PROJECT_STATUSES.includes(to)) return undefined
      return { requestId: envelope.requestId, action: { kind, projectId: a.projectId, to, note: a.note } }
    }
    case 'delete-project': {
      const a = action as { projectId?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      return { requestId: envelope.requestId, action: { kind, projectId: a.projectId } }
    }
    case 'answer-clarification': {
      const a = action as { projectId?: unknown; taskId?: unknown; answer?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (typeof a.taskId !== 'string' || a.taskId === '') return undefined
      if (typeof a.answer !== 'string' || a.answer.trim() === '') return undefined
      return { requestId: envelope.requestId, action: { kind, projectId: a.projectId, taskId: a.taskId, answer: a.answer } }
    }
    case 'confirm-task': {
      const a = action as { projectId?: unknown; taskId?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (typeof a.taskId !== 'string' || a.taskId === '') return undefined
      return { requestId: envelope.requestId, action: { kind, projectId: a.projectId, taskId: a.taskId } }
    }
    default:
      return undefined
  }
}

/** Closed status list (switch points fall through to assertNever). */
export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'backlog', 'designing', 'awaiting-clarification', 'awaiting-review', 'executing', 'done', 'blocked',
]
