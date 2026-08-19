/**
 * Kanban spawner: wires the session runner into the host service's phase
 * hooks and reconciles running sessions with the board (the dsh-web-ui
 * task-board host-service poll pattern, Apache-2.0).
 *
 * - onEnterDesigning: resume the attached design session (rejection loop) or
 *   spawn a fresh one (create / blocked-recovery).
 * - onEnterExecuting: spawn a fresh execution session.
 * - A 5-second poll reconciles every active phase: turn/end → phase report;
 *   failure/cancellation → blocked; missing plan.md → blocked.
 * - On start, phases that survived a host restart are re-fired (re-prompt),
 *   so a crash mid-phase does not strand a project.
 */
import type { KanbanHostService } from './host-service.ts'
import { join } from 'node:path'
import type { Project } from './protocol.ts'
import { KanbanSessionRunner, type KanbanApi } from './session-runner.ts'

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
    })
    // Host-restart recovery: phases that survived the crash get re-fired.
    for (const project of this.service.snapshot().projects) {
      this.service.refirePhaseHooks(project.id)
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
    const result = await this.runPhase(project, async () => {
      if (project.sessionId !== undefined && project.sessionRole === 'design') {
        return { kind: 'resumed', sessionId: await this.runner.resumeDesign(project) }
      }
      return { kind: 'launched', sessionId: await this.runner.launchDesign(project) }
    })
    if (result.kind === 'failed') {
      this.fail(project, `design phase: ${result.error}`)
      return
    }
    this.launchedAt.set(result.sessionId, Date.now())
    if (result.kind === 'launched') this.service.attachSession(project.id, result.sessionId, 'design')
  }

  private async enterExecuting(project: Project): Promise<void> {
    const result = await this.runPhase(project, async () => {
      // Host-restart recovery: a run that was already attached to a session
      // continues in that session; only a phase with no session spawns fresh.
      if (project.sessionId !== undefined && project.sessionRole === 'execute') {
        return { kind: 'resumed', sessionId: await this.runner.resumeExecute(project) }
      }
      return { kind: 'launched', sessionId: await this.runner.launchExecute(project) }
    })
    if (result.kind === 'failed') {
      this.fail(project, `execution phase: ${result.error}`)
      return
    }
    this.launchedAt.set(result.sessionId, Date.now())
    if (result.kind === 'launched') this.service.attachSession(project.id, result.sessionId, 'execute')
  }

  private async runPhase(project: Project, launch: () => Promise<{ kind: 'launched'; sessionId: string } | { kind: 'resumed'; sessionId: string }>): Promise<SpawnResult> {
    try {
      return await launch()
    } catch (error) {
      return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  private fail(project: Project, note: string): void {
    try {
      this.service.markBlocked(project.id, note, 'system')
    } catch {
      // The project may have moved concurrently (e.g. human override); the
      // board's own state is authoritative.
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed) return
    const running = await this.runner.listRunning()
    for (const project of this.service.snapshot().projects) {
      if (project.sessionId === undefined) continue
      const role = project.sessionRole
      if (role !== 'design' && role !== 'execute') continue
      if (project.status !== 'designing' && project.status !== 'executing') continue
      const startedAt = this.launchedAt.get(project.sessionId) ?? 0
      let outcome
      try {
        outcome = await this.runner.inspect(project.sessionId, startedAt, running.known ? running.items : undefined)
      } catch {
        continue // a transient inspection failure never settles a running phase
      }
      if (outcome.outcome === 'pending') continue
      this.launchedAt.delete(project.sessionId)
      const note = 'error' in outcome ? `${outcome.outcome}: ${outcome.error}` : undefined
      if (outcome.outcome !== 'succeeded') {
        this.fail(project, `session ${project.sessionId} ${note ?? outcome.outcome}`)
        continue
      }
      try {
        if (role === 'design') {
          if (!this.runner.planExists(project)) {
            this.fail(project, `design ended but ${project.workspaceDir}/plan.md is missing`)
            continue
          }
          this.service.reportDesignDone(project.id, join(project.workspaceDir, 'plan.md'), 'system')
        } else {
          this.service.reportExecuteDone(project.id, 'system')
        }
      } catch {
        // The phase may have moved concurrently; the board is authoritative.
      }
    }
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
