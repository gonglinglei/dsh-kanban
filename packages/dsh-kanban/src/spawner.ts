/**
 * Kanban spawner: wires the session runner into the host service's phase
 * hooks and reconciles running sessions with the board (the dsh-web-ui
 * task-board shell + host-service poll pattern, Apache-2.0).
 *
 * - Projects: onEnterDesigning resumes/spawns the design session,
 *   onEnterExecuting spawns the execution session.
 * - Task leaves: research/design leaves spawn their own session on entering
 *   designing; execute leaves spawn theirs on entering executing. Clarify
 *   leaves have no session (the creator answers on the board).
 * - A 5-second poll reconciles every observed phase: the LAST turn/end in the
 *   observation window decides the phase (succeeded / observing / stopped /
 *   cancelled). An error turn is NOT a terminal leaf failure: the leaf keeps
 *   observing the same session for a later turn (recovery policy A), because
 *   the session can be continued by a human, a model switch or a restart.
 * - Session/phase coherence: a project is settled ONLY by the session whose
 *   role drives its CURRENT phase (designing ← design, executing ← execute).
 *   A session left over from a phase the project has left is inert — never
 *   inspected, never settled (see pollProject).
 * - A leaf parked in `blocked` by the SYSTEM keeps being probed
 *   (reconcile): when its session has since finished, the host writes an
 *   audit note recording that evidence. It never re-prompts and never moves
 *   the leaf itself (system may only move a node TO blocked).
 * - A human recovery request (`recover-task`) re-opens a blocked leaf and
 *   lets the same poll verdict settle it — without ever prompting the
 *   already-finished session.
 * - On start, phases that survived a host restart are re-fired (re-prompt),
 *   so a crash mid-phase does not strand a project. A leaf in a recovery
 *   window is exempt: it must be re-judged, never blindly re-prompted.
 */
import { existsSync } from 'node:fs'
import type { KanbanHostService } from './host-service.ts'
import type { Actor, FailureCause, FailureDiagnostic, Project, ProjectStatus, TaskNode } from './protocol.ts'
import {
  KanbanSessionRunner,
  failureDiagnostic,
  planPathFor,
  taskArtifactPath,
  turnEndDiagnostic,
  type ExecutionInspection,
  type KanbanApi,
  type KanbanSessionSummary,
  type ParentProjectContext,
  type TurnEndFacts,
} from './session-runner.ts'

const SESSION_POLL_MS = 5_000

/** Throttle window for repeated non-fatal anomalies (5s poll × whole-file write-through). */
const ANOMALY_THROTTLE_MS = 10 * 60_000

/**
 * The single prefix every recovery-derived note carries, so the recovery
 * verdict is greppable and its provenance is unambiguous in the history.
 */
const RECOVERY_NOTE_PREFIX = 'recovery verdict: '

export interface KanbanSpawnerOptions {
  /** Test seam: how long to wait between polls (default 5s). */
  pollIntervalMs?: number
}

/** One spawn attempt outcome (for tests and logging). */
export type SpawnResult = { kind: 'launched'; sessionId: string } | { kind: 'resumed'; sessionId: string } | { kind: 'failed'; error: string }

/**
 * What the poll should do with one inspected phase. A pure function of the
 * evidence (outcome + role + artifact existence) so "what counts as done" has
 * exactly one definition, shared by the poll and the recovery probe.
 */
export type SettlementDecision =
  /** Keep observing: the session is alive, or a normal window has no verdict yet. */
  | { kind: 'none' }
  /** Not running and no judgeable turn/end: only a recovery window may converge on this. */
  | { kind: 'no-evidence' }
  /** A non-terminal turn/end: keep the window open, surface the evidence once. */
  | { kind: 'observe'; note: string }
  /** The phase's work is finished. */
  | { kind: 'done' }
  /** research/design finished with its artifact: wait for the human gate (research self-verifies). */
  | { kind: 'awaiting-review'; artifactPath: string }
  /** Converge to blocked, with the machine-readable cause. */
  | { kind: 'blocked'; note: string; cause: FailureCause; diagnostic: FailureDiagnostic }

/** The role names decideSettlement understands. */
export type SettlementRole = 'research' | 'design' | 'execute' | 'project-design' | 'project-execute'

/** A project phase that is driven by a session of its own. */
export type ProjectPhaseRole = 'design' | 'execute'

/**
 * The ONE session role that legitimately drives each active project phase.
 * Returns undefined for a status no session drives (backlog /
 * awaiting-clarification / awaiting-review / done / blocked): those are either
 * waiting for the human or already over.
 *
 * Session/phase coherence is what this encodes: `attachSession` records the
 * role a session was launched for, and a later phase change does NOT rewrite
 * it (the design session stays attached after `confirmPlan` so a human
 * rejection can resume it). The poll must therefore compare the two, not
 * assume that any attached session drives whatever phase the project is in.
 */
export function projectPhaseRole(status: ProjectStatus): ProjectPhaseRole | undefined {
  switch (status) {
    case 'designing': return 'design'
    case 'executing': return 'execute'
    case 'backlog':
    case 'awaiting-clarification':
    case 'awaiting-review':
    case 'done':
    case 'blocked': return undefined
  }
}

/**
 * The prefix of the one-time audit note written when a project's attached
 * session belongs to a phase it has already left.
 */
export const PHASE_HANDOFF_PREFIX = '相位交棒：'

/**
 * Decide what one inspected phase implies. Pure: the caller supplies the
 * artifact facts (so this is unit-testable without a filesystem).
 */
export function decideSettlement(input: {
  role: SettlementRole
  sessionId: string
  outcome: ExecutionInspection
  /** The artifact path this role must have produced ('' when not applicable). */
  artifactPath: string
  /** Whether that artifact exists on disk. */
  artifactExists: boolean
}): SettlementDecision {
  const { role, sessionId, outcome, artifactPath, artifactExists } = input
  switch (outcome.outcome) {
    case 'pending':
      return outcome.pending === 'running' ? { kind: 'none' } : { kind: 'no-evidence' }
    case 'observing':
      return { kind: 'observe', note: outcome.note }
    case 'cancelled': {
      const message = `session ${sessionId} cancelled: ${outcome.error}`
      return { kind: 'blocked', note: message, cause: 'session-missing', diagnostic: failureDiagnostic('session-missing', message, sessionId) }
    }
    case 'stopped': {
      return {
        kind: 'blocked',
        note: outcome.note,
        cause: 'turn-end',
        diagnostic: turnEndDiagnostic(sessionId, outcome.turn, 'turn-end'),
      }
    }
    case 'succeeded': {
      if (role === 'project-design' || role === 'project-execute') return { kind: 'done' }
      if (role === 'execute') return { kind: 'done' }
      if (!artifactExists) {
        const message = `${role} ended but ${artifactPath} is missing`
        return { kind: 'blocked', note: message, cause: 'artifact-missing', diagnostic: failureDiagnostic('artifact-missing', message, sessionId) }
      }
      return { kind: 'awaiting-review', artifactPath }
    }
  }
}

/** The evidence key of an inspection (which turn/end we are looking at). */
function inspectionKey(outcome: ExecutionInspection): string {
  switch (outcome.outcome) {
    case 'pending': return `pending:${outcome.pending}`
    case 'cancelled': return 'cancelled'
    case 'succeeded':
    case 'observing':
    case 'stopped': {
      const turn = outcome.turn
      return `${outcome.outcome}:${turn.kind}:${turn.seq ?? turn.time ?? 'n/a'}`
    }
  }
}

/** The actor that wrote the leaf's CURRENT blocked status ('human' wins ties). */
function lastBlockActor(task: TaskNode): Actor | undefined {
  for (let index = task.history.length - 1; index >= 0; index -= 1) {
    const entry = task.history[index]!
    if (entry.to === 'blocked' && entry.from !== 'blocked') return entry.actor
  }
  return undefined
}

export class KanbanSpawner {
  private readonly runner: KanbanSessionRunner
  private readonly launchedAt = new Map<string, number>()
  /**
   * Task leaves whose spawn RPC is in flight. A hook-fired spawn (e.g. a
   * leaf materialized mid-tick by applyTaskAdditions) attaches its session
   * only after several awaited RPCs; without this guard the same tick's
   * dependency-release sweep would spawn a duplicate session.
   */
  private readonly spawning = new Set<string>()
  /**
   * Observation notes already written, keyed `${sessionId}:${turnKey}`: one
   * audit note per distinct turn/end, never one per 5-second tick.
   */
  private readonly notedTurnEnds = new Set<string>()
  /** Recovery probes already reported, keyed by leaf id → the turn key we reported. */
  private readonly reconciled = new Map<string, string>()
  /**
   * Phase handoffs already noted, keyed `${projectId}:${sessionId}:${role}:${status}`:
   * one audit line per superseded session, never one per 5s tick.
   */
  private readonly phaseHandoffNoted = new Set<string>()
  /** Anomaly warnings already logged, keyed `${scope}:${note}` → last log time. */
  private readonly anomalyLoggedAt = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined
  private pollInFlight = false
  private disposed = false
  private readonly pollIntervalMs: number

  constructor(
    private readonly service: KanbanHostService,
    api: KanbanApi,
    options: KanbanSpawnerOptions = {},
  ) {
    // The runner receives a narrow adapter over the Host Session Controller.
    this.runner = new KanbanSessionRunner(api)
    this.pollIntervalMs = options.pollIntervalMs ?? SESSION_POLL_MS
  }

  /**
   * Best-effort cancel of a session (terminate/delete entry point). Also
   * drops the launchedAt entry so a later poll tick never settles it.
   */
  async cancelSession(sessionId: string): Promise<void> {
    this.launchedAt.delete(sessionId)
    await this.runner.cancelSession(sessionId)
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
      this.spawning.clear()
      this.notedTurnEnds.clear()
      this.reconciled.clear()
      this.phaseHandoffNoted.clear()
      this.anomalyLoggedAt.clear()
    }
  }

  private async enterDesigning(project: Project): Promise<void> {
    const result = await this.runPhase(async () => {
      if (project.sessionId !== undefined && project.sessionRole === 'design') {
        return { kind: 'resumed', sessionId: await this.runner.resumeDesign(project) }
      }
      // Fresh start (never resumed): a persisted legacy planPath (root-level
      // plan.md) would misdirect planExists/design prompts, so drop it and
      // migrate the project to its per-project artifact directory. The clean-up
      // keeps pending task-additions requests; record that so a request that
      // survives a re-design is auditable instead of silent.
      this.service.resetPlanPath(project.id)
      this.service.noteKeptAdditionsOnFreshDesign(project.id)
      return { kind: 'launched', sessionId: await this.runner.launchDesign(project) }
    })
    if (result.kind === 'failed') {
      this.failProject(project, failureDiagnostic('launch', `design phase: ${result.error}`))
      return
    }
    this.launchedAt.set(result.sessionId, Date.now())
    if (result.kind === 'launched') this.service.attachSession(project.id, result.sessionId, 'design')
  }

  private async enterExecuting(project: Project): Promise<void> {
    // Long-running projects are pure board containers: no agent session ever.
    // This guard also covers pollProject (no sessionId → early return) and
    // host-restart refirePhaseHooks.
    if (project.lifecycle === 'long-running') return
    // Decomposed projects never run a project-level execute session — their
    // leaves do. This also covers a project whose execution split into new
    // leaves (noteExecutionSplit detached its session): a host restart must
    // not spawn a fresh project-level session for it.
    if (this.service.projectTasks(project.id).length > 0) return
    const result = await this.runPhase(async () => {
      // Host-restart recovery: a run that was already attached to a session
      // continues in that session; only a phase with no session spawns fresh.
      if (project.sessionId !== undefined && project.sessionRole === 'execute') {
        return { kind: 'resumed', sessionId: await this.runner.resumeExecute(project) }
      }
      return { kind: 'launched', sessionId: await this.runner.launchExecute(project, this.parentContext(project)) }
    })
    if (result.kind === 'failed') {
      this.failProject(project, failureDiagnostic('launch', `execution phase: ${result.error}`))
      return
    }
    this.launchedAt.set(result.sessionId, Date.now())
    if (result.kind === 'launched') this.service.attachSession(project.id, result.sessionId, 'execute')
  }

  private async enterTaskDesigning(task: TaskNode): Promise<void> {
    const project = this.service.getProject(task.projectId)
    if (project === undefined) return
    if (this.spawning.has(task.id)) return
    // Dependency scheduling: spawn only when every declared dependency (and,
    // for execute leaves, every clarification) is done.
    if (!this.dependenciesReady(task)) return
    this.spawning.add(task.id)
    try {
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
        this.failTask(task, failureDiagnostic('launch', `${task.kind} phase: ${result.error}`))
        return
      }
      this.launchedAt.set(result.sessionId, Date.now())
      if (result.kind === 'launched') this.service.attachTaskSession(task.id, result.sessionId, task.kind === 'research' ? 'research' : 'design')
    } finally {
      this.spawning.delete(task.id)
    }
  }

  private async enterTaskExecuting(task: TaskNode): Promise<void> {
    const project = this.service.getProject(task.projectId)
    if (project === undefined) return
    if (this.spawning.has(task.id)) return
    // Dependency scheduling: execute leaves spawn only when their declared
    // dependencies and every clarification of the project are done.
    if (!this.dependenciesReady(task)) return
    this.spawning.add(task.id)
    try {
      const result = await this.runPhase(async () => {
        if (task.sessionId !== undefined && task.sessionRole === 'execute') {
          return { kind: 'resumed', sessionId: await this.resumeTask(task, project) }
        }
        return { kind: 'launched', sessionId: await this.runner.launchExecuteTask(task, project, this.clarifications(task.projectId), this.parentContext(project)) }
      })
      if (result.kind === 'failed') {
        this.failTask(task, failureDiagnostic('launch', `execution phase: ${result.error}`))
        return
      }
      this.launchedAt.set(result.sessionId, Date.now())
      if (result.kind === 'launched') this.service.attachTaskSession(task.id, result.sessionId, 'execute')
    } finally {
      this.spawning.delete(task.id)
    }
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

  /** The parent long-running project's identity (one context line in execute prompts). */
  private parentContext(project: Project): ParentProjectContext | undefined {
    if (project.parentId === undefined) return undefined
    const parent = this.service.getProject(project.parentId)
    return parent === undefined ? undefined : { title: parent.title, goal: parent.goal }
  }

  private async runPhase(launch: () => Promise<{ kind: 'launched'; sessionId: string } | { kind: 'resumed'; sessionId: string }>): Promise<SpawnResult> {
    try {
      return await launch()
    } catch (error) {
      return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Park a project in blocked with a readable note AND the machine-readable
   * diagnostic (the note is the human view, the diagnostic the UI/audit one).
   */
  private failProject(project: Project, diagnostic: FailureDiagnostic, note?: string): void {
    try {
      this.service.markBlocked(project.id, note ?? diagnostic.message, 'system', diagnostic)
    } catch {
      // The project may have moved concurrently (e.g. human override); the
      // board's own state is authoritative.
    }
  }

  /** Same as failProject, for task leaves. */
  private failTask(task: TaskNode, diagnostic: FailureDiagnostic, note?: string): void {
    try {
      this.service.markTaskBlocked(task.id, note ?? diagnostic.message, 'system', diagnostic)
    } catch {
      // The task may have moved concurrently; the board is authoritative.
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed) return
    // Phase 0: freeze every settled task-additions request slot into an
    // immutable staged file. Filesystem bookkeeping only — zero ledger effect
    // and zero materialization: the requests still wait for a human click (or
    // for the settle path below), and freezing them is what stops a second
    // `write` in the same session from physically destroying the first.
    this.service.ingestPendingAdditions()
    const running = await this.runner.listRunning()
    for (const project of this.service.snapshot().projects) {
      // Publish what is waiting for this project. Assembly field only: no
      // saveState, no revision bump, and a broadcast only when it changed.
      this.service.refreshPendingAdditions(project.id)
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
    // Phase 4: throttled consistency diagnostics — a done project that still
    // has open leaves must never be a silent contradiction.
    this.service.reportAdditionsDiagnostics()
  }

  private async pollProject(project: Project, sessions: readonly KanbanSessionSummary[] | undefined): Promise<void> {
    if (project.sessionId === undefined) return
    const role = project.sessionRole
    if (role !== 'design' && role !== 'execute') return
    // A blocked project is left to a human (there is no project-level
    // recovery entry; human `transition` is any→any). Only active phases are
    // observed, and only by the session that actually drives them.
    const phaseRole = projectPhaseRole(project.status)
    if (phaseRole === undefined) return
    const sessionId = project.sessionId
    if (phaseRole !== role) {
      // Session/phase mismatch (the production defect behind board project
      // 18db4cdd): `confirmPlan` moves a DECOMPOSED project straight into
      // executing, so no project-level execute session is ever spawned and
      // the finished DESIGN session stays attached. Settling it here can only
      // replay a stale verdict — every 5s tick re-read the session's whole
      // event log (its launch timestamp is long gone, so startedAt = 0), and
      // `reportDesignDone` was rejected by the state machine
      // (executing → awaiting-review is not a system edge), which surfaced as
      // an '异常：settle rejected' note once per 10-minute throttle window.
      //
      // The session is left attached on purpose: a human rejection /
      // override back to designing resumes it with full context. It simply
      // is not this phase's driver.
      this.notePhaseHandoffOnce(project, sessionId, role)
      return
    }
    const startedAt = this.launchedAt.get(sessionId) ?? 0
    let outcome: ExecutionInspection
    try {
      outcome = await this.runner.inspect(sessionId, startedAt, sessions)
    } catch {
      return // a transient inspection failure never settles a running phase
    }
    if (outcome.outcome === 'pending') return
    if (outcome.outcome === 'observing') {
      // Never a silent spin: surface the evidence once per distinct turn/end.
      this.noteObservationOnce(`project:${project.id}`, sessionId, outcome.turn, () => {
        this.service.noteProjectObservation(project.id, outcome.note, 'system')
      })
      return
    }
    this.launchedAt.delete(sessionId)
    const decision = decideSettlement({
      role: phaseRole === 'design' ? 'project-design' : 'project-execute',
      sessionId,
      outcome,
      artifactPath: project.planPath ?? planPathFor(project),
      artifactExists: this.runner.planExists(project),
    })
    if (decision.kind === 'blocked') {
      this.failProject(project, decision.diagnostic, decision.note)
      return
    }
    if (decision.kind !== 'done') return
    try {
      if (role === 'design') {
        // planExists checks planPath first (legacy compat); report the
        // same path so a resumed legacy project keeps its recorded plan.
        const planPath = project.planPath ?? planPathFor(project)
        if (!this.runner.planExists(project)) {
          this.failProject(project, failureDiagnostic('artifact-missing', `design ended but ${planPath} is missing`, sessionId))
          return
        }
        this.service.reportDesignDone(project.id, planPath, 'system')
      } else {
        this.settleProjectExecute(project)
      }
    } catch (error) {
      // The phase may have moved concurrently (e.g. a project-level execute
      // session reporting design completion). Never swallow it silently: a
      // rejection here is exactly the "silent spin" the board used to hide.
      this.noteAnomaly(project.id, `settle rejected: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Project-level execute turn ended. Consume any task-additions request
   * FIRST: when the run split into new leaves, the project stays executing
   * (its session is detached via noteExecutionSplit) and must NOT be
   * reported done — the new leaves now derive the project's completion.
   *
   * The branch criterion is a STATE (does the project still have open
   * leaves?), never an EVENT (did this tick read a request file?): the scan
   * phase may already have consumed the request, and an empty batch used to
   * strand the project in executing forever.
   */
  private settleProjectExecute(project: Project): void {
    try {
      this.service.applyTaskAdditions(project.id)
    } catch (error) {
      this.failProject(project, failureDiagnostic('task-additions', `task additions: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    if (this.service.hasUnfinishedLeaves(project.id)) {
      try {
        this.service.noteExecutionSplit(project.id)
      } catch {
        // The project may have moved concurrently; the board is authoritative.
      }
      return
    }
    this.service.reportExecuteDone(project.id, 'system')
  }

  private async pollTask(task: TaskNode, sessions: readonly KanbanSessionSummary[] | undefined): Promise<void> {
    if (task.sessionId === undefined) return
    const role = task.sessionRole
    if (role !== 'research' && role !== 'design' && role !== 'execute') return
    // A leaf parked in blocked by the SYSTEM is still probed: when its session
    // later finished, a human must be able to see that (and be able to
    // recover it). A human-parked leaf is never second-guessed.
    if (task.status === 'blocked') {
      await this.reconcile(task, sessions)
      return
    }
    if (task.status !== 'designing' && task.status !== 'executing') return
    const project = this.service.getProject(task.projectId)
    if (project === undefined) return
    const sessionId = task.sessionId
    // A `reinspect` recovery has no observation anchor: the whole history is
    // in scope precisely so an ALREADY-FINISHED turn can settle the leaf.
    // (`requeue` abandons the old session, so it keeps the normal window.)
    const recovery = task.recovery
    const recoveryWindow = recovery !== undefined && recovery.strategy === 'reinspect'
    const startedAt = recoveryWindow ? 0 : (this.launchedAt.get(sessionId) ?? 0)
    let outcome: ExecutionInspection
    try {
      outcome = await this.runner.inspect(sessionId, startedAt, sessions)
    } catch {
      return // a transient inspection failure never settles a running phase
    }
    if (outcome.outcome === 'pending') {
      // A normal window with no evidence is just "not yet"; a recovery window
      // must converge instead of parking the leaf in executing forever.
      if (recoveryWindow && outcome.pending === 'no-evidence') {
        const message = `session ${sessionId} has no turn/end to judge; still blocked`
        this.failTask(task, failureDiagnostic('recovery', message, sessionId), `${RECOVERY_NOTE_PREFIX}${message}`)
      }
      return
    }
    if (outcome.outcome === 'observing') {
      // Keep the window (policy A is exactly "wait for the next turn in this
      // session") and surface the evidence once, so the card is never silent.
      this.noteObservationOnce(`task:${task.id}`, sessionId, outcome.turn, () => {
        this.service.noteTaskObservation(task.id, outcome.note, 'system')
      })
      return
    }
    this.launchedAt.delete(sessionId)
    const artifactPath = taskArtifactPath(project, task.id)
    const decision = decideSettlement({
      role,
      sessionId,
      outcome,
      artifactPath,
      artifactExists: role === 'execute' ? true : existsSync(artifactPath),
    })
    switch (decision.kind) {
      case 'none':
      case 'no-evidence':
      case 'observe':
        // Unreachable: pending/observing already returned above. Kept so the
        // switch stays exhaustive over SettlementDecision.
        return
      case 'blocked': {
        const diagnostic: FailureDiagnostic = recoveryWindow
          ? { ...decision.diagnostic, cause: 'recovery' }
          : decision.diagnostic
        const note = recoveryWindow ? `${RECOVERY_NOTE_PREFIX}${decision.note}` : decision.note
        this.failTask(task, diagnostic, note)
        return
      }
      case 'awaiting-review': {
        const note = recoveryWindow && this.isTurnOutcome(outcome)
          ? this.recoveryVerdictNote(sessionId, outcome.turn, 'artifact ready')
          : undefined
        // Applied through the service so the human gate stays intact.
        if (role === 'research') {
          this.service.reportTaskArtifactDone(task.id, decision.artifactPath, 'system', note)
          this.service.verifyTaskDone(task.id, 'research artifact verified')
        } else {
          this.service.reportTaskArtifactDone(task.id, decision.artifactPath, 'system', note)
        }
        return
      }
      case 'done': {
        // Consume any task-additions request BEFORE reporting done: the
        // new leaves keep the project executing (checkProjectCompletion
        // sees them unfinished), so order matters here.
        try {
          this.service.applyTaskAdditions(project.id)
        } catch (error) {
          this.failTask(task, failureDiagnostic('task-additions', `task additions: ${error instanceof Error ? error.message : String(error)}`))
          return
        }
        const note = recoveryWindow && this.isTurnOutcome(outcome)
          ? this.recoveryVerdictNote(sessionId, outcome.turn, 'execution done')
          : undefined
        this.service.reportTaskExecuteDone(task.id, 'system', note)
        return
      }
    }
  }

  /** Narrowing helper: whether the outcome carries a decided turn/end. */
  private isTurnOutcome(outcome: ExecutionInspection): outcome is { outcome: 'succeeded'; turn: TurnEndFacts } {
    return outcome.outcome === 'succeeded'
  }

  /**
   * The provenance note a recovered leaf's verdict carries (audit): which
   * session, which turn/end, and what was concluded.
   */
  private recoveryVerdictNote(sessionId: string, turn: TurnEndFacts, conclusion: string): string {
    const bits = [`session ${sessionId}`, `last turn/end kind=${turn.kind}`]
    if (turn.turn !== undefined) bits.push(`turn ${turn.turn}`)
    if (turn.seq !== undefined) bits.push(`seq ${turn.seq}`)
    if (turn.time !== undefined && turn.time > 0) bits.push(new Date(turn.time).toISOString())
    return `${RECOVERY_NOTE_PREFIX}${bits.join(', ')} → ${conclusion}`
  }

  /**
   * Record — exactly once — that a project's attached session has been left
   * behind by a phase change and is therefore no longer settled. This
   * replaces the recurring `settle rejected` anomaly (one throttled note per
   * 10 minutes, forever) with a single, accurate, greppable audit line, and
   * it is activity-neutral like every other observation note.
   */
  private notePhaseHandoffOnce(project: Project, sessionId: string, role: ProjectPhaseRole): void {
    const key = `${project.id}:${sessionId}:${role}:${project.status}`
    if (this.phaseHandoffNoted.has(key)) return
    this.phaseHandoffNoted.add(key)
    try {
      this.service.noteProjectObservation(
        project.id,
        `${PHASE_HANDOFF_PREFIX}会话 ${sessionId}（${role}）不再驱动当前相位 ${project.status}，已停止结算该会话；人工退回 designing 仍会复用它`,
        'system',
      )
    } catch {
      // The project may have moved concurrently; the board is authoritative.
    }
  }

  /**
   * Write one observation note per distinct turn/end. The set is in-memory
   * (a restart re-notes once — a harmless extra audit line, and far better
   * than either silence or a note per 5s tick).
   */
  private noteObservationOnce(scope: string, sessionId: string, turn: TurnEndFacts, write: () => void): void {
    const key = `${scope}:${sessionId}:${turn.kind}:${turn.seq ?? turn.time ?? 'n/a'}`
    if (this.notedTurnEnds.has(key)) return
    this.notedTurnEnds.add(key)
    try {
      write()
    } catch {
      // The node may have moved concurrently; the board is authoritative.
    }
  }

  /**
   * Probe a system-parked leaf: has its session finished since it was
   * blocked? The ONLY product is an audit note — the system may move a node
   * to blocked but never out of it, so a false block can never be silently
   * "fixed" by the machine; it is made visible, with evidence, and a human
   * opens the door (`recover-task`) or confirms the leaf.
   *
   * No prompt is possible here: the probe only reads, and the only resume
   * path (host-restart refire) never fires for a blocked leaf.
   *
   * Cost, deliberately accepted: one extra full-history inspect per tick per
   * system-parked leaf that still holds a session (normally 0–1 leaves). The
   * note write is limited to once per distinct turn/end, but the probe must
   * repeat — only a repeated probe can notice that the session finally
   * finished. That is the price of "no leaf stays permanently pinned".
   */
  private async reconcile(task: TaskNode, sessions?: readonly KanbanSessionSummary[]): Promise<void> {
    const sessionId = task.sessionId
    if (sessionId === undefined) return
    // Human authority: a leaf a human parked must never be second-guessed,
    // and an unattributable block is left alone too.
    if (lastBlockActor(task) !== 'system') return
    const role = task.sessionRole
    if (role !== 'research' && role !== 'design' && role !== 'execute') return
    const project = this.service.getProject(task.projectId)
    if (project === undefined) return
    let outcome: ExecutionInspection
    try {
      outcome = await this.runner.inspect(sessionId, 0, sessions)
    } catch {
      return
    }
    const key = inspectionKey(outcome)
    if (this.reconciled.get(task.id) === key) return
    this.reconciled.set(task.id, key)
    const artifactPath = taskArtifactPath(project, task.id)
    const decision = decideSettlement({
      role,
      sessionId,
      outcome,
      artifactPath,
      artifactExists: role === 'execute' ? true : existsSync(artifactPath),
    })
    if (decision.kind !== 'done' && decision.kind !== 'awaiting-review') return
    try {
      this.service.noteTaskObservation(task.id, recoveryCandidateNote(sessionId, outcome), 'system')
    } catch {
      // The leaf may have moved concurrently; the board is authoritative.
    }
  }

  /**
   * Non-fatal but actionable anomalies (e.g. a settlement rejected because
   * the node moved): always visible in the host log, throttled in the
   * ledger — an unthrottled writer on a 5s poll would turn the whole-file
   * ledger write-through into a write amplifier.
   */
  private noteAnomaly(projectId: string, note: string): void {
    console.warn(`[dsh-kanban] project ${projectId} ${note}`)
    const key = `${projectId}:${note}`
    const now = Date.now()
    const last = this.anomalyLoggedAt.get(key)
    if (last !== undefined && now - last < ANOMALY_THROTTLE_MS) return
    this.anomalyLoggedAt.set(key, now)
    try {
      this.service.noteAnomaly(projectId, note)
    } catch {
      // Anomaly reporting is best-effort by definition.
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

/**
 * The audit note written when a system-parked leaf turns out to have finished
 * its work: the evidence a human needs to converge it (B3), without the
 * system touching the leaf's status.
 */
export function recoveryCandidateNote(sessionId: string, outcome: ExecutionInspection): string {
  if (outcome.outcome === 'succeeded') {
    const turn = outcome.turn
    const parts = [`kind=${turn.kind}`]
    if (turn.turn !== undefined) parts.push(`turn ${turn.turn}`)
    if (turn.seq !== undefined) parts.push(`seq ${turn.seq}`)
    if (turn.time !== undefined && turn.time > 0) parts.push(new Date(turn.time).toISOString())
    return `恢复复核：会话 ${sessionId} 最后一个 turn/end 为 ${parts.join(', ')}，已具备完成依据，等待人工确认收敛`
  }
  return `恢复复核：会话 ${sessionId} 已具备收敛依据（${outcome.outcome}），等待人工确认收敛`
}
