/**
 * Session/phase coherence for PROJECT-level sessions.
 *
 * The production defect this pins down (board project
 * 18db4cdd-3bdc-4bff-a011-51a3032063af, and its sibling 0c724876): a project
 * whose design was confirmed AND decomposed moves straight into `executing`
 * — `confirmPlan` materializes the leaves, so no project-level execute
 * session is ever spawned and the finished DESIGN session stays attached
 * (`sessionRole = 'design'`).
 *
 * The 5s poll used to decide the settlement role from `sessionRole` alone and
 * only asked whether the status was *some* active phase, so that stale design
 * session kept being settled as the current phase's driver:
 *   1. its launch timestamp was cleared when the design settled, so every tick
 *      re-read the session's WHOLE event log (a full-history replay, forever);
 *   2. the replay always ends with the old `completed` turn, `decideSettlement
 *      ('project-design')` says done, and `reportDesignDone` is refused by the
 *      state machine (executing → awaiting-review is not a system edge), which
 *      surfaced as `异常：settle rejected: ...` once per 10-minute throttle
 *      window — for the rest of the project's life.
 *
 * Fixed by `projectPhaseRole`: a project is settled only by the session whose
 * role drives its CURRENT phase (designing ← design, executing ← execute).
 * A superseded session is left attached (a human rejection back to designing
 * still resumes it) but is never inspected or settled, and the handoff is
 * recorded exactly once.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import type { Project } from '../src/protocol.ts'
import { KanbanSpawner, PHASE_HANDOFF_PREFIX, decideSettlement, projectPhaseRole } from '../src/spawner.ts'
import {
  KanbanSessionRunner,
  decompositionPathFor,
  planPathFor,
  projectDir,
  type KanbanHistoryEvent,
} from '../src/session-runner.ts'
import { FakeApi } from './fake-api.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-phase-'))
  vi.useFakeTimers()
  vi.setSystemTime(new Date(1_000_000_000_000))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function makeService(): KanbanHostService {
  const service = new KanbanHostService(join(dir, 'projects.json'))
  service.start()
  return service
}

function turnEnd(time: number, seq = 1): KanbanHistoryEvent {
  return { event: { type: 'turn/end', seq, time, data: {} } }
}

/** A recoverable error turn (the incident's quota shape): keeps a leaf observing. */
function errorTurnEnd(time: number, seq = 201): KanbanHistoryEvent {
  return {
    event: {
      type: 'turn/end',
      seq,
      time,
      data: {
        turn: 1,
        reason: {
          kind: 'error',
          error: { message: "You've reached your 5-hour usage limit", code: 'AUTH', status: 403 },
        },
      },
    },
  }
}

async function flush(ms = 5_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/**
 * The incident's exact shape: a project whose decomposed plan was confirmed.
 * The (finished) design session stays attached to the executing project.
 */
async function confirmedDecomposedProject(
  service: KanbanHostService,
  api: FakeApi,
  tasks: unknown[] = [{ title: '实现功能', kind: 'execute' }],
): Promise<Project> {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  await flush(1) // the design session spawns and attaches (designing + design)
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(planPathFor(project), '# 方案', 'utf8')
  writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks }), 'utf8')
  api.sessions.summaries.set('sess-1', { sessionId: 'sess-1', running: false })
  api.sessions.histories.set('sess-1', [turnEnd(Date.now() + 1, 201)])
  await flush() // design settles → awaiting-review
  expect(service.getProject(project.id)?.status).toBe('awaiting-review')
  service.confirmPlan(project.id)
  await flush(1) // leaves materialize; the project is executing, still holding sess-1
  return service.getProject(project.id)!
}

/** Count the sessions the poll actually reads (the replay the bug paid for). */
function watchInspections(api: FakeApi): string[] {
  const inspected: string[] = []
  const real = api.inspect
  api.inspect = async sessionId => {
    inspected.push(sessionId)
    return real(sessionId)
  }
  return inspected
}

function notes(project: Project, prefix: string): string[] {
  return project.history.map(entry => entry.note ?? '').filter(note => note.startsWith(prefix))
}

describe('projectPhaseRole: which session may drive which phase', () => {
  it('maps each active phase to its own session role and nothing else', () => {
    expect(projectPhaseRole('designing')).toBe('design')
    expect(projectPhaseRole('executing')).toBe('execute')
    for (const status of ['backlog', 'awaiting-review', 'done', 'blocked'] as const) {
      expect(projectPhaseRole(status)).toBeUndefined()
    }
  })
})

describe('the defect: an executing project settled by its stale design session', () => {
  it('the stale session really would settle as design-executed (the anomaly source)', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    const dispose = spawner.start()
    const project = await confirmedDecomposedProject(service, api)

    // The premise of the bug: the project is executing while its attached
    // session is the finished design one, whose log ends with a successful
    // turn — read over the WHOLE history, because its launch timestamp was
    // dropped when the design settled.
    expect(project.status).toBe('executing')
    expect(project.sessionRole).toBe('design')
    expect(project.sessionId).toBe('sess-1')

    const outcome = await new KanbanSessionRunner(api).inspect('sess-1', 0)
    expect(outcome.outcome).toBe('succeeded')
    expect(decideSettlement({
      role: 'project-design',
      sessionId: 'sess-1',
      outcome,
      artifactPath: planPathFor(project),
      artifactExists: true,
    })).toEqual({ kind: 'done' })

    // Applying that verdict is what the state machine refuses — exactly the
    // rejection the poll used to swallow into a 10-minute anomaly note.
    expect(() => service.reportDesignDone(project.id, planPathFor(project)))
      .toThrowError(/may not move a project from executing to awaiting-review/)

    dispose()
  })

  it('never inspects or settles the superseded session: no replay, no anomaly note', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    const dispose = spawner.start()
    const project = await confirmedDecomposedProject(service, api)
    const leaf = service.projectTasks(project.id)[0]!
    const leafSession = leaf.sessionId!

    // Keep the leaf alive but judgeable, so the poll really does read a
    // session every tick (an observing error turn, policy A).
    api.sessions.summaries.set(leafSession, { sessionId: leafSession, running: false })
    api.sessions.histories.set(leafSession, [errorTurnEnd(Date.now() + 1)])

    const inspected = watchInspections(api)
    const before = service.getProject(project.id)!
    const historyBefore = before.history.length

    // Twelve poll ticks (a minute of board time): the stale design session
    // must not be read once — no full-history replay, no stale verdict.
    await flush(60_000)

    expect(inspected).not.toContain('sess-1')
    // ...while the poll is demonstrably alive: it reads the running leaf.
    expect(inspected).toContain(leafSession)
    expect(service.getTask(leaf.id)?.status).toBe('executing')

    const after = service.getProject(project.id)!
    expect(after.status).toBe('executing')
    // The recurring `异常：settle rejected` note is gone for good.
    expect(after.history.some(entry => entry.note?.includes('settle rejected'))).toBe(false)
    expect(after.history.some(entry => entry.note?.startsWith('异常：'))).toBe(false)

    // The handoff is recorded exactly once, with the evidence a human needs.
    const handoffs = notes(after, PHASE_HANDOFF_PREFIX)
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]).toContain('sess-1')
    expect(handoffs[0]).toContain('design')
    expect(handoffs[0]).toContain('executing')

    // One note total: the ledger is not a per-tick write amplifier either.
    expect(after.history.length).toBe(historyBefore + 1)
    await flush(60_000)
    expect(service.getProject(project.id)!.history.length).toBe(historyBefore + 1)
    expect(inspected.filter(id => id === 'sess-1')).toHaveLength(0)

    // The project's real work still converges: the leaf finishes → done.
    api.sessions.histories.set(leafSession, [turnEnd(Date.now() + 1, 436)])
    await flush()
    expect(service.getTask(leaf.id)?.status).toBe('done')
    expect(service.getProject(project.id)?.status).toBe('done')

    dispose()
  })

  it('the left-behind session is still reusable: a human return to designing resumes it and the poll settles it', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    const dispose = spawner.start()
    const project = await confirmedDecomposedProject(service, api)
    expect(api.sessions.created).toHaveLength(2) // project design + the execute leaf

    // Human override back to design: the attached design session is resumed
    // (that is exactly why the mismatch must not detach it).
    service.transition(project.id, 'designing', '重新设计')
    await flush(1)
    expect(service.getProject(project.id)?.status).toBe('designing')
    expect(service.getProject(project.id)?.sessionRole).toBe('design')
    expect(api.sessions.created).toHaveLength(2) // no third session: the old one resumed
    expect(api.sessions.prompted.at(-1)?.sessionId).toBe('sess-1')

    // The resumed turn ends: with the phase and the role coherent again, the
    // poll settles it normally (designing → awaiting-review).
    api.sessions.histories.set('sess-1', [turnEnd(Date.now() + 1, 201), turnEnd(Date.now() + 2, 202)])
    await flush()
    expect(service.getProject(project.id)?.status).toBe('awaiting-review')

    dispose()
  })
})
