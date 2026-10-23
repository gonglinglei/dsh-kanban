/**
 * Kanban host service: the ledger's single writer. Owns the project list,
 * the decomposed task leaves, the state machine, persistence, SSE broadcast,
 * and the stale timer.
 *
 * The browser is a same-origin asynchronous view over this service (the
 * dsh-web-ui task-board pattern, Apache-2.0): every mutation goes through
 * one of the apply* methods below, bumps revision/version, persists, and
 * broadcasts the new snapshot to /events subscribers.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { DecompositionError, flattenDecomposition, loadDecomposition, parseDecomposition, type TaskLeaf } from './decomposition.ts'
import { ARCHIVE_NOTE_MAX, HOST_CAPABILITIES, MS_PER_DAY, PENDING_ITEMS_MAX, PENDING_PROBLEMS_MAX, archivedProjectIds, isArchived, isLeafHidden } from './protocol.ts'
import type {
  Actor, ArchiveEntry, FailureDiagnostic, KanbanEventPayload, KanbanSnapshot, PendingAddition, PendingAdditionItem,
  PendingAdditionProblem, Project, ProjectStatus, RecoveryStrategy, TaskKind, TaskNode,
} from './protocol.ts'
import {
  DECOMPOSITION_FILE, TASK_ADDITIONS_FILE, classifyTaskAdditionsFile, decompositionPathFor, failureDiagnostic,
  isActionableTaskAdditionsStage, pendingAdditionsFileNames, projectDir, taskArtifactPath, uniqueTaskAdditionsName,
  type TaskAdditionsFileRef, type TaskAdditionsTerminalStage,
} from './session-runner.ts'
import { assertTransitionAllowed, TransitionError } from './state-machine.ts'
import { emptyState, loadState, saveState, type PersistedState } from './storage.ts'

/** Stale-timer tick cadence (seconds); the check is a no-op when maxStaleMinutes is 0. */
const STALE_TICK_SECONDS = 30

/** The design agent's decomposition file name (inside the per-project artifact dir). */
export { DECOMPOSITION_FILE }

/** Per-file size ceiling for readProjectFile (the detail view's plan preview). */
export const PROJECT_FILE_LIMIT = 512 * 1024

/**
 * How long a freshly written request must sit unchanged before the ingest
 * freezes it. The agent's `write` replaces the whole file, so a 5-second poll
 * could otherwise read a half-written body and mis-report a healthy node's
 * request as malformed. A staged (already-renamed) file is immutable and
 * needs no settling.
 */
const ADDITIONS_SETTLE_MS = 1_500

/** Bounded titlePath carried per preview item (the snapshot is hot SSE data). */
const PENDING_TITLE_MAX = 120

/** Bounded diagnostic message carried by a malformed pending entry. */
const PENDING_ERROR_MAX = 200

/** Safety bound on how many request files one human click may materialize. */
const MAX_ADDITIONS_BATCHES = 32

/** Throttle for the additions consistency diagnostics (a 5s poll must never amplify ledger writes). */
const ADDITIONS_DIAGNOSTIC_THROTTLE_MS = 10 * 60_000

/** One request file found on disk, with the identity the host derives from it. */
interface AdditionsFile {
  ref: TaskAdditionsFileRef
  /** Absolute path. */
  path: string
  /** Effective mtime in epoch millis (the staged name embeds it; the fresh slot is stat'ed). */
  mtimeMs: number
}

/** The read-only result of parsing one request file (a malformed body is a value, not a throw). */
interface AdditionsRead {
  leaves: TaskLeaf[]
  error?: string
}

/**
 * The spawner's read-only view of one project's not-yet-materialized requests.
 * Produced by `peekAdditions`, consumed by the snapshot cache and the human
 * entry. `state: 'malformed'` is deliberately a shaped result, never
 * `undefined`: a node that already left the observation window has no code
 * path left that would throw, so a parse failure must be visible HERE.
 *
 * The parse failures are carried as a LIST (`malformed`) instead of only the
 * primary file's `error`: one broken batch must neither hide nor be hidden by
 * the healthy batches sitting next to it.
 */
export interface AdditionsProbe {
  state: 'ready' | 'malformed'
  /** The primary request file's basename (what the badge shows as the source). */
  file: string
  /** The oldest aggregated request's mtime (epoch millis). */
  at: number
  /** How many request files this probe aggregated (broken ones included). */
  batches: number
  /** How many leaves those files would materialize in total. */
  count: number
  /** Bounded preview of the leaves (at most PENDING_ITEMS_MAX). */
  items: PendingAdditionItem[]
  /** The aggregated request files that cannot be parsed (possibly empty). */
  malformed: PendingAdditionProblem[]
  /** Parse/read failure of the primary file (present only when malformed). */
  error?: string
}

/** One planned (not yet committed) request batch. */
interface PlannedAdditionsBatch {
  file: AdditionsFile
  pending: TaskNode[]
  skipped: string[]
}

/** The pure plan of one consumption: every batch plus the merged leaf list. */
interface PlannedAdditions {
  batches: PlannedAdditionsBatch[]
  pending: TaskNode[]
  skipped: string[]
}

/**
 * A batch that PARSES but cannot be planned (unknown dependency, duplicate
 * title / cycle). It is quarantined instead of retried forever.
 */
interface UnplannableAdditionsBatch {
  file: AdditionsFile
  error: string
}

/** A batch whose body cannot even be parsed. The host leaves it in place for diagnosis. */
interface BrokenAdditionsBatch {
  file: AdditionsFile
  error: string
}

/** The pure outcome of planning every actionable batch of one project. */
interface PlannedHumanAdditions {
  batches: PlannedAdditionsBatch[]
  pending: TaskNode[]
  skipped: string[]
  broken: BrokenAdditionsBatch[]
  unplannable: UnplannableAdditionsBatch[]
}

/** What `materializePendingAdditions` did, for the action response and the tests. */
export interface MaterializeAdditionsResult {
  created: TaskNode[]
  skipped: string[]
  /** The request files that were consumed (basenames, after the audit rename). */
  consumed: string[]
  /** The requests that parsed but could not be planned; quarantined as `*.failed.json`. */
  failed: PendingAdditionProblem[]
  /** The requests that could not even be parsed; left in place for diagnosis. */
  broken: PendingAdditionProblem[]
  /** Whether the project had to be re-opened (done / blocked → executing). */
  reopened: boolean
  project: Project
}

/** What `discardPendingAdditions` did: the requests a human threw away. */
export interface DiscardAdditionsResult {
  /** The parked request files (basenames, after the `.discarded` rename). */
  discarded: DiscardedAdditionsFile[]
  project: Project
}

/** One request file a human threw away: its terminal basename plus the source mtime. */
export interface DiscardedAdditionsFile {
  file: string
  at: number
}

export interface CreateProjectInput {
  title: string
  /**
   * Working directory the agents execute in. Optional only when parentId is
   * set — an affiliated one-shot project inherits its parent's directory and
   * any caller-supplied value is ignored (the host is the single source of
   * truth for the affiliation/directory invariant).
   */
  workspaceDir?: string
  goal: string
  /** 'long-running' creates a long-running board container; absent means one-shot. */
  lifecycle?: 'long-running'
  /** Affiliation to an existing long-running project (one-shot projects only). */
  parentId?: string
}

/** Hook fired when a project enters designing; the spawner wires sessions here. */
export type OnEnterDesigning = (project: Project) => void

/** Hook fired when a project enters executing; the spawner wires sessions here. */
export type OnEnterExecuting = (project: Project) => void

/** Hook fired when a task leaf enters designing (research/design leaves). */
export type OnEnterTaskDesigning = (task: TaskNode) => void

/** Hook fired when a task leaf enters executing (execute leaves). */
export type OnEnterTaskExecuting = (task: TaskNode) => void

/**
 * Hook fired (fire-and-forget) to cancel a session's active turn; the
 * spawner wires runner.cancelSession here. Best-effort: failures are
 * swallowed downstream, the board state change commits regardless.
 */
export type OnCancelSession = (sessionId: string) => void

export class KanbanHostService {
  private state: PersistedState = emptyState()
  private readonly listeners = new Set<(payload: KanbanEventPayload) => void>()
  private staleTimer: NodeJS.Timeout | undefined
  private maxStaleMinutes = 0
  /**
   * Automatic archiving phase. `archiveAfterDays <= 0` disables it and the
   * timer does not exist at all; like the stale timer it is armed outside
   * `ctx.effect` and torn down by `dispose()`.
   */
  private archiveTimer: NodeJS.Timeout | undefined
  private archiveAfterDays = 0
  private archiveSweepMinutes = 0
  private archiveDoneTaskLeaves = true
  /** Whether the ledger is loaded, and whether the one startup catch-up already ran. */
  private ledgerLoaded = false
  private archiveCaughtUp = false
  /**
   * The published pending-additions entries, keyed by project. Assembly-only:
   * refreshed by the spawner's scan phase, NEVER written to the ledger (the
   * same contract as `capabilities`), so an unchanged probe on a 5-second
   * poll is a complete no-op.
   */
  private readonly pendingAdditions = new Map<string, PendingAddition>()
  /** Malformed request versions already recorded in the history (`projectId:file:mtime`). */
  private readonly malformedNoted = new Set<string>()
  /** Throttle clock for the additions consistency diagnostics, keyed by scope. */
  private readonly additionsDiagnosticAt = new Map<string, number>()
  private onEnterDesigning: OnEnterDesigning = () => {}
  private onEnterExecuting: OnEnterExecuting = () => {}
  private onEnterTaskDesigning: OnEnterTaskDesigning = () => {}
  private onEnterTaskExecuting: OnEnterTaskExecuting = () => {}
  private onCancelSession: OnCancelSession = () => {}

  constructor(private readonly file: string) {}

  /** Load the ledger from disk (synchronous: boot must see the persisted board). */
  start(): void {
    this.state = loadState(this.file)
    this.ledgerLoaded = true
    // A periodic phase cannot rely on the host having been online when a record
    // came due, so boot catches up once. One sweep is enough no matter how long
    // the host was down: eligibility is a pure function of `updatedAt` and
    // `now`, never of "how many ticks were missed".
    this.maybeArchiveCatchUp()
  }

  /** Tear down the stale/archive timers and listeners. */
  dispose(): void {
    if (this.staleTimer !== undefined) clearInterval(this.staleTimer)
    this.staleTimer = undefined
    if (this.archiveTimer !== undefined) clearInterval(this.archiveTimer)
    this.archiveTimer = undefined
    this.listeners.clear()
  }

  /** Arm the stale timer with a new threshold; 0 disarms it. */
  setMaxStaleMinutes(minutes: number): void {
    this.maxStaleMinutes = minutes
    if (this.staleTimer !== undefined) {
      clearInterval(this.staleTimer)
      this.staleTimer = undefined
    }
    if (minutes <= 0) return
    this.staleTimer = setInterval(() => this.checkStale(), STALE_TICK_SECONDS * 1000)
  }

  /**
   * Arm the automatic archive phase and, when the ledger is already loaded,
   * run the startup catch-up immediately.
   *
   * The shape deliberately mirrors `setMaxStaleMinutes` (disarm first, non-
   * positive values disarm), except that the sweep cadence IS the window
   * precision: the product delay is measured in days, so a fixed tick plus a
   * threshold would buy nothing and cost one more piece of state.
   */
  setArchivePolicy(policy: { afterDays: number; sweepMinutes: number; doneTaskLeaves?: boolean }): void {
    this.archiveAfterDays = policy.afterDays
    this.archiveSweepMinutes = policy.sweepMinutes
    this.archiveDoneTaskLeaves = policy.doneTaskLeaves ?? true
    this.armArchiveTimer()
    this.maybeArchiveCatchUp()
  }

  /** (Re)arm the sweep timer; a disabled policy leaves no timer behind. */
  private armArchiveTimer(): void {
    if (this.archiveTimer !== undefined) {
      clearInterval(this.archiveTimer)
      this.archiveTimer = undefined
    }
    // `setInterval(fn, 0)` would spin the event loop, so a non-positive cadence
    // must disarm explicitly (the config schema's min(15) is not the only
    // caller: tests and programmatic callers reach this directly).
    if (this.archiveAfterDays <= 0 || this.archiveSweepMinutes <= 0) return
    this.archiveTimer = setInterval(() => this.runArchiveSweep(Date.now()), this.archiveSweepMinutes * 60_000)
  }

  /**
   * The startup catch-up, callable from either order of `start()` /
   * `setArchivePolicy()`: it runs once, as soon as both the ledger and a
   * positive window are known. It must complete BEFORE the spawner's restart
   * replay loop, which is why it runs synchronously here.
   */
  private maybeArchiveCatchUp(): void {
    if (!this.ledgerLoaded || this.archiveCaughtUp) return
    if (this.archiveAfterDays <= 0) return
    this.archiveCaughtUp = true
    // Boot must never fail because of a background phase: the catch-up shares
    // the timer's "log, never throw" wrapper.
    this.runArchiveSweep(Date.now())
  }

  /** Last line of defence for the timer: an exception must never escape into the event loop. */
  private runArchiveSweep(now: number): void {
    try {
      this.archiveSweep(now)
    } catch (error) {
      console.error('[dsh-kanban] archive sweep failed', error)
    }
  }

  /** The spawner wires its phase hooks here. */
  setSpawnHooks(hooks: {
    onEnterDesigning: OnEnterDesigning
    onEnterExecuting: OnEnterExecuting
    onEnterTaskDesigning: OnEnterTaskDesigning
    onEnterTaskExecuting: OnEnterTaskExecuting
  }): void {
    this.onEnterDesigning = hooks.onEnterDesigning
    this.onEnterExecuting = hooks.onEnterExecuting
    this.onEnterTaskDesigning = hooks.onEnterTaskDesigning
    this.onEnterTaskExecuting = hooks.onEnterTaskExecuting
  }

  /** The spawner wires its session-cancel callback here (default no-op). */
  setSessionCanceller(cb: OnCancelSession): void {
    this.onCancelSession = cb
  }

  /**
   * Fire-and-forget cancel of an attached session (project or task leaf).
   * The callback itself is best-effort; terminate/delete/deleteProject call
   * this before their ledger mutation so a live agent turn stops ASAP.
   */
  private cancelAttached(sessionId: string | undefined): void {
    if (sessionId === undefined) return
    try {
      this.onCancelSession(sessionId)
    } catch {
      // A throwing hook never blocks the board operation.
    }
  }

  /** Record which session drives a project (metadata commit; no status change). */
  attachSession(projectId: string, sessionId: string, role: 'design' | 'execute'): Project {
    const project = this.requireProject(projectId)
    project.sessionId = sessionId
    project.sessionRole = role
    this.commit(project, 'system', project.status, project.status, `session attached (${role})`)
    return this.requireProject(projectId)
  }

  /** Record which session drives a task leaf (metadata commit; no status change). */
  attachTaskSession(taskId: string, sessionId: string, role: 'research' | 'design' | 'execute'): TaskNode {
    const task = this.requireTask(taskId)
    task.sessionId = sessionId
    task.sessionRole = role
    this.taskCommit(task, 'system', task.status, task.status, `session attached (${role})`)
    return this.requireTask(taskId)
  }

  /** Re-fire the phase hooks for a project's current status (host-restart recovery). */
  refirePhaseHooks(projectId: string): void {
    const project = this.requireProject(projectId)
    if (project.status === 'designing') this.onEnterDesigning(project)
    if (project.status === 'executing') this.onEnterExecuting(project)
  }

  /**
   * Re-fire the phase hooks for a task leaf's current status (host-restart recovery).
   * A leaf in a recovery window is exempt: it must be re-judged by the poll
   * (its session may already have finished), never blindly re-prompted.
   */
  refireTaskPhaseHooks(taskId: string): void {
    const task = this.requireTask(taskId)
    if (task.recovery !== undefined) return
    if (task.status === 'designing') this.onEnterTaskDesigning(task)
    if (task.status === 'executing') this.onEnterTaskExecuting(task)
  }

  /**
   * The board VIEW over the ledger: archived records are filtered out and the
   * archive is reported as two counts.
   *
   * Read discipline: every eligibility judgement inside the host reads the RAW
   * ledger (`this.state`); only this view (and the on-demand archive read)
   * knows about archiving. Turning the view into a business input is exactly
   * how an archived project would silently stop being observed.
   */
  snapshot(): KanbanSnapshot {
    // Capabilities are assembled fresh from the running build (never read
    // from the ledger), so a restarted host on new code immediately
    // re-declares what it supports — the version-mismatch handshake.
    // `pendingAdditions` follows the same rule: it is a view over files on
    // disk, rebuilt by the spawner's scan phase, and it must never leak a
    // badge for a project that no longer exists.
    //
    // Hygiene stays keyed on the RAW ledger on purpose: an archived project
    // keeps its published entry, otherwise the request that makes it visible
    // again (see `hiddenProjects` below) could never be re-published.
    const live = new Set(this.state.projects.map(project => project.id))
    for (const projectId of [...this.pendingAdditions.keys()]) {
      if (!live.has(projectId)) this.pendingAdditions.delete(projectId)
    }

    const archivedProjects = archivedProjectIds(this.state.projects)
    // A live task-additions request outranks the archive: the request has to
    // stay visible and actionable, and it is published by the spawner's poll
    // (which reads the raw ledger). Re-surfacing brings the project AND its
    // leaves back for as long as the request is pending — the ledger marker is
    // untouched, so the project returns to the archive once the request is gone.
    const hiddenProjects = new Set(archivedProjects)
    for (const projectId of archivedProjects) {
      if (this.pendingAdditions.has(projectId)) hiddenProjects.delete(projectId)
    }

    const projects: Project[] = []
    for (const project of this.state.projects) {
      if (hiddenProjects.has(project.id)) continue
      projects.push(project)
    }
    const visibleProjects = new Set(projects.map(project => project.id))

    const tasks: TaskNode[] = []
    let archivedTasks = 0
    for (const task of this.state.tasks) {
      if (isArchived(task)) {
        // A leaf only counts as its own archive entry while its project is
        // visible; otherwise the project entry already implies it (the same
        // rule the archive read and `archivedCounts` use).
        if (!archivedProjects.has(task.projectId)) archivedTasks += 1
        continue
      }
      if (isLeafHidden(task, hiddenProjects)) continue
      if (!visibleProjects.has(task.projectId)) continue
      tasks.push(task)
    }

    return {
      revision: this.state.revision,
      projects,
      tasks,
      capabilities: [...HOST_CAPABILITIES],
      // Referential integrity: never publish a badge whose project is not in
      // this snapshot (a dangling badge would have nothing to open).
      pendingAdditions: [...this.pendingAdditions.values()].filter(entry => visibleProjects.has(entry.projectId)),
      archivedCounts: { projects: archivedProjects.size, tasks: archivedTasks },
    }
  }

  eventPayload(): KanbanEventPayload {
    return this.snapshot()
  }

  subscribe(listener: (payload: KanbanEventPayload) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getProject(projectId: string): Project | undefined {
    return this.state.projects.find(project => project.id === projectId)
  }

  getTask(taskId: string): TaskNode | undefined {
    return this.state.tasks.find(task => task.id === taskId)
  }

  /**
   * Every project id in the RAW ledger, archived ones included.
   *
   * The spawner publishes pending requests through this list instead of the
   * snapshot: publishing is an observation of the filesystem, not a decision
   * about what the board shows, and an archived project must still be able to
   * advertise a request that arrived after it was archived.
   */
  projectIds(): string[] {
    return this.state.projects.map(project => project.id)
  }

  /** All task leaves of one project. */
  projectTasks(projectId: string): TaskNode[] {
    return this.state.tasks.filter(task => task.projectId === projectId)
  }

  /**
   * Read a utf-8 text artifact (e.g. plan.md) for the detail view. The path
   * must resolve inside some project's workspaceDir — the whitelist that
   * keeps this route from becoming an arbitrary file read. Throws Error with
   * a machine-readable message: path-not-absolute / path-outside-workspace /
   * file-not-found / not-a-file / file-too-large.
   */
  readProjectFile(path: string): string {
    if (!isAbsolute(path)) throw new Error('path-not-absolute')
    const normalized = resolve(path)
    const allowed = this.state.projects.some(project => {
      const root = resolve(project.workspaceDir)
      return normalized === root || normalized.startsWith(root + sep)
    })
    if (!allowed) throw new Error('path-outside-workspace')
    let stat
    try {
      stat = statSync(normalized)
    } catch {
      throw new Error('file-not-found')
    }
    if (!stat.isFile()) throw new Error('not-a-file')
    if (stat.size > PROJECT_FILE_LIMIT) throw new Error('file-too-large')
    return readFileSync(normalized, 'utf8')
  }

  /**
   * Create a project in backlog, then immediately auto-start design (system
   * actor). A long-running project instead moves straight into executing —
   * it is a pure board container: no design agent, never auto-done.
   * A one-shot project may affiliate to an existing long-running parent.
   */
  createProject(input: CreateProjectInput): Project {
    // The affiliation/directory invariant lives here and only here: a child
    // project ALWAYS runs in its parent's current workspaceDir, whatever the
    // caller passed. Downstream consumers (session cwd, artifact dirs, the
    // readProjectFile whitelist) all read project.workspaceDir, so the
    // inherited value propagates for free.
    let workspaceDir = input.workspaceDir
    let inherited = false
    if (input.parentId !== undefined) {
      if (input.lifecycle === 'long-running') {
        throw new TransitionError('long-running projects cannot belong to another project')
      }
      const parent = this.getProject(input.parentId)
      if (parent === undefined) throw new TransitionError(`unknown parent project ${input.parentId}`)
      if (parent.lifecycle !== 'long-running') {
        throw new TransitionError(`parent project ${input.parentId} is not a long-running project`)
      }
      workspaceDir = parent.workspaceDir
      inherited = true
    }
    if (workspaceDir === undefined || workspaceDir.trim() === '') {
      // Double safety: well-formed traffic is already rejected by the
      // protocol parser; a direct (non-HTTP) caller gets the same wall.
      throw new TransitionError('workspaceDir is required when the project has no parent')
    }
    const now = Date.now()
    const project: Project = {
      id: randomUUID(),
      title: input.title,
      workspaceDir,
      goal: input.goal,
      status: 'backlog',
      ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      version: 0,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      history: [],
    }
    this.state.projects.push(project)
    this.commit(project, 'system', 'backlog', 'backlog', inherited ? 'created (workspace inherited from parent)' : 'created')
    if (input.lifecycle === 'long-running') {
      // 长期项目创建: straight into long-running execution; the spawner's
      // enterExecuting guard keeps this from spawning any agent session.
      this.applyTransition(project.id, 'executing', 'system', '长期项目创建', { fireHooks: true })
      return this.requireProject(project.id)
    }
    // 新建即自动跑: the design phase starts without a human click.
    this.applyTransition(project.id, 'designing', 'system', 'auto-start design', { fireHooks: true })
    return this.requireProject(project.id)
  }

  /**
   * Human confirms the design. When the design agent also produced a
   * decomposition (tasks.json), the confirmation materializes the task
   * leaves and the project becomes a container that completes when every
   * leaf is done; otherwise the project runs the classic execute phase.
   */
  confirmPlan(projectId: string): Project {
    const project = this.requireProject(projectId)
    assertTransitionAllowed(project.status, 'executing', 'human')
    const leaves = this.loadDecompositionLeaves(project)
    // Validate BEFORE committing (half-commit fix, repro d6b241b8): a broken
    // decomposition (duplicate title path, dangling dependsOn, cycle) must
    // throw here, leaving the project exactly where it was — otherwise the
    // persisted executing status with zero leaves strands the board.
    const planned = leaves.length > 0 ? this.planTaskNodes(project, leaves) : { pending: [], skipped: [] }
    const pending = planned.pending
    this.commit(project, 'human', project.status, 'executing', pending.length > 0 ? 'plan confirmed (decomposed)' : 'plan confirmed')
    if (pending.length > 0) {
      this.commitMaterialized(project, pending, 'system')
    } else {
      this.onEnterExecuting(this.requireProject(projectId))
    }
    this.checkProjectCompletion(projectId)
    return this.requireProject(projectId)
  }

  /** Human rejects the design with feedback; back to designing (same session resumes). */
  rejectPlan(projectId: string, feedback: string): Project {
    const project = this.requireProject(projectId)
    assertTransitionAllowed(project.status, 'designing', 'human')
    project.feedback = feedback
    this.commit(project, 'human', project.status, 'designing', `rejected: ${feedback}`)
    this.onEnterDesigning(this.requireProject(projectId))
    return this.requireProject(projectId)
  }

  /** The design agent's turn ended (agent or system report). */
  reportDesignDone(projectId: string, planPath?: string, actor: Actor = 'system'): Project {
    this.applyTransition(projectId, 'awaiting-review', actor, 'design done', { fireHooks: false })
    const project = this.requireProject(projectId)
    if (planPath !== undefined) {
      project.planPath = planPath
      this.commit(project, actor, project.status, project.status, 'plan path recorded')
    }
    return this.requireProject(projectId)
  }

  /**
   * Fresh design round: drop a persisted (legacy root-level) plan path so the
   * project migrates to its per-project artifact directory. No-op when no
   * plan path is persisted (the common case for fresh projects).
   */
  resetPlanPath(projectId: string, actor: Actor = 'system'): Project {
    const project = this.requireProject(projectId)
    if (project.planPath !== undefined) {
      project.planPath = undefined
      this.commit(project, actor, project.status, project.status, 'plan path reset (fresh design)')
    }
    return this.requireProject(projectId)
  }

  /**
   * The execution agent's turn ended. Long-running projects never auto-complete.
   *
   * A DECOMPOSED project's completion is DERIVED from its leaves, never
   * asserted here: reporting `done` while a just-materialized leaf is still
   * executing is how the board once claimed "everything finished" over a
   * running task. Only a project with no leaves at all (the classic,
   * un-decomposed relay) moves straight to done.
   */
  reportExecuteDone(projectId: string, actor: Actor = 'system'): Project {
    const project = this.requireProject(projectId)
    if (project.lifecycle === 'long-running') return project
    if (this.projectTasks(projectId).length > 0) {
      this.checkProjectCompletion(projectId)
      return this.requireProject(projectId)
    }
    this.applyTransition(projectId, 'done', actor, 'execution done', { fireHooks: false })
    return this.requireProject(projectId)
  }

  /**
   * Stale-timer or human escalation: park the project in blocked.
   * The optional diagnostic is the machine-readable counterpart of `note`.
   */
  markBlocked(projectId: string, note: string, actor: Actor = 'system', failure?: FailureDiagnostic): Project {
    const project = this.requireProject(projectId)
    assertTransitionAllowed(project.status, 'blocked', actor)
    if (failure !== undefined) project.lastFailure = failure
    this.commit(project, actor, project.status, 'blocked', note)
    return this.requireProject(projectId)
  }

  /** Human override: any → any (the human is always in charge). */
  transition(projectId: string, to: ProjectStatus, note?: string): Project {
    this.applyTransition(projectId, to, 'human', note ?? 'manual override', { fireHooks: true })
    return this.requireProject(projectId)
  }

  /** Remove a project and its task leaves entirely (human). Children of a deleted long-running project keep living, un-affiliated. */
  deleteProject(projectId: string): void {
    const index = this.state.projects.findIndex(project => project.id === projectId)
    if (index < 0) throw new TransitionError(`unknown project ${projectId}`)
    const project = this.state.projects[index]!
    // Session-leak fix: cancel the project's own session and every task
    // leaf's session before removal (best-effort, fire-and-forget).
    this.cancelAttached(project.sessionId)
    for (const task of this.projectTasks(projectId)) this.cancelAttached(task.sessionId)
    // Deleting a long-running project dissolves affiliations, never children.
    for (const child of this.state.projects) {
      if (child.parentId === projectId) {
        child.parentId = undefined
        this.commit(child, 'system', child.status, child.status, '父长期项目已删除，关联解除')
      }
    }
    this.state.projects.splice(index, 1)
    this.state.tasks = this.state.tasks.filter(task => task.projectId !== projectId)
    this.pendingAdditions.delete(projectId)
    // Hygiene: the project's on-disk artifacts go with it.
    rmSync(projectDir(project), { recursive: true, force: true })
    this.mutate()
  }

  /**
   * The creator answers a clarify leaf; the answer then waits for the
   * creator's confirmation before the leaf completes.
   */
  answerClarification(projectId: string, taskId: string, answer: string): TaskNode {
    const task = this.requireProjectTask(projectId, taskId)
    if (task.kind !== 'clarify') throw new TransitionError(`task ${taskId} is not a clarify task`)
    assertTransitionAllowed(task.status, 'awaiting-review', 'human')
    task.answer = answer
    this.taskCommit(task, 'human', task.status, 'awaiting-review', `clarified: ${answer}`)
    return this.requireTask(taskId)
  }

  /** Human confirms a leaf's outcome (clarify answer or design artifact). */
  confirmTask(projectId: string, taskId: string): TaskNode {
    const task = this.requireProjectTask(projectId, taskId)
    assertTransitionAllowed(task.status, 'done', 'human')
    this.taskCommit(task, 'human', task.status, 'done', 'task confirmed')
    this.checkProjectCompletion(projectId)
    return this.requireTask(taskId)
  }

  /**
   * A research/design leaf's agent turn ended with an artifact; research leaves are then verified and completed by the system.
   * `note` overrides the default history text (a recovery verdict carries its own provenance).
   */
  reportTaskArtifactDone(taskId: string, artifactPath: string | undefined, actor: Actor = 'system', note?: string): TaskNode {
    const task = this.requireTask(taskId)
    assertTransitionAllowed(task.status, 'awaiting-review', actor)
    this.taskCommit(task, actor, task.status, 'awaiting-review', note ?? `${task.kind} artifact done`)
    if (artifactPath !== undefined) {
      const updated = this.requireTask(taskId)
      updated.artifactPath = artifactPath
      this.taskCommit(updated, actor, updated.status, updated.status, 'artifact path recorded')
    }
    this.checkProjectCompletion(task.projectId)
    return this.requireTask(taskId)
  }

  /** System verification completed a leaf (research artifact verified). */
  verifyTaskDone(taskId: string, note: string): TaskNode {
    const task = this.requireTask(taskId)
    assertTransitionAllowed(task.status, 'done', 'system')
    this.taskCommit(task, 'system', task.status, 'done', note)
    this.checkProjectCompletion(task.projectId)
    return this.requireTask(taskId)
  }

  /** The execution leaf's agent turn ended. `note` overrides the default history text. */
  reportTaskExecuteDone(taskId: string, actor: Actor = 'system', note?: string): TaskNode {
    const task = this.requireTask(taskId)
    assertTransitionAllowed(task.status, 'done', actor)
    this.taskCommit(task, actor, task.status, 'done', note ?? 'execution done')
    this.checkProjectCompletion(task.projectId)
    return this.requireTask(taskId)
  }

  /** Park a task leaf into blocked (system actor) with an optional diagnostic. */
  markTaskBlocked(taskId: string, note: string, actor: Actor = 'system', failure?: FailureDiagnostic): TaskNode {
    const task = this.requireTask(taskId)
    assertTransitionAllowed(task.status, 'blocked', actor)
    if (failure !== undefined) task.lastFailure = failure
    this.taskCommit(task, actor, task.status, 'blocked', note)
    return this.requireTask(taskId)
  }

  /**
   * Human recovery of a blocked leaf. This method only opens the door:
   * it validates, records the recovery intent (`task.recovery`), and moves the
   * leaf back into an active status. The verdict is written by the spawner's
   * next re-inspection — never here, so a `reinspect` can never prompt a
   * session that has already finished, and never invents a result.
   */
  recoverTask(
    projectId: string,
    taskId: string,
    options: { strategy?: RecoveryStrategy; note?: string } = {},
  ): TaskNode {
    const task = this.requireProjectTask(projectId, taskId)
    // The in-flight check comes first: a double click finds the leaf already
    // active again, and "already awaiting a recovery verdict" is the message
    // that explains what happened (the status check below would just say
    // "not blocked", with no hint that the first click worked).
    if (task.recovery !== undefined) {
      throw new TransitionError(`task ${taskId} is already awaiting a recovery verdict`)
    }
    if (task.status !== 'blocked') {
      throw new TransitionError(`task ${taskId} is not blocked (status ${task.status}); recovery only re-opens a blocked leaf`)
    }
    const strategy: RecoveryStrategy = options.strategy ?? (task.sessionId === undefined ? 'requeue' : 'reinspect')
    if (strategy === 'reinspect') {
      // The clarify check comes first: "clarify leaves have no agent session"
      // is the actionable message, while "no session attached" is the generic one.
      if (task.kind === 'clarify') {
        throw new TransitionError(`clarify task ${taskId} has no agent session; answer it instead`)
      }
      if (task.sessionId === undefined) {
        throw new TransitionError(`task ${taskId} has no session to re-inspect; use strategy requeue or delete it`)
      }
    }
    if (strategy === 'requeue' && task.kind === 'clarify' && task.question === undefined) {
      throw new TransitionError(`clarify task ${taskId} has no question to re-ask`)
    }
    const suffix = options.note === undefined || options.note.trim() === ''
      ? ''
      : `｜备注：${options.note.trim().replace(/\s+/g, ' ').slice(0, 200)}`
    if (task.kind === 'clarify') {
      // No session, no verdict to wait for: reopening the question IS the recovery.
      this.taskCommit(task, 'human', task.status, 'awaiting-clarification', `人工重开澄清：任务重新等待创建人回答${suffix}`)
      return this.requireTask(taskId)
    }
    const target: ProjectStatus = task.kind === 'execute' ? 'executing' : 'designing'
    const previousSession = task.sessionId
    if (strategy === 'requeue') {
      // Give up on the old session before re-running, otherwise two sessions
      // would work on the same leaf.
      this.cancelAttached(previousSession)
      task.sessionId = undefined
      task.sessionRole = undefined
    }
    task.recovery = { at: Date.now(), strategy, ...(previousSession === undefined ? {} : { sessionId: previousSession }) }
    const note = strategy === 'reinspect'
      ? `人工请求恢复：按会话 ${previousSession} 的最后一次 turn/end 重新判定（不追加提示）${suffix}`
      : previousSession === undefined
        ? `人工请求恢复：新建会话重新执行${suffix}`
        : `人工请求恢复：解除旧会话 ${previousSession} 绑定并取消，将新建会话重新执行${suffix}`
    this.taskCommit(task, 'human', task.status, target, note)
    return this.requireTask(taskId)
  }

  /**
   * Write an observation note on a task leaf WITHOUT changing its status and
   * WITHOUT refreshing lastActivityAt.
   *
   * The last part is deliberate: the recovery policy keeps a leaf observing
   * for as long as it takes, and if these notes refreshed activity they would
   * permanently defeat the stale timer — the only existing safety valve for a
   * leaf that never converges.
   */
  noteTaskObservation(taskId: string, note: string, actor: Actor = 'system'): TaskNode {
    const task = this.requireTask(taskId)
    const now = Date.now()
    task.updatedAt = now
    task.version += 1
    task.history.push({ at: now, actor, from: task.status, to: task.status, note })
    this.mutate()
    return this.requireTask(taskId)
  }

  /** Same as noteTaskObservation, for a project (a project-level turn under observation). */
  noteProjectObservation(projectId: string, note: string, actor: Actor = 'system'): Project {
    const project = this.requireProject(projectId)
    const now = Date.now()
    project.updatedAt = now
    project.version += 1
    project.history.push({ at: now, actor, from: project.status, to: project.status, note })
    this.mutate()
    return this.requireProject(projectId)
  }

  /**
   * Record a non-fatal anomaly (e.g. a settlement the state machine rejected).
   * Status-preserving and activity-neutral, exactly like the observation
   * notes; the caller throttles the rate (a 5s poll must never become a
   * ledger write amplifier).
   */
  noteAnomaly(projectId: string, note: string): void {
    const project = this.getProject(projectId)
    if (project === undefined) return
    const now = Date.now()
    project.updatedAt = now
    project.version += 1
    project.history.push({ at: now, actor: 'system', from: project.status, to: project.status, note: `异常：${note}` })
    this.mutate()
  }

  /**
   * Human soft-stop of a task leaf: best-effort cancel of its attached
   * session, then any non-blocked status → blocked with an audit-trail
   * note. Safety: the spawner only settles/spawns leaves in
   * designing/executing, so once the leaf is blocked neither the in-flight
   * cancel RPC's async window nor the next poll tick can resurrect it.
   */
  terminateTask(projectId: string, taskId: string, note?: string): TaskNode {
    const task = this.requireProjectTask(projectId, taskId)
    assertTransitionAllowed(task.status, 'blocked', 'human')
    this.cancelAttached(task.sessionId)
    this.taskCommit(task, 'human', task.status, 'blocked', note ?? '人工终止')
    return this.requireTask(taskId)
  }

  /**
   * Human hard-remove of a task leaf (any status, done included — the human
   * is always in charge): best-effort cancel of its session, drop the leaf
   * from the ledger, strip its id from every sibling's dependencies (each
   * affected sibling gets a metadata history entry, mirroring deleteProject's
   * child-unaffiliation pattern), remove its artifact file, then re-derive
   * the project's completion (deleting the last unfinished leaf may complete
   * the project).
   */
  deleteTask(projectId: string, taskId: string): void {
    const task = this.requireProjectTask(projectId, taskId)
    this.cancelAttached(task.sessionId)
    const index = this.state.tasks.findIndex(candidate => candidate.id === taskId)
    this.state.tasks.splice(index, 1)
    for (const sibling of this.projectTasks(projectId)) {
      if (!sibling.dependencies.includes(taskId)) continue
      sibling.dependencies = sibling.dependencies.filter(id => id !== taskId)
      this.taskCommit(sibling, 'system', sibling.status, sibling.status, '依赖任务已删除，依赖解除')
    }
    // Hygiene: the leaf's artifact goes with it (force: a missing file is fine).
    rmSync(task.artifactPath ?? taskArtifactPath(this.requireProject(projectId), taskId), { force: true })
    this.mutate()
    this.checkProjectCompletion(projectId)
  }

  /** Persist and broadcast after any mutation. */
  private mutate(): void {
    this.state.revision += 1
    saveState(this.file, this.state)
    this.broadcast()
  }

  private broadcast(): void {
    const payload = this.eventPayload()
    for (const listener of this.listeners) listener(payload)
  }

  private requireProject(projectId: string): Project {
    const project = this.getProject(projectId)
    if (project === undefined) throw new TransitionError(`unknown project ${projectId}`)
    return project
  }

  private requireTask(taskId: string): TaskNode {
    const task = this.getTask(taskId)
    if (task === undefined) throw new TransitionError(`unknown task ${taskId}`)
    return task
  }

  private requireProjectTask(projectId: string, taskId: string): TaskNode {
    const task = this.requireTask(taskId)
    if (task.projectId !== projectId) throw new TransitionError(`task ${taskId} does not belong to project ${projectId}`)
    return task
  }

  private applyTransition(
    projectId: string,
    to: ProjectStatus,
    actor: Actor,
    note: string,
    options: { fireHooks: boolean },
  ): void {
    const project = this.requireProject(projectId)
    const from = project.status
    assertTransitionAllowed(from, to, actor)
    this.commit(project, actor, from, to, note)
    if (options.fireHooks) {
      if (to === 'designing') this.onEnterDesigning(this.requireProject(projectId))
      if (to === 'executing') this.onEnterExecuting(this.requireProject(projectId))
    }
  }

  /**
   * Record one metadata/status commit — the single writer of `status`,
   * `version`, `updatedAt`, `lastActivityAt` and the history log.
   *
   * Batch semantics: every node in one call shares one `now`, and the batch is
   * persisted and broadcast ONCE (revision +1). That is what lets a sweep
   * archive N records without rewriting the whole ledger N times. An empty
   * batch is a complete no-op: a caller that found nothing to do must not
   * touch the disk.
   */
  private applyBatch(entries: readonly BatchEntry[]): void {
    if (entries.length === 0) return
    const now = Date.now()
    for (const entry of entries) {
      const node = entry.node
      node.status = entry.to
      // The recovery marker only exists while a leaf is active; clearing it on
      // every commit that lands the leaf elsewhere keeps that rule in one place.
      if (isTaskNode(node) && node.recovery !== undefined && entry.to !== 'designing' && entry.to !== 'executing') {
        delete node.recovery
      }
      node.updatedAt = now
      node.lastActivityAt = now
      node.version += 1
      const entryNote = entry.note
      node.history.push({ at: now, actor: entry.actor, from: entry.from, to: entry.to, ...(entryNote === undefined ? {} : { note: entryNote }) })
      // Chokepoint: an archived record must be `done`. Any commit that moves it
      // anywhere else drops the marker for free — including the materialize
      // path, which re-opens a project as `executing` and therefore restores it
      // to the board without a single explicit unarchive call.
      this.syncArchiveMarker(node, entry.to)
    }
    this.mutate()
  }

  /** Record one project transition (or creation). */
  private commit(project: Project, actor: Actor, from: ProjectStatus, to: ProjectStatus, note?: string): void {
    this.applyBatch([{ node: project, actor, from, to, note }])
  }

  /** Same as commit, for task leaves. */
  private taskCommit(task: TaskNode, actor: Actor, from: ProjectStatus, to: ProjectStatus, note?: string): void {
    this.applyBatch([{ node: task, actor, from, to, note }])
  }

  /**
   * Archive-marker lifetime, maintained in exactly this one place: the marker
   * is only meaningful while the record is `done`, so any write that lands it
   * on another status clears it. Without this, a human `transition` could
   * leave a hidden-but-running project that nobody can see.
   *
   * Status-preserving observation writes never come through here, which is why
   * they cannot accidentally un-archive a record.
   */
  private syncArchiveMarker(node: Project | TaskNode, to: ProjectStatus): void {
    if (to === 'done') return
    if (node.archivedAt === undefined) return
    delete node.archivedAt
    delete node.archivedBy
    delete node.archiveNote
  }

  /** Read the decomposition file the design agent wrote; undefined when not decomposed. */
  private loadDecompositionLeaves(project: Project): TaskLeaf[] {
    const decomposition = loadDecomposition(decompositionPathFor(project))
    if (decomposition === undefined) return []
    return flattenDecomposition(decomposition)
  }

  /**
   * Pure planning phase of materialization: build the new leaf nodes in
   * memory, resolve every dependency reference, and assert the merged graph
   * is acyclic. Touches NO state — any DecompositionError thrown here leaves
   * the ledger (and its caller's in-flight commit) untouched.
   *
   * `onConflict` decides what a titlePath that already exists means:
   * - `'throw'` (default) is the loud failure the settle path has always had:
   *   an agent writing a duplicate is a mistake a human must see.
   * - `'skip'` is the idempotence rule: a CLAIMED batch may be replayed after
   *   a crash, and a human's「物化到看板」click must not dead-end on a request
   *   that is already satisfied. Skipped paths are returned so the caller can
   *   put them in the audit note — never silently dropped.
   */
  private planTaskNodes(
    project: Project,
    leaves: TaskLeaf[],
    existing: TaskNode[] = [],
    onConflict: 'throw' | 'skip' = 'throw',
  ): { pending: TaskNode[]; skipped: string[] } {
    const now = Date.now()
    const byPath = new Map<string, TaskNode>()
    for (const task of existing) byPath.set(task.titlePath, task)
    const pending: TaskNode[] = []
    const skipped: string[] = []
    for (const leaf of leaves) {
      if (byPath.has(leaf.titlePath)) {
        if (onConflict === 'throw') throw new DecompositionError(`duplicate task title path: ${leaf.titlePath}`)
        skipped.push(leaf.titlePath)
        continue
      }
      const task: TaskNode = {
        id: randomUUID(),
        projectId: project.id,
        titlePath: leaf.titlePath,
        kind: leaf.kind,
        status: initialTaskStatus(leaf.kind),
        dependencies: [],
        ...(leaf.question === undefined ? {} : { question: leaf.question }),
        version: 0,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        history: [],
      }
      byPath.set(leaf.titlePath, task)
      pending.push(task)
    }
    for (const task of pending) {
      const leaf = leaves.find(candidate => candidate.titlePath === task.titlePath)!
      task.dependencies = leaf.dependsOn.map(ref => {
        const dependency = byPath.get(ref)
        if (dependency === undefined) {
          throw new DecompositionError(`task "${task.titlePath}" depends on unknown task "${ref}"`)
        }
        return dependency.id
      })
    }
    // The existing graph is acyclic by construction; new edges only ever
    // originate from the new batch, so checking the merged graph suffices.
    assertAcyclic([...existing, ...pending])
    return { pending, skipped }
  }

  /**
   * Commit phase of materialization: persist the pre-validated leaves in ONE
   * ledger batch, then fire their phase hooks.
   *
   * The single `mutate()` is what makes crash replay idempotent: the only two
   * crash points are "before the commit" (nothing in the ledger, so the batch
   * is rebuilt whole) and "after the commit" (everything in the ledger, so the
   * replay skips every titlePath). There is no half-committed middle state,
   * and therefore no dependency left pointing at a leaf that never got pushed.
   *
   * `projectNote` rides the same commit, so a re-open and its audit line read
   * as one event in the history instead of two.
   */
  private commitMaterialized(
    project: Project,
    pending: TaskNode[],
    actor: Actor,
    options: { leafNote?: string; projectNote?: string } = {},
  ): void {
    if (pending.length === 0 && options.projectNote === undefined) return
    const now = Date.now()
    for (const task of pending) {
      this.state.tasks.push(task)
      task.updatedAt = now
      task.lastActivityAt = now
      task.version += 1
      task.history.push({ at: now, actor, from: 'backlog', to: task.status, note: options.leafNote ?? 'materialized' })
    }
    if (options.projectNote !== undefined) {
      project.updatedAt = now
      project.lastActivityAt = now
      project.version += 1
      project.history.push({ at: now, actor, from: project.status, to: project.status, note: options.projectNote })
      // Defensive, not load-bearing: materialization never moves a project's
      // status (planning already did), so this only keeps the "archived implies
      // done" rule true even if a future caller passes a non-done project.
      this.syncArchiveMarker(project, project.status)
    }
    this.mutate()
    for (const task of pending) {
      const created = this.requireTask(task.id)
      if (created.kind === 'research' || created.kind === 'design') this.onEnterTaskDesigning(created)
      if (created.kind === 'execute') this.onEnterTaskExecuting(created)
    }
  }

  // ── Pending task-additions requests (late materialization) ────────────────
  //
  // An execution agent may write `tasks-additions.json` at ANY moment (the
  // prompt tells it to), but the host used to consume the file only at the
  // instant an execute turn settled. A leaf that had already been settled was
  // out of the observation window, so every later request was orphaned: never
  // materialized, never on the board, and never even reported as broken.
  //
  //   probe (read-only, every tick) → snapshot cache → human click
  //   ingest (freeze the mutable slot, every tick, no ledger effect)
  //   consume (settle path, or the human click — the only ledger writers)
  //
  // The probe is a pure read: no ledger access, no rename, no history note.

  /** Every request file of a project: the fresh slot first, then staged files by (mtime, ordinal). */
  private listAdditionsFiles(project: Project): AdditionsFile[] {
    const dir = projectDir(project)
    if (!existsSync(dir)) return []
    const files: AdditionsFile[] = []
    for (const name of readdirSync(dir)) {
      const ref = classifyTaskAdditionsFile(name)
      if (ref === undefined) continue
      const path = join(dir, name)
      if (ref.stage !== 'fresh') {
        files.push({ ref, path, mtimeMs: ref.mtimeMs })
        continue
      }
      try {
        files.push({ ref, path, mtimeMs: Math.floor(statSync(path).mtimeMs) })
      } catch {
        // Vanished between readdir and stat: the next tick sees the truth.
      }
    }
    return files.sort((left, right) => {
      const fresh = (file: AdditionsFile): number => file.ref.stage === 'fresh' ? 0 : 1
      if (fresh(left) !== fresh(right)) return fresh(left) - fresh(right)
      if (left.mtimeMs !== right.mtimeMs) return left.mtimeMs - right.mtimeMs
      return left.ref.ordinal - right.ref.ordinal
    })
  }

  /**
   * The files that still have to be materialized (fresh / pending / consuming).
   * The terminal stages (`consumed` / `failed` / `discarded`) are audit names:
   * they are excluded POSITIVELY, so adding a new terminal stage can never
   * accidentally re-arm an audit file as a live request.
   */
  private actionableAdditions(project: Project): AdditionsFile[] {
    return this.listAdditionsFiles(project).filter(file => isActionableTaskAdditionsStage(file.ref.stage))
  }

  /**
   * Whether a FRESH slot has stopped changing. The agent's `write` replaces
   * the whole file, so reading it mid-write could mis-report a healthy
   * request as malformed. Staged files are immutable and always settled.
   * A future mtime (an unmeasurable clock — e.g. a faked one) counts as
   * settled: visibility beats a theoretical half-write.
   */
  private isAdditionsSettled(file: AdditionsFile): boolean {
    if (file.ref.stage !== 'fresh') return true
    const age = Date.now() - file.mtimeMs
    return age < 0 || age >= ADDITIONS_SETTLE_MS
  }

  /** Read + parse one request file. A malformed body is a VALUE here, never a throw. */
  private readAdditions(path: string): AdditionsRead {
    try {
      const raw = readFileSync(path, 'utf8')
      const decomposition = parseDecomposition(raw)
      return { leaves: decomposition.decomposed ? flattenDecomposition(decomposition) : [] }
    } catch (error) {
      return { leaves: [], error: boundText(error instanceof Error ? error.message : String(error), PENDING_ERROR_MAX) }
    }
  }

  /**
   * Pure read of one project's not-yet-materialized requests: no ledger
   * access, no rename, no history note. Safe to call on every poll tick and
   * from the snapshot assembly path. Returns undefined when there is nothing
   * (settled and parseable) to show.
   */
  peekAdditions(projectId: string): AdditionsProbe | undefined {
    const project = this.getProject(projectId)
    if (project === undefined) return undefined
    return this.probeAdditions(project)
  }

  private probeAdditions(project: Project): AdditionsProbe | undefined {
    const files = this.actionableAdditions(project).filter(file => this.isAdditionsSettled(file))
    if (files.length === 0) return undefined
    const primary = files[0]!
    const malformed: PendingAdditionProblem[] = []
    const items: PendingAdditionItem[] = []
    let count = 0
    for (const file of files) {
      const read = this.readAdditions(file.path)
      if (read.error !== undefined) {
        malformed.push({ file: file.ref.name, at: file.mtimeMs, error: read.error })
        continue
      }
      // A healthy batch is NEVER hidden behind a broken one: the count, the
      // preview and (below) the consume path all aggregate the parseable
      // batches, so "2 requests, one broken" reads exactly like that.
      count += read.leaves.length
      for (const leaf of read.leaves) {
        if (items.length >= PENDING_ITEMS_MAX) break
        items.push({ titlePath: boundText(leaf.titlePath, PENDING_TITLE_MAX), kind: leaf.kind })
      }
    }
    const bounded = malformed.slice(0, PENDING_PROBLEMS_MAX)
    if (count === 0 && malformed.length > 0) {
      // Shaped failure, not `undefined`: a node that already left the
      // observation window has no other code path that could ever throw.
      const first = malformed[0]!
      return {
        state: 'malformed',
        file: first.file,
        at: first.at,
        batches: files.length,
        count: 0,
        items: [],
        malformed: bounded,
        error: first.error,
      }
    }
    return {
      state: 'ready',
      file: primary.ref.name,
      at: primary.mtimeMs,
      batches: files.length,
      count,
      items,
      malformed: bounded,
    }
  }

  /**
   * Phase 0 of the poll: freeze every settled, parseable FRESH slot into an
   * immutable staged file. No ledger state is touched and nothing is
   * materialized — this is a receipt, not a decision (the human gate stays
   * intact). It is what stops a second `write` in the same session from
   * physically destroying the first request.
   *
   * A malformed slot is left exactly where it is: the snapshot diagnoses it
   * and a human fixes the file (renaming it away would hide the evidence).
   */
  ingestPendingAdditions(): void {
    for (const project of this.state.projects) {
      const fresh = this.actionableAdditions(project).find(file => file.ref.stage === 'fresh')
      if (fresh === undefined || !this.isAdditionsSettled(fresh)) continue
      if (this.readAdditions(fresh.path).error !== undefined) continue
      const dir = projectDir(project)
      try {
        renameSync(fresh.path, join(dir, uniqueTaskAdditionsName(dir, fresh.mtimeMs, 'pending')))
      } catch {
        // A concurrent consumer claimed it first; the next tick sees the truth.
      }
    }
  }

  /**
   * Publish one project's probe result into the snapshot cache. Called once
   * per project per poll tick. It NEVER writes the ledger: a change only
   * replaces the assembly entry and pushes the new snapshot over SSE (no
   * saveState, no revision bump), so a 5-second poll can never become a
   * ledger-write amplifier, and an unchanged probe is a complete no-op.
   * @returns whether the published entry changed.
   */
  refreshPendingAdditions(projectId: string): boolean {
    const project = this.getProject(projectId)
    const probe = project === undefined ? undefined : this.probeAdditions(project)
    const next = probe === undefined ? undefined : toPendingAddition(projectId, probe)
    const previous = this.pendingAdditions.get(projectId)
    if (samePendingAddition(previous, next)) return false
    if (next === undefined) {
      this.pendingAdditions.delete(projectId)
    } else {
      this.pendingAdditions.set(projectId, next)
      // Every broken file version is reported once — including a broken batch
      // sitting next to healthy ones (which stays `ready`, so the old
      // `state === 'malformed'` test would have missed it).
      for (const problem of next.malformed ?? []) this.noteMalformedOnce(next.projectId, problem)
    }
    // Push only — never persist: this is a view over files, not ledger state.
    this.broadcast()
    return true
  }

  /**
   * Record a malformed request version exactly once per (project, file,
   * mtime). The mtime is part of the key on purpose: fixing the file creates a
   * new version, so a NEW breakage is reported again, while an unrepaired file
   * never becomes a per-tick ledger writer.
   */
  private noteMalformedOnce(projectId: string, problem: PendingAdditionProblem): void {
    const key = `${projectId}:${problem.file}:${problem.at}`
    if (this.malformedNoted.has(key)) return
    this.malformedNoted.add(key)
    this.noteAnomaly(projectId, `待处理的新增任务请求无法解析（${problem.file}）：${problem.error}`)
  }

  /**
   * Phase 4 of the poll: throttled consistency diagnostics. A project that is
   * `done` while one of its leaves is still unfinished means a request was
   * materialized after the project completed (or a human parked it), and the
   * board must say so instead of quietly disagreeing with itself. The
   * malformed-request diagnostic is written where it is discovered (see
   * noteMalformedOnce).
   */
  reportAdditionsDiagnostics(): void {
    for (const project of this.state.projects) {
      if (project.status !== 'done' || !this.hasUnfinishedLeaves(project.id)) continue
      if (!this.throttleAdditionsDiagnostic(`open-leaves:${project.id}`)) continue
      this.noteAnomaly(project.id, '项目已标记为完成，但仍存在未完成的子任务；请人工确认或重开项目')
    }
  }

  private throttleAdditionsDiagnostic(key: string): boolean {
    const now = Date.now()
    const last = this.additionsDiagnosticAt.get(key)
    if (last !== undefined && now - last < ADDITIONS_DIAGNOSTIC_THROTTLE_MS) return false
    this.additionsDiagnosticAt.set(key, now)
    return true
  }

  /** Whether a project still has a leaf that is not done (so its completion must not be asserted). */
  hasUnfinishedLeaves(projectId: string): boolean {
    const leaves = this.projectTasks(projectId)
    return leaves.length > 0 && !leaves.every(leaf => leaf.status === 'done')
  }

  /**
   * A fresh design round clears plan.md/tasks.json but keeps pending requests;
   * say so, so "the request survived a re-design" is auditable instead of
   * silent.
   */
  noteKeptAdditionsOnFreshDesign(projectId: string): void {
    const project = this.getProject(projectId)
    if (project === undefined) return
    const files = pendingAdditionsFileNames(project)
    if (files.length === 0) return
    this.noteProjectObservation(projectId, `全新设计轮：保留了 ${files.length} 个待处理的新增任务请求（${files.join('、')}），未删除`, 'system')
  }

  /**
   * Pure planning of the SETTLE path's consumption over the first `limit`
   * actionable batches, freshest intent first. Nothing is claimed and nothing
   * is committed here. A malformed body still throws DecompositionError (loud,
   * file preserved): the settle path is the agent's own write and a broken one
   * must fail its node loudly rather than be silently parked.
   *
   * Deliberately NOT gated on the freshness-settling rule: a consumer that has
   * already decided to read a request must keep the exact semantics the settle
   * path always had (loud failure, file kept). Only the read-only probe and the
   * ingest phase need the half-write guard.
   */
  private planAdditions(project: Project, actor: Actor, limit: number): PlannedAdditions | undefined {
    const files = this.actionableAdditions(project).slice(0, limit)
    if (files.length === 0) return undefined
    const batches: PlannedAdditionsBatch[] = []
    const pending: TaskNode[] = []
    const skipped: string[] = []
    for (const file of files) {
      // The fresh slot is the agent's live intent: the settle path rejects a
      // duplicate titlePath loudly. Everything else — a claimed batch replayed
      // after a crash, or a human click — must be idempotent instead.
      const onConflict = actor === 'human' || file.ref.stage !== 'fresh' ? 'skip' : 'throw'
      const decomposition = loadDecomposition(file.path)
      const leaves = decomposition === undefined ? [] : flattenDecomposition(decomposition)
      const planned = this.planTaskNodes(project, leaves, [...this.projectTasks(project.id), ...pending], onConflict)
      batches.push({ file, pending: planned.pending, skipped: planned.skipped })
      pending.push(...planned.pending)
      skipped.push(...planned.skipped)
    }
    return { batches, pending, skipped }
  }

  /**
   * Pure planning of the HUMAN click's consumption, which must never dead-end:
   * a batch the planner rejects is CLASSIFIED instead of thrown, so the exit
   * can be decided per batch (quarantine it, keep going with the rest) rather
   * than losing the whole click to the first poison request.
   *
   * Three outcomes per batch:
   * - planned: it will be materialized;
   * - broken: the body does not even parse — left exactly where it is, because
   *   the file IS the evidence (the human fixes or discards it);
   * - unplannable: parses, but the graph rejects it (unknown dependency, cycle)
   *   — a poison batch that would fail again on every retry, so it is isolated.
   */
  private planHumanAdditions(project: Project, files: readonly AdditionsFile[]): PlannedHumanAdditions {
    const existing = this.projectTasks(project.id)
    const batches: PlannedAdditionsBatch[] = []
    const pending: TaskNode[] = []
    const skipped: string[] = []
    const broken: BrokenAdditionsBatch[] = []
    const unplannable: UnplannableAdditionsBatch[] = []
    for (const file of files) {
      const read = this.readAdditions(file.path)
      if (read.error !== undefined) {
        broken.push({ file, error: read.error })
        continue
      }
      try {
        const planned = this.planTaskNodes(project, read.leaves, [...existing, ...pending], 'skip')
        batches.push({ file, pending: planned.pending, skipped: planned.skipped })
        pending.push(...planned.pending)
        skipped.push(...planned.skipped)
      } catch (error) {
        unplannable.push({ file, error: boundText(error instanceof Error ? error.message : String(error), PENDING_ERROR_MAX) })
      }
    }
    return { batches, pending, skipped, broken, unplannable }
  }

  /** Claim one planned batch: the atomic rename that makes a replay idempotent. */
  private claimAdditionsBatch(project: Project, file: AdditionsFile): string {
    const dir = projectDir(project)
    const target = join(dir, uniqueTaskAdditionsName(dir, file.mtimeMs, 'consuming'))
    renameSync(file.path, target)
    return target
  }

  /**
   * Park one file in a terminal stage (never overwriting an earlier audit).
   * Shared by `consumed` / `failed` / `discarded`: all three are the same
   * mechanical move, only the vocabulary differs.
   */
  private keepAdditionsBatch(project: Project, path: string, mtimeMs: number, stage: TaskAdditionsTerminalStage): string {
    const dir = projectDir(project)
    const name = uniqueTaskAdditionsName(dir, mtimeMs, stage)
    renameSync(path, join(dir, name))
    return name
  }

  /** Park a claimed batch in its terminal audit name (never overwriting an earlier audit). */
  private keepAdditionsBatchConsumed(project: Project, claimedPath: string, mtimeMs: number): string {
    return this.keepAdditionsBatch(project, claimedPath, mtimeMs, 'consumed')
  }

  /** Isolate an unplannable batch: the terminal stage that stops the retry loop. */
  private quarantineAdditionsBatch(project: Project, file: AdditionsFile, cause: string): string | undefined {
    try {
      const claimed = this.claimAdditionsBatch(project, file)
      const name = this.keepAdditionsBatch(project, claimed, file.mtimeMs, 'failed')
      this.noteAnomaly(
        project.id,
        `新增任务请求无法物化（unplannable）：${cause}；文件已隔离为 ${name}。` +
        `如需重试，请修好原因后把它改回 ${TASK_ADDITIONS_FILE}`,
      )
      return name
    } catch {
      // A concurrent consumer claimed it first; the next tick sees the truth.
      return undefined
    }
  }

  /**
   * Re-open a completed / parked project so its newly materialized leaves can
   * derive completion again. Human-only, and deliberately hook-free:
   * `onEnterExecuting` would see a project with ZERO leaves at this instant
   * (the batch is not committed yet) and spawn a project-level session
   * alongside the new leaves — two agents, one project.
   */
  private reopenProjectForAdditions(project: Project, note: string): boolean {
    if (project.status !== 'done' && project.status !== 'blocked') return false
    assertTransitionAllowed(project.status, 'executing', 'human')
    this.commit(project, 'human', project.status, 'executing', note)
    return true
  }

  /**
   * Consume an execution agent's task-additions request: materialize the
   * requested leaves (dependency references may point at ANY existing leaf of
   * the project, done or in-flight), then rename the request file to
   * `tasks-additions.<mtime>.consumed.json` so it is never consumed twice (the
   * rename also keeps an audit trail). Returns the new leaves, or undefined
   * when no request file exists. A malformed request throws DecompositionError
   * and the file is left exactly where it is — the caller fails the settling
   * project/leaf loudly.
   *
   * One call consumes ONE batch (the freshest intent first); a caller with
   * several accumulated batches loops.
   */
  applyTaskAdditions(projectId: string, options: { actor?: Actor } = {}): TaskNode[] | undefined {
    const project = this.requireProject(projectId)
    const actor = options.actor ?? 'system'
    const planned = this.planAdditions(project, actor, 1)
    if (planned === undefined) return undefined
    const claimed = planned.batches.map(batch => ({ batch, path: this.claimAdditionsBatch(project, batch.file) }))
    this.commitMaterialized(project, planned.pending, actor, {
      projectNote: additionsNote('结算时物化新增任务请求', planned.pending, planned.skipped),
    })
    for (const entry of claimed) this.keepAdditionsBatchConsumed(project, entry.path, entry.batch.file.mtimeMs)
    return planned.pending
  }

  /**
   * Human entry: materialize the project's pending requests NOW.
   *
   * The order is deliberate: plan (pure) → claim (filesystem receipt) →
   * re-open the project → commit every leaf in one batch → audit rename →
   * audit note. Any error path leaves the ledger untouched, so a double click
   * and a malformed body both stay explainable instead of destructive.
   *
   * Unlike the settle path, ONE poison request never cancels the click:
   * - a body that does not parse is left exactly where it is (the human fixes
   *   it or discards it — silently renaming it away would hide the evidence);
   * - a batch that parses but cannot be planned is quarantined into
   *   `*.failed.json` with its own anomaly note, so it stops failing forever
   *   without ever being deleted.
   * Both outcomes are reported in the result AND in the audit line: nothing
   * leaves the actionable set silently. When EVERY actionable batch is
   * unplannable the project is not re-opened (nothing was materialized) and the
   * call throws with an explanatory receipt.
   */
  materializePendingAdditions(projectId: string, note?: string): MaterializeAdditionsResult {
    const project = this.requireProject(projectId)
    if (project.status !== 'executing' && project.status !== 'done' && project.status !== 'blocked') {
      throw new TransitionError(`项目处于 ${project.status}，请先完成或放弃当前相位，再物化待处理的新增任务请求`)
    }
    const probe = this.probeAdditions(project)
    if (probe === undefined) {
      throw new TransitionError(`project ${projectId} has no pending task-additions request`)
    }
    if (probe.state === 'malformed') {
      throw new TransitionError(
        `tasks-additions.json is malformed: ${probe.error ?? 'unknown error'}；` +
        '可在看板上「废弃该请求」，或在修好文件后重新物化',
      )
    }
    const files = this.actionableAdditions(project).slice(0, MAX_ADDITIONS_BATCHES)
    const planned = this.planHumanAdditions(project, files)
    if (planned.batches.length === 0 && planned.unplannable.length === 0) {
      // TOCTOU: the settle path consumed it between the badge and the click.
      this.refreshPendingAdditions(projectId)
      throw new TransitionError('the pending request was already consumed')
    }
    const suffix = note === undefined || note.trim() === ''
      ? ''
      : `｜备注：${boundText(note, 200)}`
    // "Will this click put anything on the board?" gates BOTH the re-open and
    // the wording: a batch that materializes zero leaves (every titlePath
    // already exists, or an empty `tasks: []`) is consumed and audited, but
    // re-opening a done project for it would strand the card in「执行中」with
    // nothing running and no session left to settle it.
    const willMaterialize = planned.pending.length > 0
    const reopenFrom: ProjectStatus | undefined =
      willMaterialize && (project.status === 'done' || project.status === 'blocked') ? project.status : undefined
    const audit = [
      additionsNote('人工物化新增任务请求', planned.pending, planned.skipped, reopenFrom),
      planned.broken.length === 0 ? '' : `；保留 ${planned.broken.length} 个无法解析的请求（${planned.broken.map(entry => entry.file.ref.name).join('、')}）`,
      planned.unplannable.length === 0 ? '' : `；隔离 ${planned.unplannable.length} 个无法物化的请求（${planned.unplannable.map(entry => entry.file.ref.name).join('、')}）`,
    ].join('') + suffix
    /** Isolate every batch the planner rejected; returns what actually moved. */
    const quarantineAll = (): PendingAdditionProblem[] => {
      const parked: PendingAdditionProblem[] = []
      for (const entry of planned.unplannable) {
        const name = this.quarantineAdditionsBatch(project, entry.file, entry.error)
        if (name === undefined) continue
        parked.push({ file: name, at: entry.file.mtimeMs, error: entry.error })
      }
      return parked
    }
    if (planned.batches.length === 0) {
      // Every actionable batch is unplannable. A quarantine is NOT a
      // materialization: the project must not be re-opened (a done project
      // would be left executing with nothing running), but the decision is
      // still audited. The throw is the receipt — a silent 200 with the badge
      // gone would read as "the button did nothing".
      this.noteProjectObservation(projectId, audit, 'human')
      const parked = quarantineAll()
      this.refreshPendingAdditions(projectId)
      throw new TransitionError(
        `${parked.length} 个待处理请求均无法物化，已隔离为 *.failed.json（详见项目历史的异常记录）；` +
        `如需重试，请修好原因后把文件改回 ${TASK_ADDITIONS_FILE}`,
      )
    }
    const claimed = planned.batches.map(batch => ({ batch, path: this.claimAdditionsBatch(project, batch.file) }))
    const reopened = willMaterialize ? this.reopenProjectForAdditions(project, audit) : false
    this.commitMaterialized(project, planned.pending, 'human', reopened ? {} : { projectNote: audit })
    const consumed = claimed.map(entry => this.keepAdditionsBatchConsumed(project, entry.path, entry.batch.file.mtimeMs))
    // Quarantine AFTER the ledger commit: the leaf batch is the valuable half,
    // and a rename that fails must not roll back a committed materialization.
    const failed = quarantineAll()
    // The badge must disappear with the click, not up to one tick later.
    this.refreshPendingAdditions(projectId)
    const broken: PendingAdditionProblem[] = planned.broken.map(entry => ({
      file: entry.file.ref.name,
      at: entry.file.mtimeMs,
      error: entry.error,
    }))
    return {
      created: planned.pending,
      skipped: planned.skipped,
      consumed,
      failed,
      broken,
      reopened,
      project: this.requireProject(projectId),
    }
  }

  /**
   * Human entry: throw the project's pending requests away instead of
   * materializing them. This is the ONLY exit for a request that can never be
   * materialized (a body the human will not fix, or work they no longer want):
   * without it a broken file pins a permanent "⚠ 无法解析" badge on the board
   * with nothing clickable next to it.
   *
   * Every actionable batch — fresh, ingested, claimed-but-unfinished, and
   * broken bodies alike — is parked as `tasks-additions.<mtime>.discarded.json`
   * and ONE `human` audit note names them. Nothing is deleted, no leaf, session
   * or project status is touched: discarding a request must never re-open a
   * `done` project, and a file parked this way is never consumed again.
   */
  discardPendingAdditions(projectId: string, note?: string): DiscardAdditionsResult {
    const project = this.requireProject(projectId)
    const files = this.actionableAdditions(project)
    if (files.length === 0) {
      throw new TransitionError(`project ${projectId} has no pending task-additions request to discard`)
    }
    const discarded: DiscardedAdditionsFile[] = []
    for (const file of files) {
      try {
        const name = this.keepAdditionsBatch(project, file.path, file.mtimeMs, 'discarded')
        discarded.push({ file: name, at: file.mtimeMs })
      } catch {
        // A concurrent consumer claimed it first; the next tick sees the truth.
      }
    }
    if (discarded.length === 0) {
      this.refreshPendingAdditions(projectId)
      throw new TransitionError('the pending request was already consumed')
    }
    const suffix = note === undefined || note.trim() === ''
      ? ''
      : `｜备注：${boundText(note, 200)}`
    const names = discarded.slice(0, 3).map(entry => entry.file).join('、')
    const preview = discarded.length > 3 ? `${names} 等 ${discarded.length} 个批次` : names
    this.noteProjectObservation(
      projectId,
      `人工废弃新增任务请求：${discarded.length} 个批次（${preview}）${suffix}`,
      'human',
    )
    // The badge must disappear with the click, not up to one tick later.
    this.refreshPendingAdditions(projectId)
    return { discarded, project: this.requireProject(projectId) }
  }

  /**
   * A project-level execution split into new task leaves: detach the settled
   * session (metadata commit; the project stays executing). Without this the
   * next poll tick would settle the old session again and reportExecuteDone
   * would mark the project done while the new leaves are still running.
   */
  noteExecutionSplit(projectId: string, actor: Actor = 'system'): Project {
    const project = this.requireProject(projectId)
    if (project.sessionId === undefined && project.sessionRole === undefined) return project
    project.sessionId = undefined
    project.sessionRole = undefined
    this.commit(project, actor, project.status, project.status, 'execution split into new task leaves')
    return this.requireProject(projectId)
  }

  // ── Archive (soft): a ledger marker plus a view, never a delete ───────────
  //
  // Archiving touches the ledger and the view ONLY. It never starts or cancels
  // a session, never changes a status and never removes a file: `plan.md`,
  // `artifacts/`, and the request audit files all stay exactly where they are.
  // Records stay addressable by id (getProject / getTask / deleteProject /
  // readProjectFile keep reading the raw ledger), so an archived record is
  // hidden, not gone.

  /**
   * One sweep: pick the candidates from the RAW ledger, stamp them, then
   * persist and broadcast once.
   *
   * Idempotent and side-effect free when nothing is due (no revision bump, no
   * write, no broadcast), which is what makes a background sweep acceptable on
   * a ledger that is rewritten in full on every mutation.
   *
   * @param now - the judgement instant (injectable so tests and the startup
   *   catch-up are deterministic).
   * @returns the ids actually archived by this sweep.
   */
  archiveSweep(now: number = Date.now()): { projects: string[]; tasks: string[] } {
    const none = { projects: [] as string[], tasks: [] as string[] }
    if (this.archiveAfterDays <= 0) return none

    // Memory filters first: the single disk probe (a pending request) only runs
    // for projects that are done, non-container, and already past the window.
    const projectHits: Project[] = []
    for (const project of this.state.projects) {
      if (project.archivedAt !== undefined) continue
      if (!archiveWindowReached(project, now, this.archiveAfterDays)) continue
      if (this.projectArchiveBlock(project) !== undefined) continue
      projectHits.push(project)
    }

    const leafHits: TaskNode[] = []
    if (this.archiveDoneTaskLeaves) {
      for (const task of this.state.tasks) {
        if (task.archivedAt !== undefined) continue
        if (task.status !== 'done') continue
        if (!archiveWindowReached(task, now, this.archiveAfterDays)) continue
        const parent = this.getProject(task.projectId)
        // An orphan leaf is skipped rather than guessed at.
        if (parent === undefined) continue
        if (this.taskArchiveBlock(task, parent) !== undefined) continue
        leafHits.push(task)
      }
    }

    if (projectHits.length === 0 && leafHits.length === 0) return none
    const changes: ArchiveChange[] = [
      ...projectHits.map(project => ({ node: project, actor: 'system' as Actor, archive: true, note: autoArchiveNote(project, now, this.archiveAfterDays) })),
      ...leafHits.map(task => ({ node: task, actor: 'system' as Actor, archive: true, note: autoArchiveNote(task, now, this.archiveAfterDays) })),
    ]
    if (!this.persistArchiveChanges(changes, now)) return none
    console.warn(`[dsh-kanban] auto-archived ${projectHits.length} project(s) / ${leafHits.length} leaf(ves) after ${this.archiveAfterDays}d`)
    return { projects: projectHits.map(project => project.id), tasks: leafHits.map(task => task.id) }
  }

  /**
   * Why a project must NOT be archived, or undefined when it may.
   *
   * I1–I4 live here and only here, and the sweep and the human action share
   * them: a function that let the button archive what the sweep refuses (or the
   * other way round) would be two policies pretending to be one.
   */
  private projectArchiveBlock(project: Project): string | undefined {
    if (project.status !== 'done') return '尚未完成，只能归档已完成的项目'
    // I2: a long-running project is the board's container, not a work item.
    // Its one-shot affiliated children ARE archivable (that is where finished
    // sub-projects pile up).
    if (project.lifecycle === 'long-running') return '长期执行项目是看板容器，不能归档'
    // I3: a done project with open leaves is a contradiction the board reports;
    // archiving it would hide the contradiction instead of surfacing it.
    if (this.hasUnfinishedLeaves(project.id)) return '项目仍有未完成的子任务，不能归档'
    // I4: a request that is still waiting for a human must never be hidden by
    // an archive. Read from disk, never from the 5-second-old published cache.
    if (this.hasActionableRequest(project)) return '项目存在待处理的新增任务请求，请先物化或废弃，再归档'
    return undefined
  }

  /**
   * Why a leaf must NOT be archived, or undefined when it may.
   *
   * A leaf is only ever archived on its own while its project is still on the
   * board: once the project is archived (or done, i.e. about to be archived by
   * the project rule) the leaf hides and returns with it, and a marker of its
   * own would outlive the click that was supposed to bring everything back.
   */
  private taskArchiveBlock(task: TaskNode, project: Project): string | undefined {
    if (task.status !== 'done') return '尚未完成，只能归档已完成的任务'
    if (project.archivedAt !== undefined || project.status === 'done') {
      return '项目已完成或已归档，其叶子随项目一起隐藏，无需单独归档'
    }
    return undefined
  }

  /** I4 probe: does the project still have a materializable request on disk? */
  private hasActionableRequest(project: Project): boolean {
    try {
      return this.actionableAdditions(project).length > 0
    } catch (error) {
      // Conservative failure: an I/O error we cannot read means "assume there
      // is a request" — skipping an archive costs one sweep, hiding a request
      // costs the human the only door it has.
      console.error(`[dsh-kanban] additions probe failed for ${project.id}; treating it as pending`, error)
      return true
    }
  }

  /**
   * Human entry: archive one finished project. Idempotent — archiving an
   * already-archived project is a no-op (no history, no version, no revision).
   */
  archiveProject(projectId: string, note?: string, actor: Actor = 'human'): Project {
    const project = this.requireProject(projectId)
    if (project.archivedAt !== undefined) return project
    const block = this.projectArchiveBlock(project)
    if (block !== undefined) throw new TransitionError(block)
    const change: ArchiveChange = { node: project, actor, archive: true, note: manualArchiveNote(note) }
    if (!this.persistArchiveChanges([change], Date.now())) {
      throw new TransitionError('归档写入账本失败，请重试')
    }
    return this.requireProject(projectId)
  }

  /**
   * Human entry: the exact inverse of archiveProject.
   *
   * Only the project's own marker is cleared. A leaf that had been archived
   * individually BEFORE the project was archived keeps its marker, so the
   * visible set after a restore is element-wise the visible set before the
   * archive: restoring a project must not silently undo a separate decision
   * about one of its leaves (that leaf has its own entry in the archive view).
   * The project's other leaves come back with it, which is what makes the
   * restore a single click.
   */
  unarchiveProject(projectId: string, note?: string, actor: Actor = 'human'): Project {
    const project = this.requireProject(projectId)
    if (project.archivedAt === undefined) return project
    const change: ArchiveChange = { node: project, actor, archive: false, note: restoreNote(note) }
    if (!this.persistArchiveChanges([change], Date.now())) {
      throw new TransitionError('恢复归档写入账本失败，请重试')
    }
    return this.requireProject(projectId)
  }

  /** Human entry: archive one finished leaf of a still-visible project. */
  archiveTask(projectId: string, taskId: string, note?: string, actor: Actor = 'human'): TaskNode {
    const task = this.requireProjectTask(projectId, taskId)
    const project = this.requireProject(projectId)
    // Effective-hidden is the idempotence test, not "has its own marker": a
    // leaf that is already hidden by its project is done being hidden, and
    // stamping it now would change the board AFTER the project is restored —
    // a choice the user could not see when they made it.
    if (task.archivedAt !== undefined || project.archivedAt !== undefined) return task
    const block = this.taskArchiveBlock(task, project)
    if (block !== undefined) throw new TransitionError(block)
    const change: ArchiveChange = { node: task, actor, archive: true, note: manualArchiveNote(note) }
    if (!this.persistArchiveChanges([change], Date.now())) {
      throw new TransitionError('归档写入账本失败，请重试')
    }
    return this.requireTask(taskId)
  }

  /**
   * Human entry: the exact inverse of archiveTask. Clearing is always safe:
   * it only revokes an earlier intent, and it is applied even while the owning
   * project is archived (the effect shows up when the project returns).
   */
  unarchiveTask(projectId: string, taskId: string, note?: string, actor: Actor = 'human'): TaskNode {
    const task = this.requireProjectTask(projectId, taskId)
    if (task.archivedAt === undefined) return task
    const change: ArchiveChange = { node: task, actor, archive: false, note: restoreNote(note) }
    if (!this.persistArchiveChanges([change], Date.now())) {
      throw new TransitionError('恢复归档写入账本失败，请重试')
    }
    return this.requireTask(taskId)
  }

  /**
   * The archive read's projection: pure read of the raw ledger, no session, no
   * file, no write. `history` is dropped on purpose — it is about half of the
   * ledger by size and the archive list shows a title plus a few timestamps.
   *
   * @param projectId - narrow to one cluster: a visible project's own archived
   *   leaves, the archived one-shot projects affiliated to it, and those
   *   children's archived leaves (a dependency cluster must stay closed). The
   *   project itself is never included — the caller is already rendering it.
   */
  archiveEntries(projectId?: string): ArchiveEntry[] {
    const archivedProjects = archivedProjectIds(this.state.projects)
    const entries: ArchiveEntry[] = []
    const projectEntry = (project: Project): ArchiveEntry => {
      const parent = project.parentId === undefined ? undefined : this.getProject(project.parentId)
      return {
        kind: 'project',
        id: project.id,
        title: project.title,
        projectId: project.id,
        archivedAt: project.archivedAt!,
        ...(project.archivedBy === undefined ? {} : { archivedBy: project.archivedBy }),
        ...(project.archiveNote === undefined ? {} : { archiveNote: project.archiveNote }),
        ...(parent === undefined ? {} : { parentTitle: parent.title }),
        status: project.status,
        ...(project.lifecycle === undefined ? {} : { lifecycle: project.lifecycle }),
        taskCount: this.state.tasks.filter(task => task.projectId === project.id).length,
      }
    }
    const taskEntry = (task: TaskNode, owner: Project): ArchiveEntry => ({
      kind: 'task',
      id: task.id,
      title: task.titlePath,
      projectId: task.projectId,
      archivedAt: task.archivedAt!,
      ...(task.archivedBy === undefined ? {} : { archivedBy: task.archivedBy }),
      ...(task.archiveNote === undefined ? {} : { archiveNote: task.archiveNote }),
      titlePath: task.titlePath,
      taskKind: task.kind,
      status: task.status,
      projectTitle: owner.title,
    })

    if (projectId === undefined) {
      for (const project of this.state.projects) {
        if (project.archivedAt !== undefined) entries.push(projectEntry(project))
      }
      // Leaves whose project is archived are implied by that project entry:
      // listing them again would double count and offer a restore that has no
      // visible effect.
      for (const task of this.state.tasks) {
        if (task.archivedAt === undefined) continue
        if (archivedProjects.has(task.projectId)) continue
        const owner = this.getProject(task.projectId)
        if (owner === undefined) continue
        entries.push(taskEntry(task, owner))
      }
      return entries
    }

    const children = this.state.projects.filter(project => project.parentId === projectId && project.archivedAt !== undefined)
    const childIds = new Set(children.map(child => child.id))
    const owner = this.getProject(projectId)
    for (const task of this.state.tasks) {
      if (task.archivedAt === undefined) continue
      if (task.projectId === projectId) {
        if (owner !== undefined) entries.push(taskEntry(task, owner))
        continue
      }
      if (!childIds.has(task.projectId)) continue
      const child = this.getProject(task.projectId)
      if (child !== undefined) entries.push(taskEntry(task, child))
    }
    for (const child of children) entries.push(projectEntry(child))
    return entries
  }

  /**
   * Write one archive batch: stamp/clear the markers, add one metadata history
   * entry per record, persist and broadcast once.
   *
   * A failed write rolls the in-memory ledger back to exactly its previous
   * shape (I16): the disk still holds the old ledger, and without the rollback
   * the next sweep would skip these records forever — a "ghost archive" that
   * exists only in memory and can never be persisted.
   *
   * @returns whether the batch reached the disk.
   */
  private persistArchiveChanges(changes: readonly ArchiveChange[], now: number): boolean {
    if (changes.length === 0) return false
    const revision = this.state.revision
    const undo: ArchiveUndo[] = []
    for (const change of changes) {
      const node = change.node
      undo.push({
        node,
        archivedAt: node.archivedAt,
        archivedBy: node.archivedBy,
        archiveNote: node.archiveNote,
        version: node.version,
        updatedAt: node.updatedAt,
        lastActivityAt: node.lastActivityAt,
        historyLength: node.history.length,
      })
      if (change.archive) {
        node.archivedAt = now
        node.archivedBy = change.actor
        node.archiveNote = change.note
      } else {
        delete node.archivedAt
        delete node.archivedBy
        delete node.archiveNote
      }
      node.updatedAt = now
      node.lastActivityAt = now
      node.version += 1
      const from = node.status
      // Metadata commit: from === to === 'done', so no state-machine edge is
      // involved and no dependency scheduling is triggered (I10).
      node.history.push({ at: now, actor: change.actor, from, to: from, note: change.note })
    }
    try {
      this.mutate()
      return true
    } catch (error) {
      for (const entry of undo) {
        const node = entry.node
        if (entry.archivedAt === undefined) delete node.archivedAt
        else node.archivedAt = entry.archivedAt
        if (entry.archivedBy === undefined) delete node.archivedBy
        else node.archivedBy = entry.archivedBy
        if (entry.archiveNote === undefined) delete node.archiveNote
        else node.archiveNote = entry.archiveNote
        node.version = entry.version
        node.updatedAt = entry.updatedAt
        node.lastActivityAt = entry.lastActivityAt
        node.history.length = entry.historyLength
      }
      this.state.revision = revision
      console.error('[dsh-kanban] archive persist failed; rolled back in memory', error)
      return false
    }
  }

  /** A decomposed project completes when every leaf is done (system derivation). */
  private checkProjectCompletion(projectId: string): void {
    const project = this.getProject(projectId)
    if (project === undefined) return
    const leaves = this.projectTasks(projectId)
    if (leaves.length === 0) return
    if (project.status === 'done') return
    if (!leaves.every(leaf => leaf.status === 'done')) return
    this.commit(project, 'system', project.status, 'done', 'all task leaves done')
  }

  /** Park stale project/leaf phases into blocked (system actor). */
  private checkStale(): void {
    if (this.maxStaleMinutes <= 0) return
    const cutoff = Date.now() - this.maxStaleMinutes * 60_000
    for (const project of this.state.projects) {
      // Long-running projects live in executing forever; staleness is meaningless for them.
      if (project.lifecycle === 'long-running') continue
      if (project.status !== 'designing' && project.status !== 'executing') continue
      // A decomposed project's own lastActivityAt only moves on project-level
      // commits, so a project whose leaves are busy would look dead. Judge it
      // by its most recently active leaf as well.
      const leaves = this.projectTasks(project.id)
      const lastActivity = Math.max(project.lastActivityAt, ...leaves.map(leaf => leaf.lastActivityAt))
      if (lastActivity > cutoff) continue
      const note = `no activity for ${this.maxStaleMinutes} minutes`
      try {
        this.markBlocked(project.id, note, 'system', failureDiagnostic('stale', note))
      } catch {
        // The transition can only fail if the status moved concurrently; skip.
      }
    }
    for (const task of this.state.tasks) {
      // Waiting for the human is not staleness: a clarify leaf parked in
      // awaiting-clarification must never be killed by the timer.
      if (task.status !== 'designing' && task.status !== 'executing') continue
      if (task.lastActivityAt > cutoff) continue
      const note = `no activity for ${this.maxStaleMinutes} minutes`
      try {
        this.markTaskBlocked(task.id, note, 'system', failureDiagnostic('stale', note, task.sessionId))
      } catch {
        // The transition can only fail if the status moved concurrently; skip.
      }
    }
  }
}

/** The initial status of a materialized leaf, by kind. */
export function initialTaskStatus(kind: TaskKind): ProjectStatus {
  switch (kind) {
    case 'clarify': return 'awaiting-clarification'
    case 'research':
    case 'design': return 'designing'
    case 'execute': return 'executing'
  }
}

/**
 * Whether the archive window of a finished record has elapsed.
 *
 * `updatedAt` is the ledger's last-commit time, so a fresh commit (including a
 * restore) always buys a full window — that is what stops a restored record
 * from being re-archived by the next tick.
 *
 * `afterDays <= 0` means "automatic archiving is OFF", never "archive
 * everything now": without the short circuit the comparison would be true for
 * every record and a `0` window would empty the finished column at boot.
 * The boundary itself counts as reached (`now - updatedAt === afterDays`).
 */
export function archiveWindowReached(node: { updatedAt: number }, now: number, afterDays: number): boolean {
  if (afterDays <= 0) return false
  return now - node.updatedAt >= afterDays * MS_PER_DAY
}

/** One node's batch commit, before it is written. */
interface BatchEntry {
  node: Project | TaskNode
  actor: Actor
  from: ProjectStatus
  to: ProjectStatus
  note?: string
}

/** One archive/unarchive change, before it is written. */
interface ArchiveChange {
  node: Project | TaskNode
  actor: Actor
  /** true stamps the marker, false clears it. */
  archive: boolean
  /** The `archiveNote` and the history note of this change (one text, two uses). */
  note: string
}

/** Everything a failed archive write has to put back, per record plus the ledger revision. */
interface ArchiveUndo {
  node: Project | TaskNode
  archivedAt: number | undefined
  archivedBy: Actor | undefined
  archiveNote: string | undefined
  version: number
  updatedAt: number
  lastActivityAt: number
  historyLength: number
}

/** Narrow a ledger record to a task leaf (the two shapes share the commit path). */
function isTaskNode(node: Project | TaskNode): node is TaskNode {
  return 'titlePath' in node
}

/** The audit text of an automatic archive: readable, bounded, and the reason for the marker. */
function autoArchiveNote(node: { updatedAt: number }, now: number, afterDays: number): string {
  const ageDays = Math.floor(Math.max(0, now - node.updatedAt) / MS_PER_DAY)
  return boundText(`自动归档：已完成 ${ageDays} 天（阈值 ${afterDays} 天）`, ARCHIVE_NOTE_MAX)
}

/** The audit text of a manual archive (an empty note is "not provided"). */
function manualArchiveNote(note: string | undefined): string {
  const trimmed = note === undefined ? '' : note.trim()
  return trimmed === '' ? '手动归档' : boundText(`手动归档｜${trimmed}`, ARCHIVE_NOTE_MAX)
}

/** The audit text of a restore; it lives in the history only (`archiveNote` is cleared). */
function restoreNote(note: string | undefined): string {
  const trimmed = note === undefined ? '' : note.trim()
  return trimmed === '' ? '恢复归档' : boundText(`恢复归档｜${trimmed}`, ARCHIVE_NOTE_MAX)
}

/** Collapse whitespace and bound a string for the hot snapshot frame. */
function boundText(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`
}

/** Map a probe into the snapshot's assembly entry. */
function toPendingAddition(projectId: string, probe: AdditionsProbe): PendingAddition {
  return {
    projectId,
    file: probe.file,
    at: probe.at,
    state: probe.state,
    batches: probe.batches,
    count: probe.count,
    ...(probe.state === 'malformed' ? {} : { items: probe.items }),
    ...(probe.malformed.length === 0 ? {} : { malformed: probe.malformed }),
    ...(probe.error === undefined ? {} : { error: probe.error }),
  }
}

/**
 * Whether two published entries are the same fact. Shallow by design: the
 * entries are tiny, and comparing them is what turns an unchanged 5-second
 * probe into a complete no-op (no SSE frame, no ledger write).
 */
function samePendingAddition(left: PendingAddition | undefined, right: PendingAddition | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.projectId !== right.projectId || left.file !== right.file || left.at !== right.at) return false
  if (left.state !== right.state || left.batches !== right.batches || left.count !== right.count) return false
  if (left.error !== right.error) return false
  const leftItems = left.items ?? []
  const rightItems = right.items ?? []
  if (leftItems.length !== rightItems.length) return false
  if (!leftItems.every((item, index) => item.titlePath === rightItems[index]!.titlePath && item.kind === rightItems[index]!.kind)) return false
  const leftMalformed = left.malformed ?? []
  const rightMalformed = right.malformed ?? []
  if (leftMalformed.length !== rightMalformed.length) return false
  return leftMalformed.every((problem, index) => {
    const other = rightMalformed[index]!
    return problem.file === other.file && problem.at === other.at && problem.error === other.error
  })
}

/**
 * The project-level audit line of one consumption. Skipped title paths are
 * always listed: "the request was already satisfied" is a fact a human must
 * be able to read back, never a silent no-op.
 */
function additionsNote(prefix: string, created: TaskNode[], skipped: string[], reopenFrom?: ProjectStatus): string {
  const preview = (titles: string[]): string => {
    const bounded = titles.slice(0, 3).map(title => boundText(title, PENDING_TITLE_MAX))
    return titles.length > bounded.length ? `${bounded.join('、')} 等 ${titles.length} 项` : bounded.join('、')
  }
  const parts = [`新建 ${created.length} 项`]
  if (created.length > 0) parts.push(`（${preview(created.map(task => task.titlePath))}）`)
  if (skipped.length > 0) parts.push(`；跳过 ${skipped.length} 项（已存在：${preview(skipped)}）`)
  if (reopenFrom !== undefined) parts.push(`；项目重开 ${reopenFrom} → executing`)
  return `${prefix}：${parts.join('')}`
}


/** Fail loudly when the dependency graph has a cycle. */
function assertAcyclic(tasks: TaskNode[]): void {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (task: TaskNode): void => {
    if (visited.has(task.id)) return
    if (visiting.has(task.id)) throw new DecompositionError(`dependency cycle at "${task.titlePath}"`)
    visiting.add(task.id)
    for (const dependencyId of task.dependencies) {
      const dependency = byId.get(dependencyId)
      if (dependency !== undefined) visit(dependency)
    }
    visiting.delete(task.id)
    visited.add(task.id)
  }
  for (const task of tasks) visit(task)
}
