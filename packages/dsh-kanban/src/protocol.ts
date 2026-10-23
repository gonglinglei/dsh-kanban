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

/** Project lifecycle: the classic one-shot relay, or a long-running board container. */
export type ProjectLifecycle = 'one-shot' | 'long-running'

/**
 * Which path wrote a node into `blocked` — the machine-readable counterpart
 * of the human-readable `HistoryEntry.note`. Kept as an open, additive union:
 * a new terminal path must add its cause here and emit a diagnostic.
 */
export type FailureCause =
  /** poll settle: the session's turn/end gave a non-recoverable terminal verdict. */
  | 'turn-end'
  /** the session vanished from the session list (inspect returned cancelled). */
  | 'session-missing'
  /** create/rename/prompt RPC failed (SessionLaunchError). */
  | 'launch'
  /** a research/design turn ended but the required artifact file does not exist. */
  | 'artifact-missing'
  /** applyTaskAdditions threw (the agent's tasks-additions.json is malformed). */
  | 'task-additions'
  /** the stale timer fired (disabled by default: maxStaleMinutes = 0). */
  | 'stale'
  /** a human terminated the leaf. */
  | 'human'
  /** a recovery re-verdict came back failed. */
  | 'recovery'

/**
 * The structured failure a blocked node carries, so a card can explain WHY
 * without grepping the session log. Additive and optional: old ledgers and
 * old clients simply do not have it.
 */
export interface FailureDiagnostic {
  /** Epoch millis the diagnostic was written (not the turn/end's own time). */
  at: number
  cause: FailureCause
  /** Human-readable summary (already scrubbed/bounded by the producer). */
  message: string
  /** The turn/end reason.kind, verbatim (when cause === 'turn-end' | 'recovery'). */
  reason?: string
  /** The abort cause when reason === 'aborted' (user/parent/hook/disposed/legacy). */
  cancelCause?: string
  /** The LlmFailure code (e.g. 'AUTH', 'QUOTA') when the turn/end was an error. */
  code?: string
  /** The LlmFailure status (e.g. 403) when the turn/end was an error. */
  status?: number
  /** The turn number the verdict was read from. */
  turn?: number
  /** The event seq the verdict was read from. */
  seq?: number
  /** The session the failure was observed in (audit trail). */
  sessionId?: string
  /**
   * Advisory only: whether the failure looks recoverable. Used for the UI
   * hint, NEVER to gate the recovery entry (a wrong score must never close
   * the only door out of `blocked`).
   */
  recoverable: boolean
}

/** The two strategies a human recovery request can ask for. */
export type RecoveryStrategy =
  /** re-read the attached session's log and let the system re-decide (never prompts). */
  | 'reinspect'
  /** abandon the old session and let the leaf spawn/run fresh. */
  | 'requeue'

/**
 * An in-flight human recovery request. Written by recoverTask, cleared by
 * taskCommit as soon as the node leaves an active status — its presence both
 * documents the intent (audit) and gates the host-restart resume hook (a
 * recovered leaf must be re-judged, never blindly re-prompted).
 */
export interface RecoveryRequest {
  at: number
  strategy: RecoveryStrategy
  /** The session under re-inspection (audit evidence); absent for requeue. */
  sessionId?: string
}

/** Window unit of `archiveAfterDays`; the ledger's only time dialect is epoch millis. */
export const MS_PER_DAY = 86_400_000

/** Upper bound of `archiveNote` (it is rendered in the archive list and may enter the wire). */
export const ARCHIVE_NOTE_MAX = 200

/**
 * Archive marker, shared by projects and task leaves. Three optional scalars,
 * so the ledger `format` stays 1 and an old host simply ignores them (a new
 * host reading an old ledger needs no migration either).
 *
 * Archive is a VIEW state, never a state-machine state: an archived record
 * keeps `status === 'done'` and stays in the ledger. Only `delete` removes a
 * record.
 */
export interface ArchiveMarker {
  /** Epoch millis the archive was written; undefined = not archived. */
  archivedAt?: number
  /** Who archived it: the periodic sweep writes 'system', a board button 'human'. */
  archivedBy?: Actor
  /** Why it was archived (the same text as this change's history note). */
  archiveNote?: string
}

/** One project card. */
export interface Project extends ArchiveMarker {
  id: string
  title: string
  /** Absolute working directory the agents execute in. */
  workspaceDir: string
  /** One-line goal entered at creation. */
  goal: string
  status: ProjectStatus
  /**
   * Lifecycle form; absent means 'one-shot' (pre-feature ledgers need no
   * migration). A 'long-running' project enters executing on creation, never
   * spawns agent sessions, and never auto-completes — only a human moves it.
   */
  lifecycle?: ProjectLifecycle
  /**
   * The long-running project this one-shot project belongs to (board
   * affiliation only). Only one-shot projects may set it; never nested.
   */
  parentId?: string
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
  /** The last failure diagnostic (kept after a successful recovery as audit). */
  lastFailure?: FailureDiagnostic
  /** Append-only transition log. */
  history: HistoryEntry[]
}

/** What a decomposed task leaf is about: clarify with the creator, research first, produce one design part, or execute. */
export type TaskKind = 'clarify' | 'research' | 'design' | 'execute'

/** One decomposed task leaf (the decomposition tree is flattened into leaves; inner nodes only contribute title paths). */
export interface TaskNode extends ArchiveMarker {
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
  /** Ids of sibling leaves that must be done before this leaf spawns. */
  dependencies: string[]
  /** The last failure diagnostic; rendered only while status === 'blocked'. */
  lastFailure?: FailureDiagnostic
  /** An in-flight human recovery request (see RecoveryRequest). */
  recovery?: RecoveryRequest
  version: number
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  /** Append-only transition log. */
  history: HistoryEntry[]
}

/**
 * Whether a record carries its own archive marker (no context needed).
 * The single visibility vocabulary of the archive feature lives in the three
 * helpers below: a column, a detail view or a graph must reuse them instead of
 * writing a second filter that can drift.
 */
export function isArchived(node: ArchiveMarker): boolean {
  return node.archivedAt !== undefined
}

/** Collect the ids of the archived projects (leaf visibility needs this set). */
export function archivedProjectIds(projects: readonly Project[]): Set<string> {
  const ids = new Set<string>()
  for (const project of projects) if (project.archivedAt !== undefined) ids.add(project.id)
  return ids
}

/**
 * Effective visibility of a leaf: its own marker OR its project's marker hides
 * it. Consequence (kept as an invariant, not a convention): a VISIBLE leaf
 * always has a VISIBLE project, so the client's `projects.find(...)` back-lookup
 * can never degrade to an empty title.
 */
export function isLeafHidden(task: TaskNode, archivedProjects: ReadonlySet<string>): boolean {
  return task.archivedAt !== undefined || archivedProjects.has(task.projectId)
}

/** Capability token: the host understands lifecycle: 'long-running' on create-project. */
export const CAPABILITY_LONG_RUNNING_PROJECTS = 'long-running-projects'

/**
 * Capability token: an affiliated one-shot project (parentId set) may omit
 * workspaceDir on create-project — the host inherits the parent's directory
 * and ignores any caller-supplied value.
 */
export const CAPABILITY_PARENT_WORKSPACE_INHERITANCE = 'parent-workspace-inheritance'

/** Capability token: the host understands the task-level terminate-task / delete-task actions. */
export const CAPABILITY_TASK_TERMINATE_DELETE = 'task-terminate-delete'

/**
 * Capability token: the host understands the task-level recover-task action
 * (re-judge a mis-blocked leaf from its session log, or requeue it). Appended
 * last so pre-existing capability orderings never shift.
 */
export const CAPABILITY_TASK_RECOVERY = 'task-recovery'

/**
 * Capability token: the host understands the project-level
 * `materialize-additions` action and emits the snapshot's `pendingAdditions`
 * assembly field. Appended last so pre-existing capability orderings never
 * shift (an old client's `includes()` checks are position-independent).
 */
export const CAPABILITY_LATE_TASK_ADDITIONS = 'late-task-additions'

/**
 * Capability token: the host understands the project-level
 * `discard-additions` action (a human throws a pending request away instead of
 * materializing it) and reports per-file parse failures for the requests it
 * CAN still materialize (`PendingAddition.malformed`). Appended last so
 * pre-existing capability orderings never shift.
 */
export const CAPABILITY_ADDITIONS_DISCARD = 'additions-discard'

/**
 * Capability token: the host understands the archive surface — the four
 * archive/unarchive actions, the snapshot's `archivedCounts` aggregate, and
 * the on-demand `GET /kanban/archive` detail read. Appended last so
 * pre-existing capability orderings never shift (an old client's `includes()`
 * checks are position-independent).
 *
 * One token gates both the project-level and the leaf-level entries because
 * both share a single eligibility judgement and one set of invariants
 * (only `done`, never a long-running container, never a project with
 * unfinished leaves, never a project with a materializable additions
 * request); splitting it would only create a second, partial-open semantics.
 */
export const CAPABILITY_TASK_ARCHIVE = 'task-archive'

/** Protocol capabilities the current host build supports (assembled per snapshot, never persisted). */
export const HOST_CAPABILITIES: readonly string[] = [
  CAPABILITY_LONG_RUNNING_PROJECTS,
  CAPABILITY_PARENT_WORKSPACE_INHERITANCE,
  CAPABILITY_TASK_TERMINATE_DELETE,
  CAPABILITY_TASK_RECOVERY,
  CAPABILITY_LATE_TASK_ADDITIONS,
  CAPABILITY_ADDITIONS_DISCARD,
  CAPABILITY_TASK_ARCHIVE,
]

/** Upper bound on the per-request leaf preview carried by a snapshot (hot SSE data). */
export const PENDING_ITEMS_MAX = 20

/** Upper bound on the per-request parse-failure list carried by a snapshot. */
export const PENDING_PROBLEMS_MAX = 5

/** One requested-but-not-yet-materialized task leaf of a pending additions request (bounded preview). */
export interface PendingAdditionItem {
  /** The leaf's title chain exactly as the agent wrote it (whitespace-collapsed + length-bounded). */
  titlePath: string
  kind: TaskKind
}

/**
 * One request file that exists on disk but cannot be parsed. It is deliberately
 * NOT shadowed by, and does not shadow, the materializable requests: the board
 * must be able to say "2 requests, one of which is broken" so a human neither
 * loses the healthy request nor believes the broken one is fine.
 */
export interface PendingAdditionProblem {
  /** Request file basename only (never an absolute path). */
  file: string
  /** The broken file's mtime (epoch millis). */
  at: number
  /** Bounded parse/read failure message (<= 200 chars). */
  error: string
}

/**
 * A task-additions request that exists on disk but has NOT been materialized.
 * Assembled per snapshot from the spawner's probe cache — never persisted to
 * the ledger (the same contract as `capabilities`).
 *
 * `state: 'malformed'` is a first-class outcome, not a failure to report: a
 * node that already left the observation window (done / blocked) has no code
 * path that would ever throw, so a parse failure must be visible HERE or it
 * is invisible everywhere. It means "nothing here can be materialized"; a
 * MIXED state (some batches parse, some do not) stays `ready` and lists the
 * broken files in `malformed`.
 */
export interface PendingAddition {
  projectId: string
  /** Request file basename only — the snapshot is a board view, not a filesystem map. */
  file: string
  /** mtime of the oldest aggregated request file (epoch millis): "pending since". */
  at: number
  state: 'ready' | 'malformed'
  /** How many request files this entry aggregates (>= 1, broken ones included). */
  batches: number
  /** Total leaves every parseable aggregated request will materialize (0 when malformed). */
  count: number
  /** Bounded preview, at most PENDING_ITEMS_MAX entries; absent when malformed. */
  items?: PendingAdditionItem[]
  /** Bounded list of the aggregated files that cannot be parsed (at most PENDING_PROBLEMS_MAX). */
  malformed?: PendingAdditionProblem[]
  /** Bounded parse/read failure message of the primary file (<= 200 chars); present only when malformed. */
  error?: string
}

/** Full board state served by /state and pushed over /events. */
export interface KanbanSnapshot {
  revision: number
  projects: Project[]
  tasks: TaskNode[]
  /**
   * Host→client capability handshake: the host lists the protocol features
   * it actually implements so a newer client never offers UI the running
   * host would silently drop. Absent means a pre-handshake host, which
   * supports nothing beyond the one-shot relay.
   */
  capabilities?: string[]
  /**
   * Requests on disk awaiting materialization. Always present (possibly an
   * empty array) on a host that declares CAPABILITY_LATE_TASK_ADDITIONS;
   * absent on older hosts. A newer client renders the entry only when BOTH
   * the capability and a non-empty entry are present.
   */
  pendingAdditions?: PendingAddition[]
  /**
   * Archived-record aggregate (O(1): two numbers, never the records). Present
   * only on a host that declares CAPABILITY_TASK_ARCHIVE; absent means either a
   * pre-archive host or an empty archive, and the client must treat both the
   * same way (render no count). The sum `projects + tasks` equals the number of
   * entries served by GET /kanban/archive: leaves that merely hide together
   * with their archived project are counted in `projects` only, because they
   * carry no archive marker of their own and cannot be restored individually.
   */
  archivedCounts?: { projects: number; tasks: number }
}

/** Where an archived record points, once its history has been dropped. */
export interface ArchiveEntryBase {
  /** The record's own id (`Project.id` or `TaskNode.id`) — the restore action's key. */
  id: string
  /**
   * Display title. For a project entry this is `Project.title`; for a leaf it
   * equals `titlePath`, so a list can sort/search one field without branching
   * on `kind`.
   */
  title: string
  /** The owning project's id (equal to `id` for a project entry). */
  projectId: string
  /** Epoch millis the archive was written. */
  archivedAt: number
  /** Who archived it: 'system' for the periodic sweep, 'human' for a board button. */
  archivedBy?: Actor
  /** Why it was archived (e.g. 'auto: done for 7d' / 'manual'). */
  archiveNote?: string
}

/**
 * One archived record as served by GET /kanban/archive. A PROJECTION, not the
 * ledger record: `history` is deliberately dropped. History is ~50% of the
 * ledger by size and the archive view shows a title plus three timestamps; the
 * detail views that render a timeline keep reading live nodes from the snapshot.
 *
 * Because only new clients ever request this route, the shape needs no
 * backward-compatibility promise: fields may be appended freely.
 */
export type ArchiveEntry =
  | (ArchiveEntryBase & {
      kind: 'project'
      /** Resolved parent title, so the archive list can show「隶属于 X」without a second call. */
      parentTitle?: string
      /** Final status — always 'done' today (only done nodes may be archived); carried so no view hardcodes it. */
      status: ProjectStatus
      lifecycle?: ProjectLifecycle
      /** Number of (hidden) leaves that went with this project into the archive. */
      taskCount: number
    })
  | (ArchiveEntryBase & {
      kind: 'task'
      /** The leaf's title chain, exactly as the board renders it. */
      titlePath: string
      taskKind: TaskKind
      status: ProjectStatus
      /** The title of the still-visible project this leaf belongs to. */
      projectTitle: string
    })

/** Human-triggerable actions (the HTTP /action surface). */
export type KanbanAction =
  | {
      kind: 'create-project'
      title: string
      /**
       * Working directory the agents execute in. Optional only when parentId
       * is set: an affiliated one-shot project inherits its parent's directory
       * (see CAPABILITY_PARENT_WORKSPACE_INHERITANCE); the host ignores a
       * caller-supplied value in that case.
       */
      workspaceDir?: string
      goal: string
      /** 'long-running' creates a long-running project; absent means one-shot. */
      lifecycle?: 'long-running'
      /** Optional affiliation to an existing long-running project (one-shot only). */
      parentId?: string
    }
  | { kind: 'confirm-plan'; projectId: string }
  | { kind: 'reject-plan'; projectId: string; feedback: string }
  | { kind: 'transition'; projectId: string; to: ProjectStatus; note?: string }
  | { kind: 'delete-project'; projectId: string }
  | { kind: 'answer-clarification'; projectId: string; taskId: string; answer: string }
  | { kind: 'confirm-task'; projectId: string; taskId: string }
  /** Human soft-stop: cancel the leaf's session and park the leaf in blocked (audit trail kept). */
  | { kind: 'terminate-task'; projectId: string; taskId: string; note?: string }
  /** Human hard-remove: cancel the session, drop the leaf, release dependencies, clean artifacts. */
  | { kind: 'delete-task'; projectId: string; taskId: string }
  /**
   * Human recovery of a blocked leaf: re-open it and let the spawner re-judge
   * it from the session log ('reinspect', default when a session is attached)
   * or requeue it as a fresh run ('requeue'). It never re-prompts an attached
   * session and never writes a verdict itself — the poll's re-inspection does.
   */
  | { kind: 'recover-task'; projectId: string; taskId: string; strategy?: RecoveryStrategy; note?: string }
  /**
   * Human entry: materialize a project's pending task-additions request(s)
   * NOW. The requests were written by an execution agent at any moment —
   * including after its leaf was already settled — and the host only ever
   * consumes them at settle time, so this action is the door for everything
   * written afterwards. It re-opens a done/blocked project (human any→any
   * edge) and the new execute leaves start running immediately.
   */
  | { kind: 'materialize-additions'; projectId: string; note?: string }
  /**
   * Human entry: throw a project's pending task-additions request(s) away
   * instead of materializing them. Every actionable batch (including a broken
   * one that the host deliberately leaves in place for diagnosis) is renamed to
   * `tasks-additions.<mtime>.discarded.json` and ONE audit note is written on
   * the project. It touches NO leaf, NO session and NO project status: a
   * `done` project stays `done` — discarding a request must never re-open it.
   */
  | { kind: 'discard-additions'; projectId: string; note?: string }
  /**
   * Human entry: archive one finished project (a one-shot project, or an
   * affiliated project of a long-running container, whose status is `done`).
   * Archiving is a ledger metadata commit — it never touches a session, a file
   * or a status, and it does not mark the project's leaves: they hide with the
   * project and come back with it.
   */
  | { kind: 'archive-project'; projectId: string; note?: string }
  /**
   * Human entry: the exact inverse of archive-project — clears the three
   * archive fields and appends one audit entry. Status, the rest of the history
   * and every session reference stay untouched.
   */
  | { kind: 'unarchive-project'; projectId: string; note?: string }
  /**
   * Human entry: archive one finished leaf of a still-visible project. This is
   * the only way to reclaim the `done` leaves an ACTIVE project accumulates (a
   * project with any unfinished leaf is never archived as a whole).
   */
  | { kind: 'archive-task'; projectId: string; taskId: string; note?: string }
  /** Human entry: the exact inverse of archive-task. */
  | { kind: 'unarchive-task'; projectId: string; taskId: string; note?: string }

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
      const a = action as { title?: unknown; workspaceDir?: unknown; goal?: unknown; lifecycle?: unknown; parentId?: unknown }
      if (typeof a.title !== 'string' || a.title.trim() === '') return undefined
      if (a.parentId !== undefined && (typeof a.parentId !== 'string' || a.parentId === '')) return undefined
      // workspaceDir may be omitted only by an affiliated one-shot create:
      // the host inherits the parent's directory. A standalone create with a
      // missing/blank dir stays malformed (strictness towards old clients).
      const hasParent = typeof a.parentId === 'string' && a.parentId !== ''
      const workspaceDirMissing = typeof a.workspaceDir !== 'string' || a.workspaceDir.trim() === ''
      if (workspaceDirMissing && !hasParent) return undefined
      if (typeof a.goal !== 'string' || a.goal.trim() === '') return undefined
      if (a.lifecycle !== undefined && a.lifecycle !== 'long-running') return undefined
      const lifecycle = a.lifecycle as 'long-running' | undefined
      const parentId = a.parentId as string | undefined
      return {
        requestId: envelope.requestId,
        action: {
          kind,
          title: a.title,
          ...(workspaceDirMissing ? {} : { workspaceDir: a.workspaceDir as string }),
          goal: a.goal,
          ...(lifecycle === undefined ? {} : { lifecycle }),
          ...(parentId === undefined ? {} : { parentId }),
        },
      }
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
    case 'terminate-task': {
      const a = action as { projectId?: unknown; taskId?: unknown; note?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (typeof a.taskId !== 'string' || a.taskId === '') return undefined
      if (a.note !== undefined && typeof a.note !== 'string') return undefined
      return { requestId: envelope.requestId, action: { kind, projectId: a.projectId, taskId: a.taskId, ...(a.note === undefined ? {} : { note: a.note as string }) } }
    }
    case 'delete-task': {
      const a = action as { projectId?: unknown; taskId?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (typeof a.taskId !== 'string' || a.taskId === '') return undefined
      return { requestId: envelope.requestId, action: { kind, projectId: a.projectId, taskId: a.taskId } }
    }
    case 'recover-task': {
      const a = action as { projectId?: unknown; taskId?: unknown; strategy?: unknown; note?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (typeof a.taskId !== 'string' || a.taskId === '') return undefined
      if (a.strategy !== undefined && a.strategy !== 'reinspect' && a.strategy !== 'requeue') return undefined
      if (a.note !== undefined && typeof a.note !== 'string') return undefined
      return {
        requestId: envelope.requestId,
        action: {
          kind,
          projectId: a.projectId,
          taskId: a.taskId,
          ...(a.strategy === undefined ? {} : { strategy: a.strategy as RecoveryStrategy }),
          ...(a.note === undefined ? {} : { note: a.note }),
        },
      }
    }
    case 'materialize-additions': {
      const a = action as { projectId?: unknown; note?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (a.note !== undefined && typeof a.note !== 'string') return undefined
      return {
        requestId: envelope.requestId,
        action: { kind, projectId: a.projectId, ...(a.note === undefined ? {} : { note: a.note }) },
      }
    }
    case 'discard-additions': {
      const a = action as { projectId?: unknown; note?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (a.note !== undefined && typeof a.note !== 'string') return undefined
      return {
        requestId: envelope.requestId,
        action: { kind, projectId: a.projectId, ...(a.note === undefined ? {} : { note: a.note }) },
      }
    }
    // The archive actions deliberately mirror terminate-task / discard-additions:
    // ids must be non-empty strings, `note` is optional and only type-checked.
    // No length rule is added here — every other note-carrying action accepts
    // any string and the single upstream gate is ACTION_LIMIT in host-routes.
    case 'archive-project':
    case 'unarchive-project': {
      const a = action as { projectId?: unknown; note?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (a.note !== undefined && typeof a.note !== 'string') return undefined
      return {
        requestId: envelope.requestId,
        action: { kind, projectId: a.projectId, ...(a.note === undefined ? {} : { note: a.note }) },
      }
    }
    case 'archive-task':
    case 'unarchive-task': {
      const a = action as { projectId?: unknown; taskId?: unknown; note?: unknown }
      if (typeof a.projectId !== 'string' || a.projectId === '') return undefined
      if (typeof a.taskId !== 'string' || a.taskId === '') return undefined
      if (a.note !== undefined && typeof a.note !== 'string') return undefined
      return {
        requestId: envelope.requestId,
        action: { kind, projectId: a.projectId, taskId: a.taskId, ...(a.note === undefined ? {} : { note: a.note }) },
      }
    }
    default:
      return undefined
  }
}

/** Closed status list (switch points fall through to assertNever). */
export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'backlog', 'designing', 'awaiting-clarification', 'awaiting-review', 'executing', 'done', 'blocked',
]
