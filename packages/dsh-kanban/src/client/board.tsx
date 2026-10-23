/**
 * The kanban board view: six columns, project cards with phase actions
 * (confirm / reject with feedback / re-design / delete), a full-screen
 * project detail view switched inside the board container, a full-screen
 * task detail view (same switch pattern, stacked above the project detail
 * so the clarify Q&A and the task-level history stay reachable from every
 * status — including done), the new-project modal, and a live session-open
 * affordance. Reads the BoardStore through useSyncExternalStore; every
 * mutation goes through store.apply.
 */
import { useEffect, useSyncExternalStore, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ArchiveEntry, FailureDiagnostic, PendingAddition, PendingAdditionProblem, Project, ProjectStatus, TaskNode,
} from '../protocol.ts'
import {
  CAPABILITY_ADDITIONS_DISCARD, CAPABILITY_LATE_TASK_ADDITIONS, CAPABILITY_LONG_RUNNING_PROJECTS,
  CAPABILITY_PARENT_WORKSPACE_INHERITANCE, CAPABILITY_TASK_ARCHIVE, CAPABILITY_TASK_RECOVERY,
  CAPABILITY_TASK_TERMINATE_DELETE, archivedProjectIds,
} from '../protocol.ts'
import { DependencyGraph } from './dep-graph.tsx'
import { ACTOR_LABELS, KIND_LABELS, STATUS_LABELS } from './labels.ts'
import { rememberWorkspaceDir } from './last-workspace-dir.ts'
import type { BoardStore } from './store.ts'
import { closeBoard } from './view-state.ts'

const COLUMNS: ReadonlyArray<{ status: ProjectStatus; label: string }> = [
  { status: 'backlog', label: '待开始' },
  { status: 'designing', label: '设计中' },
  { status: 'awaiting-clarification', label: '待澄清' },
  { status: 'awaiting-review', label: '待确认' },
  { status: 'executing', label: '执行中' },
  { status: 'blocked', label: '阻塞' },
  { status: 'done', label: '已完成' },
]

/** Chinese labels for every board status, history actors, and task kinds
 * now live in labels.ts (shared with the dependency-graph view). */

/** Epoch millis → locale string (detail view timestamps). */
function formatTime(at: number): string {
  return new Date(at).toLocaleString()
}

/**
 * One-line failure summary for the card chip: the coded reason first, then the
 * turn/seq bracket when the diagnostic carries them. Built from parts so a
 * diagnostic that only has a message never renders stray separators (old
 * ledgers and non-turn/end causes legitimately omit code/status/turn/seq).
 */
function failureChipText(failure: FailureDiagnostic): string {
  const parts: string[] = []
  if (failure.code !== undefined) parts.push(`${failure.code}${failure.status !== undefined ? ` (HTTP ${failure.status})` : ''}`)
  parts.push(failure.message)
  if (failure.turn !== undefined || failure.seq !== undefined) {
    const bracket = [failure.turn !== undefined ? `turn ${failure.turn}` : undefined, failure.seq !== undefined ? `seq ${failure.seq}` : undefined]
      .filter((part): part is string => part !== undefined)
      .join(', ')
    parts.push(`[${bracket}]`)
  }
  return `⚠ ${parts.join(' · ')}`
}

/**
 * The card badge of a pending task-additions request. A malformed body is a
 * first-class state, not an absent one: when the leaf that wrote it was already
 * settled, the snapshot is the ONLY place that failure can surface.
 */
function pendingBadge(pending: PendingAddition): { text: string; title: string; malformed: boolean } {
  if (pending.state === 'malformed') {
    return { text: '⚠ 待处理的新增任务请求无法解析', title: pending.error ?? '请求文件格式错误', malformed: true }
  }
  return {
    text: `⏳ 待处理的新增任务请求（${pending.count} 项）${pending.batches > 1 ? `（${pending.batches} 个批次）` : ''}`,
    title: `来源 ${pending.file} · 写入于 ${formatTime(pending.at)}`,
    malformed: false,
  }
}

/**
 * The double-confirm text for materializing: it really does start one session
 * per execute leaf, really spends quota, and really re-opens a completed
 * project.
 */
function materializeConfirmText(project: Project, pending: PendingAddition): string {
  const executeCount = pending.items?.filter(item => item.kind === 'execute').length ?? 0
  const extra = executeCount > 0 ? `，并立即为其中 ${executeCount} 个执行叶子拉起会话（真实消耗额度、真实改动仓库）` : ''
  const reopen = project.status === 'done' || project.status === 'blocked'
    ? `（项目将从「${STATUS_LABELS[project.status]}」重新进入执行中）`
    : ''
  return `物化「${project.title}」的 ${pending.count} 项新增任务到看板${extra}${reopen}？`
}

/**
 * The double-confirm text for discarding. It is deliberately explicit about
 * what survives: the file is parked, not deleted — but the request will never
 * reach the board.
 */
function discardConfirmText(project: Project, pending: PendingAddition): string {
  const count = pending.state === 'malformed'
    ? `${pending.batches} 个请求文件`
    : `${pending.count} 项新增任务（${pending.batches} 个请求文件）`
  return `废弃「${project.title}」的 ${count}？文件会被重命名为 *.discarded.json 留在项目目录（可人工恢复），但不会再物化到看板。`
}

/**
 * The「废弃」entry: the only exit for a request that can never be
 * materialized. Capability-gated by the caller — an old host would 400
 * `discard-additions`.
 */
function discardButton(project: Project, pending: PendingAddition, onAction: (action: Parameters<BoardStore['apply']>[0]) => void): JSX.Element {
  return (
    <button
      className="dk-btn dk-btn-danger"
      onClick={() => {
        if (!globalThis.confirm(discardConfirmText(project, pending))) return
        onAction({ kind: 'discard-additions', projectId: project.id })
      }}
    >废弃该请求</button>
  )
}

/**
 * The parse failures of a request entry, as a readable chip list. A broken
 * batch must be visible next to the healthy ones it sits with: if the host
 * quarantines or the human discards nothing, this is the only place the
 * failure surfaces on the board.
 */
function malformedChips(problems: PendingAdditionProblem[]): JSX.Element {
  return (
    <p className="dk-card-pending-error" title={problems.map(problem => `${problem.file}：${problem.error}`).join('\n')}>
      ⚠ {problems.length} 个请求无法解析（{problems.map(problem => problem.file).join('、')}）
    </p>
  )
}

export interface BoardProps {
  store: BoardStore
  openSession(sessionId: string): void
  /** Live source of the new-project form's workspace-dir default (read when the modal opens). */
  getDefaultWorkspaceDir(): string
}

/**
 * Whether the「归档」entry may be OFFERED on a visible project. This mirrors
 * the host's judgement for the cases the snapshot can prove; it is not a
 * second implementation of the rule:
 *
 *  - `done` (I1) and not a `long-running` container (I2) are plain fields;
 *  - "no unfinished leaf" (I3) is decided against the VISIBLE leaves, and a
 *    hidden leaf is always `done`, so the visible set can only under-count
 *    unfinished work — never over-count it, which is the safe direction for a
 *    button that the host would refuse anyway;
 *  - I4 (a waiting `tasks-additions*` request) is deliberately NOT checked
 *    here because it is read from disk on the host and the published assembly
 *    field is a 5-second-old cache. Pressing the button then surfaces the
 *    host's own reason (a 400 rendered as `error`), which is better than a
 *    button that silently disappears and reappears.
 */
function canArchiveProject(project: Project, tasks: readonly TaskNode[]): boolean {
  if (project.status !== 'done') return false
  if (project.lifecycle === 'long-running') return false
  return !tasks.some(task => task.projectId === project.id && task.status !== 'done')
}

/**
 * The same question for a leaf, with the one extra rule the host enforces
 * (I3's mirror): a leaf of a project that is itself `done` or already archived
 * is hidden WITH that project, so offering it a separate archive would create
 * a marker the user could never see.
 */
function canArchiveLeaf(task: TaskNode, project: Project, archivedProjects: ReadonlySet<string>): boolean {
  if (task.status !== 'done') return false
  if (task.archivedAt !== undefined) return false
  if (archivedProjects.has(task.projectId)) return false
  return project.status !== 'done'
}

/** The「归档」entry for one visible `done` leaf (project detail's 子任务 rows). */
function archiveLeafButton(task: TaskNode, onAction: (action: Parameters<BoardStore['apply']>[0]) => void): JSX.Element {
  return (
    <button
      className="dk-btn dk-btn-ghost"
      onClick={() => { onAction({ kind: 'archive-task', projectId: task.projectId, taskId: task.id }) }}
    >归档</button>
  )
}

/**
 * A read-only `TaskNode` standing in for one archived leaf, so the project
 * detail's dependency graph draws the edge to a `done` provider instead of
 * silently dropping it (`dep-graph-layout` ignores dangling ids, so the
 * omission would be invisible rather than loud).
 *
 * `dependencies` is deliberately empty: an archived leaf can only ever be a
 * dependency PROVIDER (it is `done`), and leaving the array empty keeps the
 * layout from pulling a third layer of nodes in. It is never fed to the
 * scheduler, which only ever looks at active leaves.
 */
function archivedLeafNode(entry: Extract<ArchiveEntry, { kind: 'task' }>): TaskNode {
  return {
    id: entry.id,
    projectId: entry.projectId,
    titlePath: entry.titlePath,
    kind: entry.taskKind,
    status: entry.status,
    archivedAt: entry.archivedAt,
    ...(entry.archivedBy === undefined ? {} : { archivedBy: entry.archivedBy }),
    ...(entry.archiveNote === undefined ? {} : { archiveNote: entry.archiveNote }),
    dependencies: [],
    version: 0,
    createdAt: entry.archivedAt,
    updatedAt: entry.archivedAt,
    lastActivityAt: entry.archivedAt,
    history: [],
  }
}

/**
 * Shared open-session behavior for every entry point (project card, task
 * card, project detail): clear the last error, open the session, then close
 * the board — the opened session renders in the conversation pane, which the
 * open board covers, so a success without closeBoard() reads as a dead
 * button. A failure keeps the board open and surfaces the reason on the card.
 */
function useOpenSession(onOpenSession: (sessionId: string) => void): { openError: string | null; open(sessionId: string): void } {
  const [openError, setOpenError] = useState<string | null>(null)
  const open = (sessionId: string): void => {
    setOpenError(null)
    try {
      onOpenSession(sessionId)
      closeBoard()
    } catch (error) {
      // The runtime throws when the session is not in the current workspace
      // list (e.g. the project's directory is a different workspace); a
      // silent no-op reads as a broken button, so surface the reason.
      setOpenError(error instanceof Error ? error.message : String(error))
    }
  }
  return { openError, open }
}

/** Titles of a task's not-yet-done dependencies (card waiting line and detail dependencies section). */function waitingForTitles(task: TaskNode, tasks: TaskNode[]): string[] {
  return task.dependencies
    .map(id => tasks.find(candidate => candidate.id === id))
    .filter((candidate): candidate is TaskNode => candidate !== undefined && candidate.status !== 'done')
    .map(candidate => candidate.titlePath.split(' > ').at(-1) ?? candidate.titlePath)
}

/**
 * The archive list's on-demand fetch. Kept as its own hook because the
 * snapshot cannot answer this question: the host filters archived records OUT
 * of the snapshot, so a revision bump is the only signal that "the archive may
 * have moved" (every archive/restore/delete is a ledger mutation and bumps it;
 * the spawner's pending-additions push explicitly does not).
 *
 * Identity of the returned object matters: it is re-created on every load
 * attempt, which is what re-runs the effect when `revision` changes.
 */
function useArchive(
  store: BoardStore,
  revision: number,
  enabled: boolean,
): { entries: ArchiveEntry[] | null; load: { state: 'idle' | 'loading' | 'loaded' | 'error'; error?: string } } {
  const [entries, setEntries] = useState<ArchiveEntry[] | null>(null)
  const [load, setLoad] = useState<{ state: 'idle' | 'loading' | 'loaded' | 'error'; error?: string }>({ state: 'idle' })
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoad({ state: 'loading' })
    store.readArchive().then(
      archive => {
        if (cancelled) return
        setEntries(archive)
        setLoad({ state: 'loaded' })
      },
      (error: unknown) => {
        if (cancelled) return
        setLoad({ state: 'error', error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { cancelled = true }
    // `revision` is deliberate: archive, restore and delete all bump it, so a
    // change means "re-read"; an unchanged revision means "do not re-read"
    // (this is what keeps the 5-second pending-additions heartbeat, which never
    // bumps the revision, from re-fetching the archive over and over).
  }, [store, revision, enabled])
  return { entries, load }
}

/** The board view (MVP). */
export function Board({ store, openSession, getDefaultWorkspaceDir }: BoardProps): JSX.Element {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const error = useSyncExternalStore(store.subscribe, store.getError)
  const [creating, setCreating] = useState(false)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  // detailTaskId stacks on top of detailId: opening a task detail from the
  // project detail keeps detailId set, so「返回」is always just
  // setDetailTaskId(null) and lands back on the project detail.
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  // The archive view is one more layer of the same in-place view stack the
  // detail views already use (no new route — the same pattern as closeBoard).
  const [showArchive, setShowArchive] = useState(false)
  // Only meaningful while the archive view is open: the id of the archived
  // project whose detail page is being shown. The ledger record is a complete
  // Project, but the snapshot filters it out, so the archive view is what
  // supplies it — and the archive read is the only source that has it.
  const [archiveDetailId, setArchiveDetailId] = useState<string | null>(null)
  const detailProject = detailId === null ? undefined : snapshot.projects.find(project => project.id === detailId)
  // Resolves to undefined when the task (or its whole project) disappeared
  // from the snapshot; the render chain below then falls back to the project
  // detail / columns instead of going blank.
  const detailTask = detailTaskId === null ? undefined : snapshot.tasks.find(task => task.id === detailTaskId)

  // Version-mismatch guard: an old host silently drops the lifecycle field
  // on create-project, so the client must not offer「长期执行中的项目」
  // unless the running host declares the capability. Absent = too old.
  const supportsLongRunning = snapshot.capabilities?.includes(CAPABILITY_LONG_RUNNING_PROJECTS) ?? false
  // Same handshake pattern for affiliated workspace inheritance: only a host
  // declaring the capability gets the omit-the-dir form; older hosts get the
  // pre-filled, still-editable dir input (they accept the value as-is).
  const supportsParentInheritance = snapshot.capabilities?.includes(CAPABILITY_PARENT_WORKSPACE_INHERITANCE) ?? false
  // Same handshake pattern for task-level terminate/delete: only a host
  // declaring the capability gets the buttons (an old host would 400 them).
  const supportsTaskTerminateDelete = snapshot.capabilities?.includes(CAPABILITY_TASK_TERMINATE_DELETE) ?? false
  // Same handshake pattern for task-level human recovery: the failure chip and
  // the「最近失败」section are read-side fields (rendered whenever present), but
  // the recover-task buttons need the host to understand the action.
  const supportsTaskRecovery = snapshot.capabilities?.includes(CAPABILITY_TASK_RECOVERY) ?? false
  // Same handshake pattern for late task-additions requests: the badge and the
  // 「物化到看板」entry need the host to understand `materialize-additions`
  // (an old host would 400 it), so they are gated on BOTH the capability and a
  // non-empty assembly field.
  const supportsLateAdditions = snapshot.capabilities?.includes(CAPABILITY_LATE_TASK_ADDITIONS) ?? false
  // …and the「废弃该请求」entry needs `discard-additions`, which is a LATER
  // capability than the badge itself: an older host may show the badge and
  // still not understand the discard action.
  const supportsAdditionsDiscard = snapshot.capabilities?.includes(CAPABILITY_ADDITIONS_DISCARD) ?? false
  // Same handshake pattern for the archive surface: the「归档 (N)」entry, the
  // archive view and every archive/unarchive button need the host to
  // understand all four actions, so they are all gated on this one token.
  const supportsArchive = snapshot.capabilities?.includes(CAPABILITY_TASK_ARCHIVE) ?? false
  // Double negative on purpose (same style as the pending-additions gate
  // above): a host that does not declare the capability must be treated as
  // having no archive aggregate at all, even if the field were somehow
  // present.
  const archivedCounts = supportsArchive ? snapshot.archivedCounts : undefined
  // The「归档 (N)」number: the same sum the host's GET /kanban/archive returns,
  // by P3. `undefined` counts render as 0, never as the string "undefined".
  const archivedTotal = archivedCounts === undefined ? 0 : archivedCounts.projects + archivedCounts.tasks
  const archivedProjects = archivedProjectIds(snapshot.projects)
  const pendingByProject = new Map<string, PendingAddition>()
  if (supportsLateAdditions) {
    for (const entry of snapshot.pendingAdditions ?? []) pendingByProject.set(entry.projectId, entry)
  }
  // Called before any early return (hook order is unconditional) but inert
  // until the archive view is actually open.
  const archive = useArchive(store, snapshot.revision, showArchive)
  // The archived project whose detail page is open, as the archive projection
  // carries it. The projection IS the page's data source: the snapshot cannot
  // supply the record (it is filtered out) and the projection carries exactly
  // the fields that page renders.
  const archiveEntry = showArchive && archiveDetailId !== null
    ? (archive.entries ?? []).find((entry): entry is Extract<ArchiveEntry, { kind: 'project' }> =>
      entry.kind === 'project' && entry.id === archiveDetailId)
    : undefined

  if (detailTask !== undefined) {
    return (
      <div className="dk-board">
        <TaskDetail
          task={detailTask}
          projectTitle={snapshot.projects.find(project => project.id === detailTask.projectId)?.title ?? ''}
          waitingFor={waitingForTitles(detailTask, snapshot.tasks)}
          store={store}
          backLabel={detailId === null ? '返回看板' : '返回项目'}
          supportsTaskTerminateDelete={supportsTaskTerminateDelete}
          supportsTaskRecovery={supportsTaskRecovery}
          onBack={() => { setDetailTaskId(null) }}
          onAction={action => { void store.apply(action) }}
          onOpenSession={openSession}
        />
      </div>
    )
  }

  return (
    <div className="dk-board">
      {detailProject === undefined && archiveEntry === undefined ? (
        <>
          <header className="dk-header">
            <h2 className="dk-title">{showArchive ? '归档' : '项目看板'}</h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              {!showArchive && (
                <button className="dk-btn dk-btn-primary" onClick={() => { setCreating(true) }}>+ 新建项目</button>
              )}
              {supportsArchive && (
                <button
                  className={showArchive ? 'dk-btn dk-btn-primary' : 'dk-btn'}
                  onClick={() => {
                    // Always land on the archive LIST: leaving a detail page in
                    // the stack would make the entry look like a no-op.
                    setShowArchive(!showArchive)
                    setDetailId(null)
                    setDetailTaskId(null)
                    setArchiveDetailId(null)
                  }}
                >归档 ({archivedTotal})</button>
              )}
              <button className="dk-btn" onClick={() => { closeBoard() }}>返回</button>
            </div>
          </header>
          {error !== null && <p className="dk-error">host 通信失败：{error}</p>}
          {!supportsLongRunning && (
            <p className="dk-banner">看板 host 版本过旧，不支持长期项目；请重启 DSH 后刷新页面</p>
          )}
          {showArchive ? (
            <ArchiveView
              entries={archive.entries}
              load={archive.load}
              pendingByProject={pendingByProject}
              supportsAdditionsDiscard={supportsAdditionsDiscard}
              store={store}
              onOpenProject={projectId => { setArchiveDetailId(projectId) }}
              onAction={action => { void store.apply(action) }}
            />
          ) : (
          <div className="dk-columns">
            {COLUMNS.map(column => {
              const projects = snapshot.projects.filter(project => project.status === column.status)
              const tasks = snapshot.tasks.filter(task => task.status === column.status)
              return (
                <section className="dk-column" key={column.status}>
                  <div className="dk-column-title">
                    <span>{column.label}</span>
                    <span className="dk-column-count">{projects.length + tasks.length}</span>
                  </div>
                  {projects.length === 0 && tasks.length === 0 && <span className="dk-empty">空</span>}
                  {projects.map(project => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      parentTitle={project.parentId === undefined ? undefined : snapshot.projects.find(parent => parent.id === project.parentId)?.title}
                      taskCount={snapshot.tasks.filter(task => task.projectId === project.id).length}
                      pending={pendingByProject.get(project.id)}
                      supportsAdditionsDiscard={supportsAdditionsDiscard}
                      supportsArchive={supportsArchive}
                      archivable={canArchiveProject(project, snapshot.tasks)}
                      rejecting={rejectingId === project.id}
                      onToggleReject={() => { setRejectingId(rejectingId === project.id ? null : project.id) }}
                      onAction={action => { void store.apply(action) }}
                      onOpenSession={openSession}
                      onOpenDetail={() => { setDetailId(project.id) }}
                    />
                  ))}
                  {tasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      projectTitle={snapshot.projects.find(project => project.id === task.projectId)?.title ?? ''}
                      waitingFor={waitingForTitles(task, snapshot.tasks)}
                      supportsTaskTerminateDelete={supportsTaskTerminateDelete}
                      supportsTaskRecovery={supportsTaskRecovery}
                      onAction={action => { void store.apply(action) }}
                      onOpenSession={openSession}
                      onOpenDetail={() => { setDetailTaskId(task.id) }}
                    />
                  ))}
                </section>
              )
            })}
          </div>
          )}
        </>
      ) : archiveEntry !== undefined ? (
        <ArchivedProjectDetail
          entry={archiveEntry}
          onBack={() => { setArchiveDetailId(null) }}
          onAction={action => {
            void store.apply(action)
            // Deleting from the archive page drops the record entirely, so
            // there is nothing left to keep in the view stack.
            if (action.kind === 'delete-project') { setArchiveDetailId(null); setDetailId(null) }
          }}
        />
      ) : detailProject === undefined ? null : (
        <ProjectDetail
          project={detailProject}
          tasks={snapshot.tasks.filter(task => task.projectId === detailProject.id)}
          parentTitle={detailProject.parentId === undefined ? undefined : snapshot.projects.find(parent => parent.id === detailProject.parentId)?.title}
          childProjects={snapshot.projects.filter(candidate => candidate.parentId === detailProject.id)}
          pending={pendingByProject.get(detailProject.id)}
          supportsLateAdditions={supportsLateAdditions}
          supportsAdditionsDiscard={supportsAdditionsDiscard}
          supportsArchive={supportsArchive}
          snapshotRevision={snapshot.revision}
          store={store}
          onBack={() => { setDetailId(null) }}
          onOpenProjectDetail={projectId => { setDetailId(projectId) }}
          onAction={action => {
            void store.apply(action)
            // The project is gone after a delete; fall back to the board.
            if (action.kind === 'delete-project') setDetailId(null)
          }}
          onOpenSession={openSession}
          onOpenTaskDetail={taskId => { setDetailTaskId(taskId) }}
        />
      )}
      {creating && (
        <NewProjectModal
          getDefaultWorkspaceDir={getDefaultWorkspaceDir}
          supportsLongRunning={supportsLongRunning}
          supportsParentInheritance={supportsParentInheritance}
          parents={snapshot.projects
            .filter(project => project.lifecycle === 'long-running')
            .map(project => ({ id: project.id, title: project.title, workspaceDir: project.workspaceDir }))}
          onCancel={() => { setCreating(false) }}
          onCreate={input => {
            setCreating(false)
            void (async () => {
              await store.apply({ kind: 'create-project', ...input })
              // apply swallows failures into lastError; a rejected dir is
              // not worth remembering, so only persist on success.
              // An affiliated create omits workspaceDir (the host inherits
              // the parent's): the inherited value must NOT clobber
              // last-workspace-dir, whose semantics are "the dir the user
              // last picked by hand".
              if (store.getError() === null && input.workspaceDir !== undefined) rememberWorkspaceDir(input.workspaceDir)
            })()
          }}
        />
      )}
    </div>
  )
}

interface ProjectCardProps {
  project: Project
  /** Resolved title of the parent long-running project (undefined when unaffiliated or the parent is gone). */
  parentTitle?: string
  taskCount: number
  /**
   * A request on disk that has not been materialized yet (only supplied when
   * the host declares the capability). Optional so existing fixtures are
   * untouched and an old host simply renders nothing.
   */
  pending?: PendingAddition
  /** Host capability handshake: old hosts 400 `discard-additions`. */
  supportsAdditionsDiscard: boolean
  /** Host capability handshake: old hosts 400 the archive actions. */
  supportsArchive: boolean
  /** Whether the「归档」entry may be offered (see canArchiveProject). */
  archivable: boolean
  rejecting: boolean
  onToggleReject(): void
  onAction(action: Parameters<BoardStore['apply']>[0]): void
  onOpenSession(sessionId: string): void
  onOpenDetail(): void
}

function ProjectCard({ project, parentTitle, taskCount, pending, supportsAdditionsDiscard, supportsArchive, archivable, rejecting, onToggleReject, onAction, onOpenSession, onOpenDetail }: ProjectCardProps): JSX.Element {
  const { openError, open } = useOpenSession(onOpenSession)
  const handleOpenSession = (): void => { open(project.sessionId!) }
  const sessionChip = project.sessionId !== undefined
    ? <button className="dk-btn dk-btn-ghost" onClick={handleOpenSession}>打开会话</button>
    : null
  const badge = pending === undefined ? undefined : pendingBadge(pending)
  const handleMaterialize = (): void => {
    if (pending === undefined) return
    if (!globalThis.confirm(materializeConfirmText(project, pending))) return
    onAction({ kind: 'materialize-additions', projectId: project.id })
  }

  return (
    <article className="dk-card">
      <h3 className="dk-card-title">
        {project.lifecycle === 'long-running' && <span className="dk-kind-badge">长期</span>}
        {project.title}
      </h3>
      <p className="dk-card-goal">{project.goal}</p>
      {project.parentId !== undefined && (
        <p className="dk-card-parent">隶属于 {parentTitle ?? '（父项目已删除）'}</p>
      )}
      <div className="dk-card-meta">
        {project.sessionId?.slice(0, 13) ?? '无会话'}
        {taskCount > 0 && <> · 子任务 {taskCount}</>}
        {project.feedback !== undefined && <> · 反馈：{project.feedback}</>}
      </div>
      {badge !== undefined && (
        <p
          className={badge.malformed ? 'dk-card-pending-error' : 'dk-card-pending'}
          title={badge.title}
        >{badge.text}</p>
      )}
      {pending !== undefined && (pending.malformed?.length ?? 0) > 0 && pending.state !== 'malformed' && malformedChips(pending.malformed!)}
      {project.status === 'blocked' && project.lastFailure !== undefined && (
        <p className="dk-card-failure" title={failureChipText(project.lastFailure)}>{failureChipText(project.lastFailure)}</p>
      )}
      {openError !== null && <p className="dk-card-error">无法打开会话：{openError}</p>}
      <div className="dk-card-actions">
        {project.status === 'awaiting-review' && (
          <>
            <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'confirm-plan', projectId: project.id }) }}>确认方案</button>
            <button className="dk-btn dk-btn-danger" onClick={onToggleReject}>{rejecting ? '取消' : '驳回'}</button>
          </>
        )}
        {project.status === 'blocked' && (
          <button className="dk-btn" onClick={() => { onAction({ kind: 'transition', projectId: project.id, to: 'designing', note: 're-design from blocked' }) }}>重新设计</button>
        )}
        {(project.status === 'designing' || project.status === 'executing' || project.status === 'done') && sessionChip}
        {pending !== undefined && (pending.state === 'malformed'
          ? (supportsAdditionsDiscard
            ? discardButton(project, pending, onAction)
            : <button className="dk-btn" disabled title="修复请求文件后再试；格式错误的请求不会被物化">无法物化（请求格式错误）</button>)
          : (
            <>
              <button className="dk-btn dk-btn-primary" onClick={handleMaterialize}>物化到看板</button>
              {supportsAdditionsDiscard && discardButton(project, pending, onAction)}
            </>
          )
        )}
        <button className="dk-btn dk-btn-ghost" onClick={onOpenDetail}>详情</button>
        {supportsArchive && archivable && (
          <button
            className="dk-btn dk-btn-ghost"
            onClick={() => { onAction({ kind: 'archive-project', projectId: project.id }) }}
          >归档</button>
        )}
        <button
          className="dk-btn dk-btn-ghost"
          onClick={() => { if (globalThis.confirm(`删除项目「${project.title}」？`)) onAction({ kind: 'delete-project', projectId: project.id }) }}
        >删除</button>
      </div>
      {rejecting && (
        <RejectForm
          projectId={project.id}
          onSubmit={feedback => { onAction({ kind: 'reject-plan', projectId: project.id, feedback }) }}
        />
      )}
    </article>
  )
}

interface ArchiveViewProps {
  /** null = not loaded yet; the load state distinguishes "loading" from "empty". */
  entries: ArchiveEntry[] | null
  load: { state: 'idle' | 'loading' | 'loaded' | 'error'; error?: string }
  /** The published pending-additions entries, so an archived project's request stays visible. */
  pendingByProject: Map<string, PendingAddition>
  supportsAdditionsDiscard: boolean
  store: BoardStore
  onOpenProject(projectId: string): void
  onAction(action: Parameters<BoardStore['apply']>[0]): void
}

/**
 * The archive view: the only place archived records are visible, and the only
 * place a project can be deleted from once it is archived (the board path
 * cannot even reach it — the snapshot no longer contains it).
 *
 * It renders from the PROJECTION (`ArchiveEntry`), which deliberately carries
 * no `history`. Consequence, kept on purpose: a leaf entry offers no「详情」
 * button, because a task detail would open an empty timeline — an entry that
 * points at nothing is worse than no entry.
 */
function ArchiveView({ entries, load, pendingByProject, supportsAdditionsDiscard, store, onOpenProject, onAction }: ArchiveViewProps): JSX.Element {
  // P2's view-side mirror: a leaf whose owning project is itself archived was
  // hidden WITH that project (it carries no marker of its own), so drawing it
  // as an individually restorable row would offer a restore with no visible
  // effect. The host's projection already excludes those; this is the client's
  // minimum defence against drawing dirty data.
  const visible = (entries ?? []).filter(entry => {
    if (entry.kind !== 'task') return true
    return !(entries ?? []).some(other => other.kind === 'project' && other.id === entry.projectId)
  })
  return (
    // `dk-detail-body` normally sizes itself inside a `dk-detail`; here it is a
    // direct child of the board (flex column) under the shared header, so it
    // needs the explicit grow/shrink pair to scroll instead of overflowing.
    <div className="dk-detail-body" style={{ flex: '1 1 auto', minHeight: 0 }}>
      <section className="dk-detail-section">
        <p className="dk-hint dk-archive-summary">
          归档只是从看板移出：记录仍在账本里，产物文件原样保留，随时可以恢复。
        </p>
        {load.state === 'error' && <p className="dk-card-error">归档读取失败：{load.error ?? '未知错误'}</p>}
        {load.state === 'loading' && <p className="dk-empty">加载中…</p>}
        {load.state !== 'loading' && load.state !== 'error' && visible.length === 0 && (
          <p className="dk-empty">暂无归档记录。已完成的节点超过保留窗口后会自动归档。</p>
        )}
        {visible.map(entry => entry.kind === 'project'
          ? archivedProjectRow(entry, pendingByProject, supportsAdditionsDiscard, store, onOpenProject, onAction)
          : archivedTaskRow(entry, onAction))}
      </section>
    </div>
  )
}

/**
 * The archive list's version of the materialize confirmation. `ArchiveEntry`
 * is a projection (no `sessionId`, no `lifecycle`), so the shared
 * `materializeConfirmText` cannot take it directly; the wording that matters
 * here is only "how many execute leaves will really start a session" and
 * whether the project will re-open, and an archived project is always `done`.
 */
function archivedMaterializeConfirmText(entry: Extract<ArchiveEntry, { kind: 'project' }>, pending: PendingAddition): string {
  const executeCount = pending.items?.filter(item => item.kind === 'execute').length ?? 0
  const extra = executeCount > 0 ? `，并立即为其中 ${executeCount} 个执行叶子拉起会话（真实消耗额度、真实改动仓库）` : ''
  return `物化「${entry.title}」的 ${pending.count} 项新增任务到看板${extra}（项目将从「${STATUS_LABELS[entry.status]}」重新进入执行中）`
}

/**
 * The archive list's version of the discard confirmation — same wording, same
 * reason, but built from the projection (see above).
 */
function archivedDiscardConfirmText(entry: Extract<ArchiveEntry, { kind: 'project' }>, pending: PendingAddition): string {
  const count = pending.state === 'malformed'
    ? `${pending.batches} 个请求文件`
    : `${pending.count} 项新增任务（${pending.batches} 个请求文件）`
  return `废弃「${entry.title}」的 ${count}？文件会被重命名为 *.discarded.json 留在项目目录（可人工恢复），但不会再物化到看板。`
}

/**
 * One archived project row. Its「详情」entry is real (the caller holds the
 * entry, which is a complete `Project`), unlike the leaf row's.
 */
function archivedProjectRow(
  entry: Extract<ArchiveEntry, { kind: 'project' }>,
  pendingByProject: Map<string, PendingAddition>,
  supportsAdditionsDiscard: boolean,
  store: BoardStore,
  onOpenProject: (projectId: string) => void,
  onAction: (action: Parameters<BoardStore['apply']>[0]) => void,
): JSX.Element {
  const pending = pendingByProject.get(entry.projectId)
  const badge = pending === undefined ? undefined : pendingBadge(pending)
  return (
    <div className="dk-detail-task dk-archive-row" key={entry.id}>
      <div className="dk-card-meta">
        <span className="dk-kind-badge">项目</span>
        {entry.archivedBy !== undefined && <> · {ACTOR_LABELS[entry.archivedBy]}归档</>}
        {entry.taskCount > 0 && <> · 含子任务 {entry.taskCount}</>}
      </div>
      <p className="dk-detail-task-path">{entry.title}</p>
      {entry.parentTitle !== undefined && <p className="dk-card-parent">隶属于 {entry.parentTitle}</p>}
      <p className="dk-hint dk-archive-time">
        {formatTime(entry.archivedAt)}{entry.archiveNote !== undefined ? ` · ${entry.archiveNote}` : ''}
      </p>
      {badge !== undefined && (
        <p
          className={badge.malformed ? 'dk-card-pending-error' : 'dk-card-pending'}
          title={badge.title}
        >{badge.text}</p>
      )}
      {pending !== undefined && (pending.malformed?.length ?? 0) > 0 && pending.state !== 'malformed' && malformedChips(pending.malformed!)}
      <div className="dk-card-actions">
        {pending !== undefined && pending.state !== 'malformed' && (
          <button
            className="dk-btn dk-btn-primary"
            onClick={() => {
              if (!globalThis.confirm(archivedMaterializeConfirmText(entry, pending))) return
              onAction({ kind: 'materialize-additions', projectId: entry.id })
            }}
          >物化到看板</button>
        )}
        {pending !== undefined && pending.state === 'malformed' && supportsAdditionsDiscard && (
          <button
            className="dk-btn dk-btn-danger"
            onClick={() => {
              if (!globalThis.confirm(archivedDiscardConfirmText(entry, pending))) return
              onAction({ kind: 'discard-additions', projectId: entry.id })
            }}
          >废弃该请求</button>
        )}
        <button className="dk-btn dk-btn-ghost" onClick={() => { onOpenProject(entry.id) }}>详情</button>
        <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'unarchive-project', projectId: entry.id }) }}>恢复</button>
        <button
          className="dk-btn dk-btn-ghost"
          onClick={() => { if (globalThis.confirm(`删除项目「${entry.title}」？`)) onAction({ kind: 'delete-project', projectId: entry.id }) }}
        >删除</button>
      </div>
    </div>
  )
}

/**
 * One archived leaf row (form C: a `done` leaf of a project that is still on
 * the board). No「详情」button — see ArchiveView's note on the projection.
 */
function archivedTaskRow(
  entry: Extract<ArchiveEntry, { kind: 'task' }>,
  onAction: (action: Parameters<BoardStore['apply']>[0]) => void,
): JSX.Element {
  return (
    <div className="dk-detail-task dk-archive-row" key={entry.id}>
      <div className="dk-card-meta">
        <span className="dk-kind-badge">子任务</span>
        {' '}<span className="dk-kind-badge">{KIND_LABELS[entry.taskKind]}</span>
        {entry.archivedBy !== undefined && <> · {ACTOR_LABELS[entry.archivedBy]}归档</>}
      </div>
      <p className="dk-detail-task-path">{entry.titlePath}</p>
      <p className="dk-card-parent">属于 {entry.projectTitle}</p>
      <p className="dk-hint dk-archive-time">
        {formatTime(entry.archivedAt)}{entry.archiveNote !== undefined ? ` · ${entry.archiveNote}` : ''}
      </p>
      <div className="dk-card-actions">
        <button
          className="dk-btn dk-btn-primary"
          onClick={() => { onAction({ kind: 'unarchive-task', projectId: entry.projectId, taskId: entry.id }) }}
        >恢复</button>
      </div>
    </div>
  )
}

interface TaskCardProps {
  task: TaskNode
  projectTitle: string
  /** Titles of not-yet-done dependencies this leaf is waiting on. */
  waitingFor: string[]
  /** Host capability handshake: old hosts 400 terminate/delete, so hide the buttons. */
  supportsTaskTerminateDelete: boolean
  /** Host capability handshake: old hosts 400 recover-task, so hide the buttons. */
  supportsTaskRecovery: boolean
  onAction(action: Parameters<BoardStore['apply']>[0]): void
  onOpenSession(sessionId: string): void
  onOpenDetail(): void
}

/** One decomposed task leaf: level-indented title, kind badge, and kind-specific actions. */
function TaskCard({ task, projectTitle, waitingFor, supportsTaskTerminateDelete, supportsTaskRecovery, onAction, onOpenSession, onOpenDetail }: TaskCardProps): JSX.Element {
  const segments = task.titlePath.split(' > ')
  const level = segments.length - 1
  const [answerDraft, setAnswerDraft] = useState('')
  const { openError, open } = useOpenSession(onOpenSession)
  const handleOpenSession = (): void => { open(task.sessionId!) }

  return (
    <article className="dk-card" style={{ marginLeft: `${Math.min(level, 3) * 14}px` }}>
      <h3 className="dk-card-title">{segments.at(-1)}</h3>
      {segments.length > 1 && <p className="dk-card-path">{segments.slice(0, -1).join(' > ')}</p>}
      <div className="dk-card-meta">
        <span className="dk-kind-badge">{KIND_LABELS[task.kind]}</span>
        {projectTitle !== '' && <> · {projectTitle}</>}
        {task.sessionId !== undefined && <> · {task.sessionId.slice(0, 13)}</>}
      </div>
      {waitingFor.length > 0 && <p className="dk-card-waiting">⏳ 等待依赖完成：{waitingFor.join('、')}</p>}
      {task.status === 'blocked' && task.lastFailure !== undefined && (
        <p className="dk-card-failure" title={failureChipText(task.lastFailure)}>{failureChipText(task.lastFailure)}</p>
      )}
      {task.recovery !== undefined && (
        <p className="dk-card-recovering">⏳ 恢复判定中（{task.recovery.strategy}，{formatTime(task.recovery.at)}）</p>
      )}
      {task.kind === 'clarify' && task.status === 'awaiting-clarification' && task.question !== undefined && (
        <div className="dk-reject">
          <p className="dk-card-goal">❓ {task.question}</p>
          <textarea
            placeholder="回答这个问题（会作为后续执行任务的上下文）"
            value={answerDraft}
            onChange={event => { setAnswerDraft(event.target.value) }}
          />
          <div className="dk-card-actions">
            <button
              className="dk-btn dk-btn-primary"
              disabled={answerDraft.trim() === ''}
              onClick={() => {
                onAction({ kind: 'answer-clarification', projectId: task.projectId, taskId: task.id, answer: answerDraft.trim() })
                setAnswerDraft('')
              }}
            >提交回答</button>
          </div>
        </div>
      )}
      {task.kind === 'clarify' && task.status === 'awaiting-review' && task.answer !== undefined && (
        <div className="dk-card-actions">
          <span className="dk-card-goal">✅ {task.answer}</span>
          <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'confirm-task', projectId: task.projectId, taskId: task.id }) }}>确认回答</button>
        </div>
      )}
      {task.kind === 'design' && task.status === 'awaiting-review' && (
        <div className="dk-card-actions">
          <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'confirm-task', projectId: task.projectId, taskId: task.id }) }}>确认设计</button>
        </div>
      )}
      <div className="dk-card-actions">
        {supportsTaskRecovery && task.status === 'blocked' && task.recovery === undefined && (
          task.sessionId !== undefined ? (
            <button
              className="dk-btn"
              onClick={() => { onAction({ kind: 'recover-task', projectId: task.projectId, taskId: task.id, strategy: 'reinspect' }) }}
            >恢复</button>
          ) : (
            <button
              className="dk-btn"
              onClick={() => {
                if (!globalThis.confirm('重新排队会新建会话重新执行该任务，确定？')) return
                onAction({ kind: 'recover-task', projectId: task.projectId, taskId: task.id, strategy: 'requeue' })
              }}
            >重新排队</button>
          )
        )}
        {task.sessionId !== undefined && (task.status === 'designing' || task.status === 'executing' || task.status === 'done' || task.status === 'blocked') && (
          <button className="dk-btn dk-btn-ghost" onClick={handleOpenSession}>打开会话</button>
        )}
        <button className="dk-btn dk-btn-ghost" onClick={onOpenDetail}>详情</button>
        {supportsTaskTerminateDelete && (task.status === 'designing' || task.status === 'executing') && (
          <button
            className="dk-btn dk-btn-ghost"
            onClick={() => { onAction({ kind: 'terminate-task', projectId: task.projectId, taskId: task.id }) }}
          >终止</button>
        )}
        {supportsTaskTerminateDelete && (
          <button
            className="dk-btn dk-btn-ghost"
            onClick={() => { if (globalThis.confirm(`删除任务「${task.titlePath.split(' > ').at(-1)}」？`)) onAction({ kind: 'delete-task', projectId: task.projectId, taskId: task.id }) }}
          >删除</button>
        )}
      </div>
      {openError !== null && <p className="dk-card-error">无法打开会话：{openError}</p>}
    </article>
  )
}

interface ProjectDetailProps {
  project: Project
  tasks: TaskNode[]
  /** Resolved title of the parent long-running project (undefined when unaffiliated or the parent is gone). */
  parentTitle?: string
  /** Projects affiliated to this one (only meaningful for a long-running project). */
  childProjects: Project[]
  /** A request on disk that has not been materialized yet (capability-gated by the board). */
  pending?: PendingAddition
  /** Host capability handshake: old hosts 400 `materialize-additions`. */
  supportsLateAdditions: boolean
  /** Host capability handshake: old hosts 400 `discard-additions`. */
  supportsAdditionsDiscard: boolean
  /** Host capability handshake: old hosts 400 the archive actions, so those entries hide. */
  supportsArchive: boolean
  /** The snapshot's revision — the signal that this project's archive cluster may have moved. */
  snapshotRevision: number
  store: BoardStore
  onBack(): void
  onAction(action: Parameters<BoardStore['apply']>[0]): void
  onOpenSession(sessionId: string): void
  /** Cross-navigation: a child project row opens that project's detail. */
  onOpenProjectDetail(projectId: string): void
  /** Cross-navigation: a task row in the「子任务」section opens the task detail. */
  onOpenTaskDetail(taskId: string): void
}

/**
 * The detail page of one ARCHIVED project. Deliberately a smaller page than
 * `ProjectDetail`: the archive read serves a projection (no `history`, no
 * `goal` beyond the projection, no plan), so there is nothing to render for
 * the plan preview or the transition timeline. Restoring is one click away,
 * and that is the documented path to the full view.
 *
 * The「恢复」button is the same round trip `ProjectDetail` offers, so an
 * archived project can be brought back from whichever page the user is on.
 */
function ArchivedProjectDetail({ entry, onBack, onAction }: {
  entry: Extract<ArchiveEntry, { kind: 'project' }>
  onBack(): void
  onAction(action: Parameters<BoardStore['apply']>[0]): void
}): JSX.Element {
  return (
    <div className="dk-detail">
      <header className="dk-header">
        <h2 className="dk-title">{entry.title}</h2>
        <button className="dk-btn" onClick={onBack}>返回归档</button>
      </header>
      <p className="dk-banner">
        该项目已归档：记录仍在账本中，产物文件原样保留。恢复后会回到看板的「已完成」列。
      </p>
      <div className="dk-detail-body">
        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">归档信息</h3>
          <dl className="dk-detail-grid">
            <dt>状态</dt><dd><span className="dk-kind-badge">{STATUS_LABELS[entry.status]}</span></dd>
            {entry.parentTitle !== undefined && (
              <>
                <dt>所属长期项目</dt><dd>{entry.parentTitle}</dd>
              </>
            )}
            <dt>归档时间</dt><dd>{formatTime(entry.archivedAt)}</dd>
            <dt>归档人</dt><dd>{entry.archivedBy === undefined ? '未知' : ACTOR_LABELS[entry.archivedBy]}</dd>
            <dt>归档原因</dt><dd>{entry.archiveNote ?? '（未记录）'}</dd>
            <dt>子任务数</dt><dd>{entry.taskCount}</dd>
          </dl>
          <p className="dk-hint">归档项目不提供方案预览与流转历史；恢复后即可在项目详情里查看。</p>
        </section>
        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">操作</h3>
          <div className="dk-card-actions">
            <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'unarchive-project', projectId: entry.id }) }}>恢复</button>
            <button
              className="dk-btn dk-btn-ghost"
              onClick={() => { if (globalThis.confirm(`删除项目「${entry.title}」？`)) onAction({ kind: 'delete-project', projectId: entry.id }) }}
            >删除</button>
          </div>
        </section>
      </div>
    </div>
  )
}

/**
 * The full-screen project detail view, switched inside the board container
 * (no new route — same pattern as closeBoard). Five sections: basic info,
 * plan preview (fetched on demand through the /kanban/file route), task
 * leaves, transition history, and the same action set as the card.
 */
function ProjectDetail({ project, tasks, parentTitle, childProjects, pending, supportsLateAdditions, supportsAdditionsDiscard, supportsArchive, snapshotRevision, store, onBack, onAction, onOpenSession, onOpenProjectDetail, onOpenTaskDetail }: ProjectDetailProps): JSX.Element {
  const [rejecting, setRejecting] = useState(false)
  const { openError, open } = useOpenSession(onOpenSession)
  // Capability-gated twice on purpose: an old host would 400 the action, so
  // the entry never renders even if the assembly field were somehow present.
  const pendingRequest = supportsLateAdditions ? pending : undefined
  const [plan, setPlan] = useState<{ state: 'loading' | 'loaded' | 'error'; text?: string; error?: string } | null>(null)
  const planPath = project.planPath
  // 子任务 section view switch. The lazy initializer only runs on mount, so
  // a later snapshot refresh never resets a manual choice; the default is
  // the graph only when it would actually show a structure (≥ 2 tasks and
  // at least one dependency edge), otherwise the familiar list.
  const [tasksView, setTasksView] = useState<'list' | 'graph'>(() =>
    tasks.length >= 2 && tasks.some(task => task.dependencies.length > 0) ? 'graph' : 'list'
  )

  /**
   * Compensation read of this project's archive cluster. The snapshot filters
   * archived records out, so without this an active long-running container
   * would silently lose its finished children the moment the sweep archives
   * them, and a visible project's archived leaves would vanish from its graph.
   *
   * Read failure is handled by DEGRADING TO THE ACTIVE SET (empty merge + a
   * hint), never by blocking the page: the archive is a supplement here, and a
   * detail page that cannot render because an optional read failed is a worse
   * outcome than a detail page that is missing its archived rows.
   */
  const [archived, setArchived] = useState<ArchiveEntry[] | null>(null)
  const [archiveLoadError, setArchiveLoadError] = useState<string | undefined>(undefined)
  const revision = snapshotRevision
  useEffect(() => {
    if (!supportsArchive) return
    let cancelled = false
    store.readArchive(project.id).then(
      entries => {
        if (cancelled) return
        setArchived(entries)
        setArchiveLoadError(undefined)
      },
      (error: unknown) => {
        if (cancelled) return
        setArchived([])
        setArchiveLoadError(error instanceof Error ? error.message : String(error))
      },
    )
    return () => { cancelled = true }
    // `revision`: a restore/archive anywhere may have moved this project's cluster.
  }, [project.id, revision, supportsArchive, store])

  // A leaf whose project is archived is hidden WITH the project, so it must
  // never be merged back in as if it were an individual archive. The host's
  // projection already excludes those; this is the client's minimum defence
  // against drawing dirty data (P2's view-side mirror).
  const archivedTasks = (archived ?? []).filter((entry): entry is Extract<ArchiveEntry, { kind: 'task' }> =>
    entry.kind === 'task' && entry.projectId === project.id
  )
  const archivedChildren = (archived ?? [])
    .filter((entry): entry is Extract<ArchiveEntry, { kind: 'project' }> => entry.kind === 'project')
    .sort((left, right) => right.archivedAt - left.archivedAt)
  // The graph needs the archived leaves as `done` providers, or every edge to
  // them is dropped as dangling and the structure quietly loses a node.
  const graphTasks = archivedTasks.length === 0 ? tasks : [...tasks, ...archivedTasks.map(archivedLeafNode)]
  const archivedProjectsOfThis = archivedProjectIds([project])
  const canArchiveThisLeaf = (task: TaskNode): boolean => canArchiveLeaf(task, project, archivedProjectsOfThis)

  // Fetch the plan artifact on demand; it deliberately stays out of the
  // snapshot (the file can be large and changes outside the ledger).
  useEffect(() => {
    if (planPath === undefined) {
      setPlan(null)
      return
    }
    let cancelled = false
    setPlan({ state: 'loading' })
    store.readFile(planPath).then(
      text => { if (!cancelled) setPlan({ state: 'loaded', text }) },
      (error: unknown) => { if (!cancelled) setPlan({ state: 'error', error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { cancelled = true }
  }, [planPath, store])

  const handleOpenSession = (): void => { open(project.sessionId!) }

  return (
    <div className="dk-detail">
      <header className="dk-header">
        <h2 className="dk-title">{project.title}</h2>
        <button className="dk-btn" onClick={onBack}>返回看板</button>
      </header>
      <div className="dk-detail-body">
        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">基本信息</h3>
          <dl className="dk-detail-grid">
            <dt>状态</dt><dd><span className="dk-kind-badge">{STATUS_LABELS[project.status]}</span></dd>
            <dt>生命周期</dt><dd>{project.lifecycle === 'long-running' ? '长期执行中' : '一次性'}</dd>
            {project.parentId !== undefined && (
              <>
                <dt>所属长期项目</dt><dd>{parentTitle ?? '（父项目已删除）'}</dd>
              </>
            )}
            <dt>目标</dt><dd>{project.goal}</dd>
            <dt>工作目录</dt><dd><code>{project.workspaceDir}</code></dd>
            <dt>创建时间</dt><dd>{formatTime(project.createdAt)}</dd>
            <dt>更新时间</dt><dd>{formatTime(project.updatedAt)}</dd>
            <dt>最近活动</dt><dd>{formatTime(project.lastActivityAt)}</dd>
            <dt>会话</dt>
            <dd>
              {project.sessionId !== undefined
                ? <button className="dk-btn dk-btn-ghost" onClick={handleOpenSession}>打开会话</button>
                : '无会话'}
            </dd>
          </dl>
          {openError !== null && <p className="dk-card-error">无法打开会话：{openError}</p>}
          {project.feedback !== undefined && <p className="dk-card-goal">最近反馈:{project.feedback}</p>}
        </section>

        {project.status === 'blocked' && project.lastFailure !== undefined && (
          <section className="dk-detail-section">
            <h3 className="dk-detail-heading">最近失败</h3>
            <p className="dk-card-failure" title={failureChipText(project.lastFailure)}>{failureChipText(project.lastFailure)}</p>
            <p className="dk-hint">归类 {project.lastFailure.cause} · 依据时间 {formatTime(project.lastFailure.at)}</p>
          </section>
        )}

        {pendingRequest !== undefined && (
          <section className="dk-detail-section dk-pending-section">
            <h3 className="dk-detail-heading">待处理的新增任务请求</h3>
            {pendingRequest.state === 'malformed' ? (
              <>
                <p className="dk-card-pending-error">⚠ 无法解析：{pendingRequest.error ?? '未知错误'}</p>
                <p className="dk-hint">
                  文件保留在项目目录中；修复后下一个轮询周期会自动重新检测。
                  {supportsAdditionsDiscard ? '不再需要这份请求时可直接废弃。' : '当前 host 不支持在看板上废弃，只能人工改文件。'}
                </p>
              </>
            ) : (
              <>
                <p className="dk-pending-meta">
                  来源 {pendingRequest.file} · 写入于 {formatTime(pendingRequest.at)} · 共 {pendingRequest.count} 项
                  {pendingRequest.batches > 1 ? `（${pendingRequest.batches} 个批次）` : ''}
                </p>
                {(pendingRequest.items ?? []).map((item, index) => (
                  <p className="dk-pending-item" key={index}>
                    <span className="dk-kind-badge">{KIND_LABELS[item.kind]}</span> {item.titlePath}
                  </p>
                ))}
                {pendingRequest.count > (pendingRequest.items?.length ?? 0) && (
                  <p className="dk-hint">…另有 {pendingRequest.count - (pendingRequest.items?.length ?? 0)} 项未展开</p>
                )}
                {(pendingRequest.malformed ?? []).map(problem => (
                  <p className="dk-card-pending-error" key={problem.file}>
                    ⚠ {problem.file} 无法解析：{problem.error}
                  </p>
                ))}
                {(pendingRequest.malformed?.length ?? 0) > 0 && (
                  <p className="dk-hint">无法解析的请求不会被物化，会原样保留在项目目录中（可修复后重新物化，或直接废弃）。</p>
                )}
              </>
            )}
            <div className="dk-card-actions">
              {pendingRequest.state !== 'malformed' && (
                <button
                  className="dk-btn dk-btn-primary"
                  onClick={() => {
                    if (!globalThis.confirm(materializeConfirmText(project, pendingRequest))) return
                    onAction({ kind: 'materialize-additions', projectId: project.id })
                  }}
                >物化到看板</button>
              )}
              {supportsAdditionsDiscard
                ? discardButton(project, pendingRequest, onAction)
                : (pendingRequest.state === 'malformed' ? <button className="dk-btn" disabled>无法物化（请求格式错误）</button> : null)}
            </div>
          </section>
        )}

        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">方案预览</h3>
          {planPath === undefined ? (
            <p className="dk-empty">尚无方案产物</p>
          ) : plan === null || plan.state === 'loading' ? (
            <p className="dk-empty">加载中…</p>
          ) : plan.state === 'error' ? (
            <p className="dk-card-error">方案读取失败：{plan.error}</p>
          ) : (
            <>
              <p className="dk-card-path">{planPath}</p>
              <Markdown text={plan.text ?? ''} />
            </>
          )}
        </section>

        <section className="dk-detail-section">
          <div className="dk-detail-heading-row">
            <h3 className="dk-detail-heading">子任务({tasks.length + archivedTasks.length})</h3>
            {tasks.length + archivedTasks.length > 0 && (
              <div className="dk-view-toggle">
                <button
                  className={tasksView === 'list' ? 'dk-btn dk-btn-primary' : 'dk-btn'}
                  onClick={() => { setTasksView('list') }}
                >列表</button>
                <button
                  className={tasksView === 'graph' ? 'dk-btn dk-btn-primary' : 'dk-btn'}
                  onClick={() => { setTasksView('graph') }}
                >依赖图</button>
              </div>
            )}
          </div>
          {archiveLoadError !== undefined && (
            <p className="dk-hint">归档条目读取失败，当前仅显示活跃项。</p>
          )}
          {tasks.length + archivedTasks.length === 0 ? <p className="dk-empty">尚无子任务</p> : tasksView === 'graph' ? (
            <DependencyGraph tasks={graphTasks} onOpenTaskDetail={onOpenTaskDetail} />
          ) : (
            <>
              {tasks.map(task => (
                <div className="dk-detail-task" key={task.id}>
                  <div className="dk-card-meta">
                    <span className="dk-kind-badge">{KIND_LABELS[task.kind]}</span>
                    {' '}<span className="dk-kind-badge">{STATUS_LABELS[task.status]}</span>
                  </div>
                  <p className="dk-detail-task-path">{task.titlePath}</p>
                  {task.question !== undefined && <p className="dk-card-goal">❓ {task.question}</p>}
                  {task.answer !== undefined && <p className="dk-card-goal">✅ {task.answer}</p>}
                  <div className="dk-card-actions">
                    <button className="dk-btn dk-btn-ghost" onClick={() => { onOpenTaskDetail(task.id) }}>详情</button>
                    {supportsArchive && canArchiveThisLeaf(task) && archiveLeafButton(task, onAction)}
                  </div>
                </div>
              ))}
              {/* Archived rows come after the active ones: the list stays a
                  stable read of "current work first, history below". */}
              {archivedTasks.map(entry => (
                <div className="dk-detail-task dk-archive-row" key={entry.id}>
                  <div className="dk-card-meta">
                    <span className="dk-kind-badge">已归档</span>
                    {' '}<span className="dk-kind-badge">{KIND_LABELS[entry.taskKind]}</span>
                  </div>
                  <p className="dk-detail-task-path">{entry.titlePath}</p>
                  <p className="dk-hint dk-archive-time">
                    {formatTime(entry.archivedAt)}{entry.archiveNote !== undefined ? ` · ${entry.archiveNote}` : ''}
                  </p>
                  <div className="dk-card-actions">
                    {supportsArchive && (
                      <button
                        className="dk-btn dk-btn-primary"
                        onClick={() => { onAction({ kind: 'unarchive-task', projectId: entry.projectId, taskId: entry.id }) }}
                      >恢复</button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </section>

        {project.lifecycle === 'long-running' && (
          <section className="dk-detail-section">
            <h3 className="dk-detail-heading">名下子项目({childProjects.length + archivedChildren.length})</h3>
            {childProjects.length + archivedChildren.length === 0 ? <p className="dk-empty">尚无子项目</p> : (
              <>
                {childProjects.map(child => (
                  <div className="dk-detail-task" key={child.id}>
                    <div className="dk-card-meta">
                      <span className="dk-kind-badge">{STATUS_LABELS[child.status]}</span>
                    </div>
                    <p className="dk-detail-task-path">{child.title}</p>
                    <div className="dk-card-actions">
                      <button className="dk-btn dk-btn-ghost" onClick={() => { onOpenProjectDetail(child.id) }}>详情</button>
                    </div>
                  </div>
                ))}
                {archivedChildren.map(entry => (
                  <div className="dk-detail-task dk-archive-row" key={entry.id}>
                    <div className="dk-card-meta">
                      <span className="dk-kind-badge">已归档</span>
                      {' '}<span className="dk-kind-badge">{STATUS_LABELS[entry.status]}</span>
                    </div>
                    <p className="dk-detail-task-path">{entry.title}</p>
                    <p className="dk-hint dk-archive-time">
                      {formatTime(entry.archivedAt)}{entry.archiveNote !== undefined ? ` · ${entry.archiveNote}` : ''}
                    </p>
                    <div className="dk-card-actions">
                      {supportsArchive && (
                        <button
                          className="dk-btn dk-btn-ghost"
                          onClick={() => { onOpenProjectDetail(entry.id) }}
                        >详情</button>
                      )}
                      {supportsArchive && (
                        <button
                          className="dk-btn dk-btn-primary"
                          onClick={() => { onAction({ kind: 'unarchive-project', projectId: entry.id }) }}
                        >恢复</button>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
          </section>
        )}

        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">流转历史</h3>
          {project.history.length === 0 ? <p className="dk-empty">尚无流转记录</p> : (
            <ol className="dk-detail-history">
              {[...project.history].reverse().map((entry, index) => (
                <li key={index}>
                  <span className="dk-detail-history-time">{formatTime(entry.at)}</span>
                  <span className="dk-detail-history-actor">{ACTOR_LABELS[entry.actor]}</span>
                  <span>{STATUS_LABELS[entry.from]} → {STATUS_LABELS[entry.to]}</span>
                  {entry.note !== undefined && <span className="dk-detail-history-note">{entry.note}</span>}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">操作</h3>
          <div className="dk-card-actions">
            {project.status === 'awaiting-review' && (
              <>
                <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'confirm-plan', projectId: project.id }) }}>确认方案</button>
                <button className="dk-btn dk-btn-danger" onClick={() => { setRejecting(!rejecting) }}>{rejecting ? '取消' : '驳回'}</button>
              </>
            )}
            {project.status === 'blocked' && (
              <button className="dk-btn" onClick={() => { onAction({ kind: 'transition', projectId: project.id, to: 'designing', note: 're-design from blocked' }) }}>重新设计</button>
            )}
            <button
              className="dk-btn dk-btn-ghost"
              onClick={() => { if (globalThis.confirm(`删除项目「${project.title}」？`)) onAction({ kind: 'delete-project', projectId: project.id }) }}
            >删除</button>
          </div>
          {rejecting && (
            <RejectForm
              projectId={project.id}
              onSubmit={feedback => { onAction({ kind: 'reject-plan', projectId: project.id, feedback }) }}
            />
          )}
        </section>
      </div>
    </div>
  )
}

interface TaskDetailProps {
  task: TaskNode
  projectTitle: string
  /** Titles of not-yet-done dependencies this leaf is waiting on. */
  waitingFor: string[]
  store: BoardStore
  /**「返回看板」when opened from the columns,「返回项目」when opened from a project detail. */
  backLabel: string
  /** Host capability handshake: old hosts 400 terminate/delete, so hide the buttons. */
  supportsTaskTerminateDelete: boolean
  /** Host capability handshake: old hosts 400 recover-task, so hide the buttons. */
  supportsTaskRecovery: boolean
  onBack(): void
  onAction(action: Parameters<BoardStore['apply']>[0]): void
  onOpenSession(sessionId: string): void
}

/**
 * The full-screen task detail view (same in-container switch as
 * ProjectDetail). Six sections: basic info, the clarify Q&A (visible in
 * every status — done leaves keep their question/answer as the context
 * basis for downstream execute leaves), an artifact preview (same
 * three-state on-demand fetch as the plan preview), pending dependencies,
 * the task-level transition history, and the same status-specific actions
 * as the card.
 */
function TaskDetail({ task, projectTitle, waitingFor, store, backLabel, supportsTaskTerminateDelete, supportsTaskRecovery, onBack, onAction, onOpenSession }: TaskDetailProps): JSX.Element {
  const [answerDraft, setAnswerDraft] = useState('')
  const { openError, open } = useOpenSession(onOpenSession)
  const [artifact, setArtifact] = useState<{ state: 'loading' | 'loaded' | 'error'; text?: string; error?: string } | null>(null)
  const artifactPath = task.artifactPath

  // Same fetch-on-demand pattern as the project plan preview: the artifact
  // stays out of the snapshot and rides the /kanban/file route.
  useEffect(() => {
    if (artifactPath === undefined) {
      setArtifact(null)
      return
    }
    let cancelled = false
    setArtifact({ state: 'loading' })
    store.readFile(artifactPath).then(
      text => { if (!cancelled) setArtifact({ state: 'loaded', text }) },
      (error: unknown) => { if (!cancelled) setArtifact({ state: 'error', error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { cancelled = true }
  }, [artifactPath, store])

  const handleOpenSession = (): void => { open(task.sessionId!) }

  return (
    <div className="dk-detail">
      <header className="dk-header">
        <h2 className="dk-title">{task.titlePath.split(' > ').at(-1)}</h2>
        <button className="dk-btn" onClick={onBack}>{backLabel}</button>
      </header>
      <div className="dk-detail-body">
        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">基本信息</h3>
          <dl className="dk-detail-grid">
            <dt>标题路径</dt><dd>{task.titlePath}</dd>
            <dt>类型</dt><dd><span className="dk-kind-badge">{KIND_LABELS[task.kind]}</span></dd>
            <dt>状态</dt><dd><span className="dk-kind-badge">{STATUS_LABELS[task.status]}</span></dd>
            <dt>所属项目</dt><dd>{projectTitle !== '' ? projectTitle : '（项目已删除）'}</dd>
            <dt>创建时间</dt><dd>{formatTime(task.createdAt)}</dd>
            <dt>更新时间</dt><dd>{formatTime(task.updatedAt)}</dd>
            <dt>最近活动</dt><dd>{formatTime(task.lastActivityAt)}</dd>
            <dt>会话</dt>
            <dd>
              {task.sessionId !== undefined
                ? <button className="dk-btn dk-btn-ghost" onClick={handleOpenSession}>打开会话</button>
                : '无会话'}
            </dd>
          </dl>
          {openError !== null && <p className="dk-card-error">无法打开会话：{openError}</p>}
        </section>

        {task.status === 'blocked' && task.lastFailure !== undefined && (
          <section className="dk-detail-section">
            <h3 className="dk-detail-heading">最近失败</h3>
            <dl className="dk-failure-grid">
              <dt>归类</dt><dd>{task.lastFailure.cause}</dd>
              {task.lastFailure.reason !== undefined && (<><dt>结束原因</dt><dd>{task.lastFailure.reason}</dd></>)}
              {task.lastFailure.code !== undefined && (<><dt>错误码</dt><dd>{task.lastFailure.code}</dd></>)}
              {task.lastFailure.status !== undefined && (<><dt>HTTP</dt><dd>{task.lastFailure.status}</dd></>)}
              <dt>消息</dt><dd>{task.lastFailure.message}</dd>
              {task.lastFailure.turn !== undefined && (<><dt>turn</dt><dd>{task.lastFailure.turn}</dd></>)}
              {task.lastFailure.seq !== undefined && (<><dt>seq</dt><dd>{task.lastFailure.seq}</dd></>)}
              {task.lastFailure.sessionId !== undefined && (<><dt>会话</dt><dd><code>{task.lastFailure.sessionId}</code></dd></>)}
              <dt>依据时间</dt><dd>{formatTime(task.lastFailure.at)}</dd>
            </dl>
            <p className="dk-hint">
              {task.lastFailure.recoverable
                ? '该失败可能可恢复：建议先「恢复」重新判定'
                : '会话已不存在，无法重新判定；建议「重新排队」或删除该任务'}
            </p>
          </section>
        )}

        {task.kind === 'clarify' && (
          <section className="dk-detail-section">
            <h3 className="dk-detail-heading">澄清问答</h3>
            {task.question !== undefined
              ? <p className="dk-detail-qa">❓ {task.question}</p>
              : <p className="dk-empty">尚无问题</p>}
            {task.answer !== undefined
              ? <p className="dk-detail-qa">✅ {task.answer}</p>
              : <p className="dk-empty">尚未回答</p>}
          </section>
        )}

        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">产物预览</h3>
          {artifactPath === undefined ? (
            <p className="dk-empty">尚无产物</p>
          ) : artifact === null || artifact.state === 'loading' ? (
            <p className="dk-empty">加载中…</p>
          ) : artifact.state === 'error' ? (
            <p className="dk-card-error">产物读取失败：{artifact.error}</p>
          ) : (
            <>
              <p className="dk-card-path">{artifactPath}</p>
              <Markdown text={artifact.text ?? ''} />
            </>
          )}
        </section>

        {waitingFor.length > 0 && (
          <section className="dk-detail-section">
            <h3 className="dk-detail-heading">依赖</h3>
            <p className="dk-card-waiting">⏳ 等待依赖完成：{waitingFor.join('、')}</p>
          </section>
        )}

        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">流转历史</h3>
          {task.history.length === 0 ? <p className="dk-empty">尚无流转记录</p> : (
            <ol className="dk-detail-history">
              {[...task.history].reverse().map((entry, index) => (
                <li key={index}>
                  <span className="dk-detail-history-time">{formatTime(entry.at)}</span>
                  <span className="dk-detail-history-actor">{ACTOR_LABELS[entry.actor]}</span>
                  <span>{STATUS_LABELS[entry.from]} → {STATUS_LABELS[entry.to]}</span>
                  {entry.note !== undefined && <span className="dk-detail-history-note">{entry.note}</span>}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">操作</h3>
          {task.kind === 'clarify' && task.status === 'awaiting-clarification' && (
            <div className="dk-reject">
              <textarea
                placeholder="回答这个问题（会作为后续执行任务的上下文）"
                value={answerDraft}
                onChange={event => { setAnswerDraft(event.target.value) }}
              />
              <div className="dk-card-actions">
                <button
                  className="dk-btn dk-btn-primary"
                  disabled={answerDraft.trim() === ''}
                  onClick={() => {
                    onAction({ kind: 'answer-clarification', projectId: task.projectId, taskId: task.id, answer: answerDraft.trim() })
                    setAnswerDraft('')
                  }}
                >提交回答</button>
              </div>
            </div>
          )}
          <div className="dk-card-actions">
            {supportsTaskRecovery && task.status === 'blocked' && task.recovery === undefined && task.sessionId !== undefined && (
              <button
                className="dk-btn"
                onClick={() => { onAction({ kind: 'recover-task', projectId: task.projectId, taskId: task.id, strategy: 'reinspect' }) }}
              >重新判定并恢复</button>
            )}
            {supportsTaskRecovery && task.status === 'blocked' && task.recovery === undefined && (
              <button
                className="dk-btn"
                onClick={() => {
                  if (!globalThis.confirm('重新排队会新建会话重新执行该任务，确定？')) return
                  onAction({ kind: 'recover-task', projectId: task.projectId, taskId: task.id, strategy: 'requeue' })
                }}
              >重新排队执行</button>
            )}
            {task.recovery !== undefined && <span className="dk-hint">⏳ 恢复判定中…</span>}
            {task.kind === 'clarify' && task.status === 'awaiting-review' && (
              <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'confirm-task', projectId: task.projectId, taskId: task.id }) }}>确认回答</button>
            )}
            {task.kind === 'design' && task.status === 'awaiting-review' && (
              <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'confirm-task', projectId: task.projectId, taskId: task.id }) }}>确认设计</button>
            )}
            {task.sessionId !== undefined && (
              <button className="dk-btn dk-btn-ghost" onClick={handleOpenSession}>打开会话</button>
            )}
            {supportsTaskTerminateDelete && (task.status === 'designing' || task.status === 'executing') && (
              <button
                className="dk-btn dk-btn-ghost"
                onClick={() => { onAction({ kind: 'terminate-task', projectId: task.projectId, taskId: task.id }) }}
              >终止</button>
            )}
            {supportsTaskTerminateDelete && (
              <button
                className="dk-btn dk-btn-ghost"
                onClick={() => {
                  if (!globalThis.confirm(`删除任务「${task.titlePath.split(' > ').at(-1)}」？`)) return
                  onAction({ kind: 'delete-task', projectId: task.projectId, taskId: task.id })
                  // The task is gone after a delete; fall back like the project detail does.
                  onBack()
                }}
              >删除</button>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

/** Heading tag per markdown level; downshifted two steps because the view already has h2/h3 chrome. */
const HEADING_TAGS = ['h4', 'h5', 'h6', 'h6', 'h6', 'h6'] as const
/** Inline subset: `code` and **bold**. Everything else stays literal text. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)/g
  let last = 0
  let key = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('`')) nodes.push(<code key={key++}>{token.slice(1, -1)}</code>)
    else nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/**
 * Zero-dependency markdown subset renderer (confirmed by the creator over a
 * monospace dump): fenced code blocks, headings, unordered/ordered lists,
 * paragraphs, plus the inline subset above. React text nodes do the HTML
 * escaping — no dangerouslySetInnerHTML anywhere.
 */
function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  let key = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') { index++; continue }
    if (line.startsWith('```')) {
      const code: string[] = []
      index++
      while (index < lines.length && !lines[index].startsWith('```')) { code.push(lines[index]); index++ }
      index++ // skip the closing fence (or run off the end)
      blocks.push(<pre key={key++} className="dk-md-code"><code>{code.join('\n')}</code></pre>)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const Tag = HEADING_TAGS[heading[1].length - 1]
      blocks.push(<Tag key={key++}>{renderInline(heading[2])}</Tag>)
      index++
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''))
        index++
      }
      blocks.push(<ul key={key++}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''))
        index++
      }
      blocks.push(<ol key={key++}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ol>)
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() !== '') { paragraph.push(lines[index]); index++ }
    blocks.push(<p key={key++}>{renderInline(paragraph.join(' '))}</p>)
  }
  return <div className="dk-md">{blocks}</div>
}

function RejectForm({ projectId, onSubmit }: { projectId: string; onSubmit(feedback: string): void }): JSX.Element {
  const [feedback, setFeedback] = useState('')
  return (
    <div className="dk-reject">
      <textarea
        placeholder="驳回原因 / 修改要求（会作为反馈发给设计 agent）"
        value={feedback}
        onChange={event => { setFeedback(event.target.value) }}
      />
      <div className="dk-card-actions">
        <button className="dk-btn dk-btn-danger" disabled={feedback.trim() === ''} onClick={() => { onSubmit(feedback.trim()) }}>提交驳回</button>
      </div>
    </div>
  )
}

export interface NewProjectInput {
  title: string
  /**
   * Omitted on an affiliated create against an inheritance-capable host —
   * the host fills it with the parent's directory (a stale snapshot value
   * would only risk inconsistency).
   */
  workspaceDir?: string
  goal: string
  /** 'long-running' creates a long-running board container; absent means one-shot. */
  lifecycle?: 'long-running'
  /** Optional affiliation to an existing long-running project (one-shot only). */
  parentId?: string
}

/** One option of the modal's「关联长期项目」select (id + display title + the dir an affiliated child would inherit). */
export interface ParentOption {
  id: string
  title: string
  workspaceDir: string
}

function NewProjectModal({ getDefaultWorkspaceDir, supportsLongRunning, supportsParentInheritance, parents, onCancel, onCreate }: {
  getDefaultWorkspaceDir(): string
  /**
   * Whether the running host declared the long-running-projects capability.
   * When false the「项目类型」radio and the affiliation select are hidden so
   * the form can only submit a plain one-shot create — exactly what an old
   * host understands (its parser silently drops unknown fields).
   */
  supportsLongRunning: boolean
  /**
   * Whether the running host declared the parent-workspace-inheritance
   * capability. When true, selecting a parent replaces the dir input with a
   * read-only inheritance hint and the submit omits workspaceDir; when false
   * (older host), selecting a parent merely pre-fills the (still editable)
   * dir input with the parent's directory — a plain old-protocol create.
   */
  supportsParentInheritance: boolean
  /** The snapshot's long-running projects, offered as affiliation targets. */
  parents: ParentOption[]
  onCancel(): void
  onCreate(input: NewProjectInput): void
}): JSX.Element {
  // Evaluated when the modal opens: the workspace list may not have been
  // ready when the board mounted, so the default must be read live.
  const [title, setTitle] = useState('')
  const [workspaceDir, setWorkspaceDir] = useState(() => getDefaultWorkspaceDir())
  // Tracks whether the user hand-edited the dir input: the old-host parent
  // pre-fill only overwrites an untouched (default) value, never user input.
  const [dirEdited, setDirEdited] = useState(false)
  const [goal, setGoal] = useState('')
  const [longRunning, setLongRunning] = useState(false)
  const [parentId, setParentId] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const affiliated = !longRunning && parentId !== ''
  const selectedParent = affiliated ? parents.find(parent => parent.id === parentId) : undefined
  const inheritsDir = affiliated && supportsParentInheritance
  const valid = title.trim() !== '' && goal.trim() !== '' && (inheritsDir || workspaceDir.trim() !== '')

  const submit = (): void => {
    if (!valid) {
      // A disabled button looks exactly like an enabled one in this skin;
      // always accept the click and explain why nothing was created.
      setSubmitError(inheritsDir ? '请填写项目名称和目标' : '请填写项目名称、工作目录和目标')
      return
    }
    // Omit the optional keys entirely when unset so the action envelope
    // stays byte-identical to a pre-feature one-shot create. An affiliated
    // create against an inheritance-capable host also omits workspaceDir:
    // the host is the source of truth for the inherited directory.
    onCreate({
      title: title.trim(),
      ...(inheritsDir ? {} : { workspaceDir: workspaceDir.trim() }),
      goal: goal.trim(),
      ...(longRunning ? { lifecycle: 'long-running' as const } : {}),
      ...(affiliated ? { parentId } : {}),
    })
  }

  return (
    <div className="dk-modal-overlay" onClick={onCancel}>
      <div className="dk-modal" onClick={event => { event.stopPropagation() }}>
        <h3 style={{ margin: 0, fontSize: '15px' }}>新建项目</h3>
        {supportsLongRunning && (
          <div className="dk-field">
            <label>项目类型</label>
            <div className="dk-radio-row">
              <label>
                <input type="radio" name="dk-lifecycle" checked={!longRunning} onChange={() => { setLongRunning(false); setSubmitError(null) }} />
                一次性项目
              </label>
              <label>
                <input type="radio" name="dk-lifecycle" checked={longRunning} onChange={() => { setLongRunning(true); setSubmitError(null) }} />
                长期执行中的项目
              </label>
            </div>
          </div>
        )}
        <div className="dk-field">
          <label htmlFor="dk-title">项目名称</label>
          <input id="dk-title" value={title} placeholder="例如：重构看板后端" onChange={event => { setTitle(event.target.value); setSubmitError(null) }} />
        </div>
        {inheritsDir ? (
          <div className="dk-field">
            <label>工作目录（agent 在此执行）</label>
            <p className="dk-card-goal">将使用父项目的目录 <code>{selectedParent?.workspaceDir ?? ''}</code></p>
          </div>
        ) : (
          <div className="dk-field">
            <label htmlFor="dk-workspace">工作目录（agent 在此执行）</label>
            <input id="dk-workspace" value={workspaceDir} placeholder="/path/to/workspace" onChange={event => { setWorkspaceDir(event.target.value); setDirEdited(true); setSubmitError(null) }} />
          </div>
        )}
        <div className="dk-field">
          <label htmlFor="dk-goal">项目目标（一句话）</label>
          <input id="dk-goal" value={goal} placeholder="例如：把任务看板的后端迁移到 SQLite" onChange={event => { setGoal(event.target.value); setSubmitError(null) }} />
        </div>
        {supportsLongRunning && !longRunning && (
          <div className="dk-field">
            <label htmlFor="dk-parent">关联长期项目（可选）</label>
            <select
              id="dk-parent"
              value={parentId}
              onChange={event => {
                const next = event.target.value
                setParentId(next)
                setSubmitError(null)
                // Old-host fallback: without the inheritance capability the
                // dir input stays visible and required, so pre-fill it with
                // the parent's directory (still editable — the submit then
                // is a plain old-protocol create the host accepts as-is).
                // Never clobber a dir the user typed by hand.
                if (!supportsParentInheritance && next !== '' && !dirEdited) {
                  const parent = parents.find(candidate => candidate.id === next)
                  if (parent !== undefined) setWorkspaceDir(parent.workspaceDir)
                }
              }}
            >
              <option value="">不关联</option>
              {parents.map(parent => <option key={parent.id} value={parent.id}>{parent.title}</option>)}
            </select>
          </div>
        )}
        {submitError !== null && <p className="dk-modal-error">{submitError}</p>}
        <div className="dk-modal-actions">
          <button className="dk-btn" onClick={onCancel}>取消</button>
          <button className="dk-btn dk-btn-primary" onClick={submit}>{longRunning ? '创建长期项目' : '创建并开始设计'}</button>
        </div>
      </div>
    </div>
  )
}
