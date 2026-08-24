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
import { join } from 'node:path'
import { flattenDecomposition, loadDecomposition, type TaskLeaf } from './decomposition.ts'
import type {
  Actor, HistoryEntry, KanbanEventPayload, KanbanSnapshot, Project, ProjectStatus, TaskKind, TaskNode,
} from './protocol.ts'
import { assertTransitionAllowed, TransitionError } from './state-machine.ts'
import { emptyState, loadState, saveState, type PersistedState } from './storage.ts'

/** Stale-timer tick cadence (seconds); the check is a no-op when maxStaleMinutes is 0. */
const STALE_TICK_SECONDS = 30

/** The design agent's decomposition file, next to plan.md. */
export const DECOMPOSITION_FILE = 'tasks.json'

export interface CreateProjectInput {
  title: string
  workspaceDir: string
  goal: string
}

/** Hook fired when a project enters designing; the spawner wires sessions here. */
export type OnEnterDesigning = (project: Project) => void

/** Hook fired when a project enters executing; the spawner wires sessions here. */
export type OnEnterExecuting = (project: Project) => void

/** Hook fired when a task leaf enters designing (research/design leaves). */
export type OnEnterTaskDesigning = (task: TaskNode) => void

/** Hook fired when a task leaf enters executing (execute leaves). */
export type OnEnterTaskExecuting = (task: TaskNode) => void

export class KanbanHostService {
  private state: PersistedState = emptyState()
  private readonly listeners = new Set<(payload: KanbanEventPayload) => void>()
  private staleTimer: NodeJS.Timeout | undefined
  private maxStaleMinutes = 0
  private onEnterDesigning: OnEnterDesigning = () => {}
  private onEnterExecuting: OnEnterExecuting = () => {}
  private onEnterTaskDesigning: OnEnterTaskDesigning = () => {}
  private onEnterTaskExecuting: OnEnterTaskExecuting = () => {}

  constructor(private readonly file: string) {}

  /** Load the ledger from disk (synchronous: boot must see the persisted board). */
  start(): void {
    this.state = loadState(this.file)
  }

  /** Tear down the stale timer and listeners. */
  dispose(): void {
    if (this.staleTimer !== undefined) clearInterval(this.staleTimer)
    this.staleTimer = undefined
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

  /** Re-fire the phase hooks for a task leaf's current status (host-restart recovery). */
  refireTaskPhaseHooks(taskId: string): void {
    const task = this.requireTask(taskId)
    if (task.status === 'designing') this.onEnterTaskDesigning(task)
    if (task.status === 'executing') this.onEnterTaskExecuting(task)
  }

  snapshot(): KanbanSnapshot {
    return { revision: this.state.revision, projects: this.state.projects, tasks: this.state.tasks }
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

  /** All task leaves of one project. */
  projectTasks(projectId: string): TaskNode[] {
    return this.state.tasks.filter(task => task.projectId === projectId)
  }

  /** Create a project in backlog, then immediately auto-start design (system actor). */
  createProject(input: CreateProjectInput): Project {
    const now = Date.now()
    const project: Project = {
      id: randomUUID(),
      title: input.title,
      workspaceDir: input.workspaceDir,
      goal: input.goal,
      status: 'backlog',
      version: 0,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      history: [],
    }
    this.state.projects.push(project)
    this.commit(project, 'system', 'backlog', 'backlog', 'created')
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
    this.commit(project, 'human', project.status, 'executing', leaves.length > 0 ? 'plan confirmed (decomposed)' : 'plan confirmed')
    if (leaves.length > 0) {
      this.materializeTasks(project, leaves)
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

  /** The execution agent's turn ended. */
  reportExecuteDone(projectId: string, actor: Actor = 'system'): Project {
    this.applyTransition(projectId, 'done', actor, 'execution done', { fireHooks: false })
    return this.requireProject(projectId)
  }

  /** Stale-timer or human escalation: park the project in blocked. */
  markBlocked(projectId: string, note: string, actor: Actor = 'system'): Project {
    this.applyTransition(projectId, 'blocked', actor, note, { fireHooks: false })
    return this.requireProject(projectId)
  }

  /** Human override: any → any (the human is always in charge). */
  transition(projectId: string, to: ProjectStatus, note?: string): Project {
    this.applyTransition(projectId, to, 'human', note ?? 'manual override', { fireHooks: true })
    return this.requireProject(projectId)
  }

  /** Remove a project and its task leaves entirely (human). */
  deleteProject(projectId: string): void {
    const index = this.state.projects.findIndex(project => project.id === projectId)
    if (index < 0) throw new TransitionError(`unknown project ${projectId}`)
    this.state.projects.splice(index, 1)
    this.state.tasks = this.state.tasks.filter(task => task.projectId !== projectId)
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

  /** A research/design leaf's agent turn ended with an artifact; research leaves are then verified and completed by the system. */
  reportTaskArtifactDone(taskId: string, artifactPath: string | undefined, actor: Actor = 'system'): TaskNode {
    const task = this.requireTask(taskId)
    assertTransitionAllowed(task.status, 'awaiting-review', actor)
    this.taskCommit(task, actor, task.status, 'awaiting-review', `${task.kind} artifact done`)
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

  /** The execution leaf's agent turn ended. */
  reportTaskExecuteDone(taskId: string, actor: Actor = 'system'): TaskNode {
    const task = this.requireTask(taskId)
    assertTransitionAllowed(task.status, 'done', actor)
    this.taskCommit(task, actor, task.status, 'done', 'execution done')
    this.checkProjectCompletion(task.projectId)
    return this.requireTask(taskId)
  }

  /** Park a stale task leaf into blocked (system actor). */
  markTaskBlocked(taskId: string, note: string, actor: Actor = 'system'): TaskNode {
    const task = this.requireTask(taskId)
    assertTransitionAllowed(task.status, 'blocked', actor)
    this.taskCommit(task, actor, task.status, 'blocked', note)
    return this.requireTask(taskId)
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

  /** Record one transition (or creation): bump version, push the history entry, persist, broadcast. */
  private commit(project: Project, actor: Actor, from: ProjectStatus, to: ProjectStatus, note?: string): void {
    const now = Date.now()
    project.status = to
    project.updatedAt = now
    project.lastActivityAt = now
    project.version += 1
    const entry: HistoryEntry = { at: now, actor, from, to, ...(note === undefined ? {} : { note }) }
    project.history.push(entry)
    this.mutate()
  }

  /** Same as commit, for task leaves. */
  private taskCommit(task: TaskNode, actor: Actor, from: ProjectStatus, to: ProjectStatus, note?: string): void {
    const now = Date.now()
    task.status = to
    task.updatedAt = now
    task.lastActivityAt = now
    task.version += 1
    const entry: HistoryEntry = { at: now, actor, from, to, ...(note === undefined ? {} : { note }) }
    task.history.push(entry)
    this.mutate()
  }

  /** Read the decomposition file the design agent wrote; undefined when not decomposed. */
  private loadDecompositionLeaves(project: Project): TaskLeaf[] {
    const decomposition = loadDecomposition(join(project.workspaceDir, DECOMPOSITION_FILE))
    if (decomposition === undefined) return []
    return flattenDecomposition(decomposition)
  }

  /** Create the task leaves and fire their phase hooks (parallel execution). */
  private materializeTasks(project: Project, leaves: TaskLeaf[]): void {
    const now = Date.now()
    for (const leaf of leaves) {
      const task: TaskNode = {
        id: randomUUID(),
        projectId: project.id,
        titlePath: leaf.titlePath,
        kind: leaf.kind,
        status: initialTaskStatus(leaf.kind),
        ...(leaf.question === undefined ? {} : { question: leaf.question }),
        version: 0,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        history: [],
      }
      this.state.tasks.push(task)
      this.taskCommit(task, 'system', 'backlog', task.status, 'materialized')
      const created = this.requireTask(task.id)
      if (task.kind === 'research' || task.kind === 'design') this.onEnterTaskDesigning(created)
      if (task.kind === 'execute') this.onEnterTaskExecuting(created)
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
      if (project.status !== 'designing' && project.status !== 'executing') continue
      if (project.lastActivityAt > cutoff) continue
      try {
        this.markBlocked(project.id, `no activity for ${this.maxStaleMinutes} minutes`, 'system')
      } catch {
        // The transition can only fail if the status moved concurrently; skip.
      }
    }
    for (const task of this.state.tasks) {
      if (task.status !== 'designing' && task.status !== 'executing' && task.status !== 'awaiting-clarification') continue
      if (task.lastActivityAt > cutoff) continue
      try {
        this.markTaskBlocked(task.id, `no activity for ${this.maxStaleMinutes} minutes`, 'system')
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

