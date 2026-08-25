/**
 * Kanban spawner: wires the session runner into the host service's phase
 * hooks and reconciles running sessions with the board (the dsh-web-ui
 * task-board host-service poll pattern, Apache-2.0).
 *
 * - Projects: onEnterDesigning resumes/spawns the design session,
 *   onEnterExecuting spawns the execution session.
 * - Task leaves: research/design leaves spawn their own session on entering
 *   designing; execute leaves spawn theirs on entering executing. Clarify
 *   leaves have no session (the creator answers on the board).
 * - A 5-second poll reconciles every active phase: turn/end → phase report;
 *   failure/cancellation → blocked; missing plan.md / artifact → blocked.
 * - On start, phases that survived a host restart are re-fired (re-prompt),
 *   so a crash mid-phase does not strand a project.
 */
import { existsSync } from 'node:fs'
import type { KanbanHostService } from './host-service.ts'
import type { Project, TaskNode } from './protocol.ts'
import { KanbanSessionRunner, planPathFor, taskArtifactPath, type KanbanApi, type KanbanSessionSummary } from './session-runner.ts'

const SESSION_POLL_MS = 5_000

export interface KanbanSpawnerOptions {
  /** Test seam: how long to wait between polls (default 5s). */
  pollIntervalMs?: number
}

/** One spawn attempt outcome (for tests and logging). */
export type SpawnResult = { kind: 'launched'; sessionId: string } | { kind: 'resumed'; sessionId: string } | { kind: 'failed'; error: string }

export class KanbanSpawner {
  private readonly runner: KanbanSessionRunner
  private readonly launchedAt = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined
  private pollInFlight = false
  private disposed = false
  private readonly pollIntervalMs: number

  constructor(
    private readonly service: KanbanHostService,
    api: KanbanApi,
    options: KanbanSpawnerOptions = {},
  ) {
    // The runner's api is structural; the real ctx.apiProxy satisfies it.
    this.runner = new KanbanSessionRunner(api)
    this.pollIntervalMs = options.pollIntervalMs ?? SESSION_POLL_MS
  }

  /** Wire the phase hooks and start the poll loop; returns the disposer. */
  start(): () => void {
    this.service.setSpawnHooks({
      onEnterDesigning: project => {
        void this.enterDesigning(project)
      },
      onEnterExecuting: project => {
        void this.enterExecuting(project)
      },
      onEnterTaskDesigning: task => {
        void this.enterTaskDesigning(task)
      },
      onEnterTaskExecuting: task => {
        void this.enterTaskExecuting(task)
      },
    })
    // Host-restart recovery: phases that survived the crash get re-fired.
    for (const project of this.service.snapshot().projects) {
      this.service.refirePhaseHooks(project.id)
      for (const task of this.service.projectTasks(project.id)) {
        this.service.refireTaskPhaseHooks(task.id)
      }
    }
    this.timer = setInterval(() => this.schedulePoll(), this.pollIntervalMs)
    return () => {
      this.disposed = true
      if (this.timer !== undefined) clearInterval(this.timer)
      this.timer = undefined
      this.launchedAt.clear()
    }
  }

  private async enterDesigning(project: Project): Promise<void> {
    const result = await this.runPhase(async () => {
      if (project.sessionId !== undefined && project.sessionRole === 'design') {
        return { kind: 'resumed', sessionId: await this.runner.resumeDesign(project) }
      }
      // Fresh start (never resumed): a persisted legacy planPath (root-level
      // plan.md) would misdirect planExists/design prompts, so drop it and
      // migrate the project to its per-project artifact directory.
      this.service.resetPlanPath(project.id)
      return { kind: 'launched', sessionId: await this.runner.launchDesign(project) }
    })
    if (result.kind === 'failed') {
      this.failProject(project, `design phase: ${result.error}`)
      return
    }
    this.launchedAt.set(result.sessionId, Date.now())
    if (result.kind === 'launched') this.service.attachSession(project.id, result.sessionId, 'design')
  }

  private async enterExecuting(project: Project): Promise<void> {
    const result = await this.runPhase(async () => {
      // Host-restart recovery: a run that was already attached to a session
      // continues in that session; only a phase with no session spawns fresh.
      if (project.sessionId !== undefined && project.sessionRole === 'execute') {
        return { kind: 'resumed', sessionId: await this.runner.resumeExecute(project) }
      }
      return { kind: 'launched', sessionId: await this.runner.launchExecute(project) }
    })
    if (result.kind === 'failed') {
      this.failProject(project, `execution phase: ${result.error}`)
      return
    }
    this.launchedAt.set(result.sessionId, Date.now())
    if (result.kind === 'launched') this.service.attachSession(project.id, result.sessionId, 'execute')
  }

  private async enterTaskDesigning(task: TaskNode): Promise<void> {
    const project = this.service.getProject(task.projectId)
    if (project === undefined) return
    // Dependency scheduling: spawn only when every declared dependency (and,
    // for execute leaves, every clarification) is done.
    if (!this.dependenciesReady(task)) return
    const result = await this.runPhase(async () => {
      // Host-restart recovery: the leaf's own session resumes.
      if (task.sessionId !== undefined && task.sessionRole === task.kind) {
        return { kind: 'resumed', sessionId: await this.resumeTask(task, project) }
      }
      if (task.kind === 'research') {
        return { kind: 'launched', sessionId: await this.runner.launchResearch(task, project) }
      }
      return { kind: 'launched', sessionId: await this.runner.launchDesignTask(task, project) }
    })
    if (result.kind === 'failed') {
      this.failTask(task, `${task.kind} phase: ${result.error}`)
      return
    }
    this.launchedAt.set(result.sessionId, Date.now())
    if (result.kind === 'launched') this.service.attachTaskSession(task.id, result.sessionId, task.kind === 'research' ? 'research' : 'design')
  }

  private async enterTaskExecuting(task: TaskNode): Promise<void> {
    const project = this.service.getProject(task.projectId)
    if (project === undefined) return
    // Dependency scheduling: execute leaves spawn only when their declared
    // dependencies and every clarification of the project are done.
    if (!this.dependenciesReady(task)) return
    const result = await this.runPhase(async () => {
      if (task.sessionId !== undefined && task.sessionRole === 'execute') {
        return { kind: 'resumed', sessionId: await this.resumeTask(task, project) }
      }
      return { kind: 'launched', sessionId: await this.runner.launchExecuteTask(task, project, this.clarifications(task.projectId)) }
    })
    if (result.kind === 'failed') {
      this.failTask(task, `execution phase: ${result.error}`)
      return
    }
    this.launchedAt.set(result.sessionId, Date.now())
    if (result.kind === 'launched') this.service.attachTaskSession(task.id, result.sessionId, 'execute')
  }

  /** Continue a task leaf's own session after a host restart. */
  private async resumeTask(task: TaskNode, project: Project): Promise<string> {
    if (task.sessionId === undefined) throw new Error('resume requested but no session is attached')
    const text = task.kind === 'research' || task.kind === 'design'
      ? '宿主已重启，请检查你的产出文件是否完整，不完整则继续完成，然后结束回合。'
      : '宿主已重启，你的任务尚未完成，请继续执行，全部完成后结束回合。'
    return this.runner.resumeTaskSession(task.sessionId, text)
  }

  /** Whether a leaf is in a spawn-eligible status but has no session yet. */
  private isAwaitingSpawn(task: TaskNode): boolean {
    if (task.kind === 'clarify') return false
    if (task.kind === 'research' || task.kind === 'design') return task.status === 'designing'
    return task.status === 'executing'
  }

  /**
   * Whether a leaf may spawn: every declared dependency is done, and execute
   * leaves additionally wait for the project's clarifications (their prompt
   * carries the Q&A).
   */
  private dependenciesReady(task: TaskNode): boolean {
    for (const dependencyId of task.dependencies) {
      const dependency = this.service.getTask(dependencyId)
      if (dependency === undefined || dependency.status !== 'done') return false
    }
    if (task.kind === 'execute') {
      const pendingClarify = this.service.projectTasks(task.projectId)
        .some(leaf => leaf.kind === 'clarify' && leaf.status !== 'done')
      if (pendingClarify) return false
    }
    return true
  }

  /** The confirmed clarification Q&A of a project (context for execute leaves). */
  private clarifications(projectId: string): Array<{ question: string; answer: string }> {
    return this.service.projectTasks(projectId)
      .filter(task => task.kind === 'clarify' && task.answer !== undefined && task.question !== undefined)
      .map(task => ({ question: task.question!, answer: task.answer! }))
  }

  private async runPhase(launch: () => Promise<{ kind: 'launched'; sessionId: string } | { kind: 'resumed'; sessionId: string }>): Promise<SpawnResult> {
    try {
      return await launch()
    } catch (error) {
      return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  private failProject(project: Project, note: string): void {
    try {
      this.service.markBlocked(project.id, note, 'system')
    } catch {
      // The project may have moved concurrently (e.g. human override); the
      // board's own state is authoritative.
    }
  }

  private failTask(task: TaskNode, note: string): void {
    try {
      this.service.markTaskBlocked(task.id, note, 'system')
    } catch {
      // The task may have moved concurrently; the board is authoritative.
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed) return
    const running = await this.runner.listRunning()
    for (const project of this.service.snapshot().projects) {
      // Phase 1: settle running sessions (their reports may release
      // dependents). Phase 2: trigger leaves whose dependencies just cleared,
      // so a dependency chain advances within one tick.
      await this.pollProject(project, running.known ? running.items : undefined)
      await Promise.all(this.service.projectTasks(project.id).map(task => this.pollTask(task, running.known ? running.items : undefined)))
      for (const task of this.service.projectTasks(project.id)) {
        if (task.sessionId === undefined && this.isAwaitingSpawn(task) && this.dependenciesReady(task)) {
          if (task.kind === 'execute') void this.enterTaskExecuting(task)
          else void this.enterTaskDesigning(task)
        }
      }
    }
  }

  private async pollProject(project: Project, sessions: readonly KanbanSessionSummary[] | undefined): Promise<void> {
    if (project.sessionId === undefined) return
    const role = project.sessionRole
    if (role !== 'design' && role !== 'execute') return
    if (project.status !== 'designing' && project.status !== 'executing') return
    const startedAt = this.launchedAt.get(project.sessionId) ?? 0
    await this.inspectAndSettle(project.sessionId, startedAt, sessions, outcome => {
      if (outcome.outcome !== 'succeeded') {
        this.failProject(project, `session ${project.sessionId} ${outcome.outcome}${'error' in outcome ? `: ${outcome.error}` : ''}`)
        return
      }
      try {
        if (role === 'design') {
          // planExists checks planPath first (legacy compat); report the
          // same path so a resumed legacy project keeps its recorded plan.
          const planPath = project.planPath ?? planPathFor(project)
          if (!this.runner.planExists(project)) {
            this.failProject(project, `design ended but ${planPath} is missing`)
            return
          }
          this.service.reportDesignDone(project.id, planPath, 'system')
        } else {
          this.service.reportExecuteDone(project.id, 'system')
        }
      } catch {
        // The phase may have moved concurrently; the board is authoritative.
      }
    })
  }

  private async pollTask(task: TaskNode, sessions: readonly KanbanSessionSummary[] | undefined): Promise<void> {
    if (task.sessionId === undefined) return
    const role = task.sessionRole
    if (role !== 'research' && role !== 'design' && role !== 'execute') return
    if (task.status !== 'designing' && task.status !== 'executing') return
    const startedAt = this.launchedAt.get(task.sessionId) ?? 0
    await this.inspectAndSettle(task.sessionId, startedAt, sessions, outcome => {
      if (outcome.outcome !== 'succeeded') {
        this.failTask(task, `session ${task.sessionId} ${outcome.outcome}${'error' in outcome ? `: ${outcome.error}` : ''}`)
        return
      }
      try {
        const project = this.service.getProject(task.projectId)
        if (project === undefined) return
        if (role === 'execute') {
          this.service.reportTaskExecuteDone(task.id, 'system')
          return
        }
        const artifactPath = taskArtifactPath(project, task.id)
        if (!existsSync(artifactPath)) {
          this.failTask(task, `${role} ended but ${artifactPath} is missing`)
          return
        }
        if (role === 'research') {
          // Research conclusions need no human gate: verify and complete.
          this.service.reportTaskArtifactDone(task.id, artifactPath, 'system')
          this.service.verifyTaskDone(task.id, 'research artifact verified')
        } else {
          // Design parts keep the human confirmation gate.
          this.service.reportTaskArtifactDone(task.id, artifactPath, 'system')
        }
      } catch {
        // The task may have moved concurrently; the board is authoritative.
      }
    })
  }

  private async inspectAndSettle(
    sessionId: string,
    startedAt: number,
    sessions: readonly KanbanSessionSummary[] | undefined,
    settle: (outcome: Awaited<ReturnType<KanbanSessionRunner['inspect']>>) => void,
  ): Promise<void> {
    let outcome
    try {
      outcome = await this.runner.inspect(sessionId, startedAt, sessions)
    } catch {
      return // a transient inspection failure never settles a running phase
    }
    if (outcome.outcome === 'pending') return
    this.launchedAt.delete(sessionId)
    settle(outcome)
  }

  private schedulePoll(): void {
    if (this.pollInFlight || this.disposed) return
    this.pollInFlight = true
    void this.poll().catch(error => {
      console.error('[dsh-kanban] session polling failed', error)
    }).finally(() => {
      this.pollInFlight = false
    })
  }
}
