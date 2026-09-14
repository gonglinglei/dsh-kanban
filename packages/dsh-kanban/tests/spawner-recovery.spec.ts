/**
 * The leaf recovery state machine, driven end-to-end through the poll.
 *
 * The production incident this pins down: a session's turn 1 died on a
 * recoverable 403 quota error, the board permanently blocked the leaf, a human
 * continued the SAME session 14 minutes later and turn 2 actually finished the
 * work — but the leaf was already out of the observation set forever.
 *
 * Covered here: the error turn keeps the leaf observing (policy A); a recovery
 * re-inspection settles a blocked leaf from the ALREADY-FINISHED turn without
 * ever prompting the session; terminal verdicts still converge; a system-parked
 * leaf is probed and made visible; a human-parked leaf is left alone.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { KanbanSpawner } from '../src/spawner.ts'
import { decompositionPathFor, projectDir, type KanbanHistoryEvent } from '../src/session-runner.ts'
import { FakeApi } from './fake-api.ts'

let dir: string
let ledger = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-leaf-recovery-'))
  ledger = 0
  vi.useFakeTimers()
  vi.setSystemTime(new Date(1_000_000_000_000))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function makeService(): KanbanHostService {
  const service = new KanbanHostService(join(dir, `projects-${++ledger}.json`))
  service.start()
  return service
}

async function flush(ms = 5_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** The incident's turn 1: a recoverable quota error behind HTTP 403. */
function quotaTurnEnd(seq = 201): KanbanHistoryEvent {
  return {
    event: {
      type: 'turn/end',
      seq,
      time: Date.now() + 1,
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

/** The incident's turn 2: the human's "继续" finished the work. */
function completedTurnEnd(seq = 436): KanbanHistoryEvent {
  return { event: { type: 'turn/end', seq, time: Date.now() + 2, data: { turn: 2, reason: { kind: 'completed' } } } }
}

function terminalTurnEnd(kind: 'max-tokens' | 'blocked' | 'interrupted' | 'aborted', seq = 9): KanbanHistoryEvent {
  return {
    event: {
      type: 'turn/end',
      seq,
      time: Date.now() + 1,
      data: { turn: 1, reason: kind === 'aborted' ? { kind, reason: { kind: 'user' } } : { kind } },
    },
  }
}

/** A project with one execute leaf whose session is attached and running. */
async function leafStack(decomposition: unknown[] = [{ title: '实现功能', kind: 'execute' }]) {
  const service = makeService()
  const api = new FakeApi()
  const spawner = new KanbanSpawner(service, api)
  spawner.start()
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks: decomposition }), 'utf8')
  service.confirmPlan(project.id)
  await flush()
  const leaf = service.projectTasks(project.id)[0]!
  const sessionId = leaf.sessionId!
  return { service, api, spawner, projectId: project.id, leafId: leaf.id, sessionId }
}

/** The stock-ledger shape: a leaf the SYSTEM parked, still holding its session. */
function parkBySystem(service: KanbanHostService, leafId: string, sessionId: string): void {
  service.markTaskBlocked(
    leafId,
    `session ${sessionId} failed: agent turn ended with an error`,
    'system',
    { at: 1, cause: 'turn-end', message: 'agent turn ended with an error', sessionId, recoverable: true },
  )
}

describe('policy A: an error turn keeps the leaf observing', () => {
  it('a quota error never blocks the leaf; a later completed turn settles it with zero extra prompts', async () => {
    const { service, api, projectId, leafId, sessionId } = await leafStack()
    const promptedAtLaunch = api.sessions.prompted.length

    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [quotaTurnEnd()])
    await flush()

    // Turn 1 failed but the leaf is NOT terminalized (this used to block in ≤1 tick).
    expect(service.getTask(leafId)?.status).toBe('executing')
    const observed = service.getTask(leafId)!.history.at(-1)!
    expect(observed.note).toContain('AUTH')
    expect(observed.note).toContain('403')
    expect(observed.note).toContain('usage limit')

    // The observation note is written once, not once per 5s tick.
    await flush(20_000)
    expect(service.getTask(leafId)!.history.filter(entry => entry.note?.includes('AUTH'))).toHaveLength(1)

    // Turn 2 (a human "继续" + a model switch) completes the work.
    api.sessions.histories.set(sessionId, [quotaTurnEnd(), completedTurnEnd()])
    await flush()
    expect(service.getTask(leafId)?.status).toBe('done')
    expect(service.getProject(projectId)?.status).toBe('done')
    // The already-finished session was never re-prompted.
    expect(api.sessions.prompted).toHaveLength(promptedAtLaunch)
  })

  it('a terminal turn/end still converges to blocked with its reason on the card', async () => {
    const { service, api, leafId, sessionId } = await leafStack()
    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [terminalTurnEnd('max-tokens')])
    await flush()

    const leaf = service.getTask(leafId)!
    expect(leaf.status).toBe('blocked')
    expect(leaf.lastFailure?.cause).toBe('turn-end')
    expect(leaf.lastFailure?.reason).toBe('max-tokens')
    expect(leaf.history.at(-1)?.note).toContain('output token ceiling')
  })

  it('a vanished session converges to blocked instead of leaving a zombie', async () => {
    const { service, api, leafId, sessionId } = await leafStack()
    api.sessions.summaries.delete(sessionId)
    await flush()

    const leaf = service.getTask(leafId)!
    expect(leaf.status).toBe('blocked')
    expect(leaf.lastFailure?.cause).toBe('session-missing')
    expect(leaf.lastFailure?.recoverable).toBe(false)
    expect(leaf.history.at(-1)?.note).toContain('cancelled')
  })
})

describe('recovery via re-inspection (the stock-card path)', () => {
  it('settles a system-parked leaf from its already-finished turn, without prompting', async () => {
    const { service, api, projectId, leafId, sessionId } = await leafStack()
    parkBySystem(service, leafId, sessionId)
    expect(service.getTask(leafId)?.status).toBe('blocked')
    const promptedBefore = api.sessions.prompted.length

    // The session's log already holds the successful turn 2 (it finished 14
    // minutes after the board had given up on it).
    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [quotaTurnEnd(), completedTurnEnd()])

    service.recoverTask(projectId, leafId, { strategy: 'reinspect' })
    expect(api.sessions.prompted).toHaveLength(promptedBefore) // opening the door prompts nothing
    await flush()

    const leaf = service.getTask(leafId)!
    expect(leaf.status).toBe('done')
    expect(leaf.recovery).toBeUndefined()
    const verdict = leaf.history.at(-1)!
    expect(verdict.note).toContain('recovery verdict')
    expect(verdict.note).toContain('kind=completed')
    expect(verdict.note).toContain('seq 436')
    // The old error turn can never push it back into blocked (陷阱 1).
    await flush(100_000)
    expect(service.getTask(leafId)?.status).toBe('done')
    expect(api.sessions.prompted).toHaveLength(promptedBefore)
    // A7/命题 D: the project follows its last leaf.
    expect(service.getProject(projectId)?.status).toBe('done')
  })

  it('keeps observing when the re-inspected session still only has an error turn (A4)', async () => {
    const { service, api, projectId, leafId, sessionId } = await leafStack()
    parkBySystem(service, leafId, sessionId)
    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [quotaTurnEnd()])
    const promptedBefore = api.sessions.prompted.length

    service.recoverTask(projectId, leafId)
    await flush(20_000)
    // Never re-blocked by the old error: the leaf is back under observation.
    expect(service.getTask(leafId)?.status).toBe('executing')
    expect(api.sessions.prompted).toHaveLength(promptedBefore)
  })

  it('converges back to blocked when the recovery window has no evidence at all', async () => {
    const { service, api, projectId, leafId, sessionId } = await leafStack()
    parkBySystem(service, leafId, sessionId)
    // Not running and no judgeable turn/end: waiting forever would be a zombie.
    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [])

    service.recoverTask(projectId, leafId)
    await flush()
    const leaf = service.getTask(leafId)!
    expect(leaf.status).toBe('blocked')
    expect(leaf.recovery).toBeUndefined()
    expect(leaf.lastFailure?.cause).toBe('recovery')
    expect(leaf.history.at(-1)?.note).toContain('no turn/end to judge')
  })

  it('converges back to blocked when the re-inspection finds a terminal verdict', async () => {
    const { service, api, projectId, leafId, sessionId } = await leafStack()
    parkBySystem(service, leafId, sessionId)
    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [terminalTurnEnd('max-tokens')])

    service.recoverTask(projectId, leafId)
    await flush()
    const leaf = service.getTask(leafId)!
    expect(leaf.status).toBe('blocked')
    expect(leaf.lastFailure?.cause).toBe('recovery')
    expect(leaf.history.at(-1)?.note).toContain('recovery verdict')
  })
})

describe('recovery probe: a system-parked leaf stays visible', () => {
  it('records the completion evidence once, without prompting and without moving the leaf', async () => {
    const { service, api, leafId, sessionId } = await leafStack()
    parkBySystem(service, leafId, sessionId)
    const promptedBefore = api.sessions.prompted.length
    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [quotaTurnEnd(), completedTurnEnd()])

    await flush()
    const leaf = service.getTask(leafId)!
    // The system may not leave blocked on its own: it only makes the case visible.
    expect(leaf.status).toBe('blocked')
    const candidate = leaf.history.at(-1)!
    expect(candidate.actor).toBe('system')
    expect(candidate.note).toContain('恢复复核')
    expect(candidate.note).toContain('seq 436')
    expect(api.sessions.prompted).toHaveLength(promptedBefore)

    // Probing is per distinct turn/end: no note spam over the following ticks.
    const notes = leaf.history.length
    await flush(50_000)
    expect(service.getTask(leafId)!.history).toHaveLength(notes)
  })

  it('never second-guesses a leaf the human parked', async () => {
    const { service, api, projectId, leafId, sessionId } = await leafStack()
    service.terminateTask(projectId, leafId)
    const historyLength = service.getTask(leafId)!.history.length
    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [quotaTurnEnd(), completedTurnEnd()])

    await flush(20_000)
    const leaf = service.getTask(leafId)!
    expect(leaf.status).toBe('blocked')
    expect(leaf.history).toHaveLength(historyLength)
    expect(leaf.history.at(-1)?.note).toBe('人工终止')
  })

  it('a leaf without a session is not probed at all', async () => {
    const { service, api, leafId, sessionId } = await leafStack()
    parkBySystem(service, leafId, sessionId)
    const historyLength = service.getTask(leafId)!.history.length
    api.sessions.summaries.delete(sessionId)
    await flush(10_000)
    expect(service.getTask(leafId)!.history).toHaveLength(historyLength)
  })
})
