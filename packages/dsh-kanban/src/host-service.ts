/**
 * Kanban host service: the ledger's single writer. Owns the project list,
 * the state machine, persistence, SSE broadcast, and the stale timer.
 *
 * The browser is a same-origin asynchronous view over this service (the
 * dsh-web-ui task-board pattern, Apache-2.0): every mutation goes through
 * one of the apply* methods below, bumps revision/version, persists, and
 * broadcasts the new snapshot to /events subscribers.
 */
import { randomUUID } from 'node:crypto'
import type { Actor, HistoryEntry, KanbanEventPayload, KanbanSnapshot, Project, ProjectStatus } from './protocol.ts'
import { assertTransitionAllowed, TransitionError } from './state-machine.ts'
import { emptyState, loadState, saveState, type PersistedState } from './storage.ts'

/** Stale-timer tick cadence (seconds); the check is a no-op when maxStaleMinutes is 0. */
const STALE_TICK_SECONDS = 30

export interface CreateProjectInput {
  title: string
  workspaceDir: string
  goal: string
}

/** Hook fired when a project enters designing; step 3 wires the session spawner here. */
export type OnEnterDesigning = (project: Project) => void

/** Hook fired when a project enters executing; step 3 wires the execution spawner here. */
export type OnEnterExecuting = (project: Project) => void

export class KanbanHostService {
  private state: PersistedState = emptyState()
  private readonly listeners = new Set<(payload: KanbanEventPayload) => void>()
  private staleTimer: NodeJS.Timeout | undefined
  private maxStaleMinutes = 0
  private onEnterDesigning: OnEnterDesigning = () => {}
  private onEnterExecuting: OnEnterExecuting = () => {}

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

  /** Step 3 wires the session spawner here. */
  setSpawnHooks(hooks: { onEnterDesigning: OnEnterDesigning; onEnterExecuting: OnEnterExecuting }): void {
    this.onEnterDesigning = hooks.onEnterDesigning
    this.onEnterExecuting = hooks.onEnterExecuting
  }

  /** Record which session drives a project (metadata commit; no status change). */
  attachSession(projectId: string, sessionId: string, role: 'design' | 'execute'): Project {
    const project = this.requireProject(projectId)
    project.sessionId = sessionId
    project.sessionRole = role
    this.commit(project, 'system', project.status, project.status, `session attached (${role})`)
    return this.requireProject(projectId)
  }

  /** Re-fire the phase hook for a project's current status (host-restart recovery). */
  refirePhaseHooks(projectId: string): void {
    const project = this.requireProject(projectId)
    if (project.status === 'designing') this.onEnterDesigning(project)
    if (project.status === 'executing') this.onEnterExecuting(project)
  }

  snapshot(): KanbanSnapshot {
    return { revision: this.state.revision, projects: this.state.projects }
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

  /** Human confirms the design; the execution phase starts. */
  confirmPlan(projectId: string): Project {
    this.applyTransition(projectId, 'executing', 'human', 'plan confirmed', { fireHooks: true })
    return this.requireProject(projectId)
  }

  /** Human rejects the design with feedback; back to designing (same session resumes, step 3). */
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

  /** Remove a project entirely (human). */
  deleteProject(projectId: string): void {
    const index = this.state.projects.findIndex(project => project.id === projectId)
    if (index < 0) throw new TransitionError(`unknown project ${projectId}`)
    this.state.projects.splice(index, 1)
    this.mutate()
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

  /** Park stale designing/executing projects into blocked (system actor). */
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
  }
}
