/**
 * The task-level recovery entry: `recoverTask` only opens the door (validate →
 * record the intent → move the leaf back into an active status). The verdict
 * itself is written by the spawner's next re-inspection, which is why this
 * suite asserts on state, markers and audit notes — never on a verdict.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { decompositionPathFor, projectDir } from '../src/session-runner.ts'
import { TransitionError } from '../src/state-machine.ts'

let dir: string
let ledger = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-recovery-'))
  ledger = 0
  vi.useFakeTimers()
  vi.setSystemTime(new Date(1_000_000_000_000))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** Every service gets its own ledger file: these tests build independent boards. */
function makeService(): KanbanHostService {
  const service = new KanbanHostService(join(dir, `projects-${++ledger}.json`))
  service.start()
  return service
}

/** A project with the given decomposition already confirmed (no spawner: sessions are attached by hand). */
function serviceWithLeaves(tasks: unknown[]): { service: KanbanHostService; projectId: string } {
  const service = makeService()
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks }), 'utf8')
  service.confirmPlan(project.id)
  return { service, projectId: project.id }
}

function onlyLeaf(service: KanbanHostService, projectId: string) {
  const leaves = service.projectTasks(projectId)
  expect(leaves).toHaveLength(1)
  return leaves[0]!
}

describe('recoverTask', () => {
  it('re-opens a blocked execute leaf for re-inspection without touching its session', () => {
    const { service, projectId } = serviceWithLeaves([{ title: '实现功能', kind: 'execute' }])
    const leaf = onlyLeaf(service, projectId)
    service.attachTaskSession(leaf.id, 'session-x', 'execute')
    service.markTaskBlocked(leaf.id, 'session session-x failed: AUTH (HTTP 403) quota', 'system')

    const recovered = service.recoverTask(projectId, leaf.id, { strategy: 'reinspect', note: '存量卡片处置' })
    expect(recovered.status).toBe('executing')
    expect(recovered.sessionId).toBe('session-x')
    expect(recovered.sessionRole).toBe('execute')
    expect(recovered.recovery).toMatchObject({ strategy: 'reinspect', sessionId: 'session-x' })
    const last = recovered.history.at(-1)!
    expect(last).toMatchObject({ actor: 'human', from: 'blocked', to: 'executing' })
    expect(last.note).toContain('人工请求恢复')
    expect(last.note).toContain('session-x')
    expect(last.note).toContain('存量卡片处置')
  })

  it('defaults to reinspect with a session attached and requeue without one', () => {
    const { service, projectId } = serviceWithLeaves([
      { title: '有会话', kind: 'execute' },
      { title: '无会话', kind: 'execute' },
    ])
    const [withSession, withoutSession] = service.projectTasks(projectId)
    service.attachTaskSession(withSession!.id, 'session-y', 'execute')
    service.markTaskBlocked(withSession!.id, 'boom', 'system')
    service.markTaskBlocked(withoutSession!.id, 'boom', 'system')

    expect(service.recoverTask(projectId, withSession!.id).recovery?.strategy).toBe('reinspect')
    const requeued = service.recoverTask(projectId, withoutSession!.id)
    expect(requeued.recovery?.strategy).toBe('requeue')
    expect(requeued.status).toBe('executing')
  })

  it('requeue abandons the old session: it is cancelled and unbound', () => {
    const { service, projectId } = serviceWithLeaves([{ title: '实现功能', kind: 'execute' }])
    const leaf = onlyLeaf(service, projectId)
    service.attachTaskSession(leaf.id, 'session-z', 'execute')
    service.markTaskBlocked(leaf.id, 'boom', 'system')
    const cancelled: string[] = []
    service.setSessionCanceller(sessionId => { cancelled.push(sessionId) })

    const requeued = service.recoverTask(projectId, leaf.id, { strategy: 'requeue' })
    expect(cancelled).toEqual(['session-z'])
    expect(requeued.sessionId).toBeUndefined()
    expect(requeued.sessionRole).toBeUndefined()
    expect(requeued.recovery).toMatchObject({ strategy: 'requeue', sessionId: 'session-z' })
    expect(requeued.history.at(-1)?.note).toContain('解除旧会话')
  })

  it('refuses a leaf that is not blocked, a second click, and a session-less reinspect', () => {
    const { service, projectId } = serviceWithLeaves([{ title: '实现功能', kind: 'execute' }])
    const leaf = onlyLeaf(service, projectId)

    // Not blocked yet.
    expect(() => service.recoverTask(projectId, leaf.id)).toThrowError(/is not blocked/)

    service.attachTaskSession(leaf.id, 'session-w', 'execute')
    service.markTaskBlocked(leaf.id, 'boom', 'system')
    service.recoverTask(projectId, leaf.id)
    // Double click: the first request is still awaiting its verdict.
    expect(() => service.recoverTask(projectId, leaf.id)).toThrowError(/already awaiting a recovery verdict/)
  })

  it('refuses reinspect without a session, and points at requeue instead', () => {
    const { service, projectId } = serviceWithLeaves([{ title: '实现功能', kind: 'execute' }])
    const leaf = onlyLeaf(service, projectId)
    service.markTaskBlocked(leaf.id, 'boom', 'system')
    expect(() => service.recoverTask(projectId, leaf.id, { strategy: 'reinspect' })).toThrowError(/no session to re-inspect/)
  })

  it('reopens a blocked clarify leaf as a fresh question (no recovery marker)', () => {
    const { service, projectId } = serviceWithLeaves([{ title: '明确需求', kind: 'clarify', question: '口径是？' }])
    const leaf = onlyLeaf(service, projectId)
    service.confirmTask(projectId, leaf.id)
    service.markTaskBlocked(leaf.id, 'no activity for 1 minutes', 'system')

    // A clarify leaf has no agent session: reinspect is meaningless.
    expect(() => service.recoverTask(projectId, leaf.id, { strategy: 'reinspect' })).toThrowError(/has no agent session/)
    const reopened = service.recoverTask(projectId, leaf.id, { strategy: 'requeue' })
    expect(reopened.status).toBe('awaiting-clarification')
    expect(reopened.recovery).toBeUndefined()
    expect(reopened.history.at(-1)?.note).toContain('人工重开澄清')
  })

  it('a recovery window is never resumed by the host-restart refire', () => {
    const { service, projectId } = serviceWithLeaves([{ title: '实现功能', kind: 'execute' }])
    const leaf = onlyLeaf(service, projectId)
    service.attachTaskSession(leaf.id, 'session-r', 'execute')
    service.markTaskBlocked(leaf.id, 'boom', 'system')
    service.recoverTask(projectId, leaf.id)
    const hooks: string[] = []
    service.setSpawnHooks({
      onEnterDesigning: () => {},
      onEnterExecuting: () => {},
      onEnterTaskDesigning: () => {},
      onEnterTaskExecuting: task => { hooks.push(task.id) },
    })
    service.refireTaskPhaseHooks(leaf.id)
    expect(hooks).toEqual([])
    // Without the marker the same hook fires (the gate is the marker, not the status).
    const plain = serviceWithLeaves([{ title: '另一个', kind: 'execute' }])
    plain.service.setSpawnHooks({
      onEnterDesigning: () => {},
      onEnterExecuting: () => {},
      onEnterTaskDesigning: () => {},
      onEnterTaskExecuting: task => { hooks.push(task.id) },
    })
    plain.service.refireTaskPhaseHooks(onlyLeaf(plain.service, plain.projectId).id)
    expect(hooks).toHaveLength(1)
  })

  it('the recovery marker is cleared by any commit that leaves an active status', () => {
    const { service, projectId } = serviceWithLeaves([{ title: '实现功能', kind: 'execute' }])
    const leaf = onlyLeaf(service, projectId)
    service.attachTaskSession(leaf.id, 'session-q', 'execute')
    service.markTaskBlocked(leaf.id, 'boom', 'system')
    service.recoverTask(projectId, leaf.id)
    expect(service.getTask(leaf.id)?.recovery).toBeDefined()

    const done = service.reportTaskExecuteDone(leaf.id)
    expect(done.status).toBe('done')
    expect(done.recovery).toBeUndefined()
    expect(service.getProject(projectId)?.status).toBe('done')
  })

  it('a blocked execute leaf can still be converged by the existing human confirm edge', () => {
    const { service, projectId } = serviceWithLeaves([{ title: '实现功能', kind: 'execute' }])
    const leaf = onlyLeaf(service, projectId)
    service.markTaskBlocked(leaf.id, 'session session-7bcb72ad failed: agent turn ended with an error', 'system')
    service.confirmTask(projectId, leaf.id)
    expect(service.getTask(leaf.id)?.status).toBe('done')
    expect(service.getProject(projectId)?.status).toBe('done')
  })
})

describe('failure diagnostics and observation notes', () => {
  it('markTaskBlocked stores the diagnostic next to the note', () => {
    const { service, projectId } = serviceWithLeaves([{ title: '实现功能', kind: 'execute' }])
    const leaf = onlyLeaf(service, projectId)
    const diagnostic = {
      at: 123,
      cause: 'turn-end' as const,
      message: 'session s failed: AUTH (HTTP 403) usage limit',
      reason: 'error',
      code: 'AUTH',
      status: 403,
      recoverable: true,
    }
    const blocked = service.markTaskBlocked(leaf.id, diagnostic.message, 'system', diagnostic)
    expect(blocked.status).toBe('blocked')
    expect(blocked.lastFailure).toEqual(diagnostic)
    expect(blocked.history.at(-1)?.note).toBe(diagnostic.message)
  })

  it('noteTaskObservation keeps the status and the activity clock intact', () => {
    const { service, projectId } = serviceWithLeaves([{ title: '实现功能', kind: 'execute' }])
    const leaf = onlyLeaf(service, projectId)
    const before = service.getTask(leaf.id)!
    const version = before.version
    const activity = before.lastActivityAt
    vi.advanceTimersByTime(60_000)

    const noted = service.noteTaskObservation(leaf.id, 'session s failed: boom', 'system')
    expect(noted.status).toBe(before.status)
    expect(noted.version).toBe(version + 1)
    // Deliberate: refreshing activity here would defeat the only stale valve.
    expect(noted.lastActivityAt).toBe(activity)
    expect(noted.updatedAt).toBe(activity + 60_000)
    expect(noted.history.at(-1)).toMatchObject({
      actor: 'system',
      from: before.status,
      to: before.status,
      note: 'session s failed: boom',
    })
  })

  it('the stale timer records a diagnostic and never parks a clarify leaf that waits for a human', () => {
    const { service, projectId } = serviceWithLeaves([
      { title: '明确需求', kind: 'clarify', question: '口径是？' },
      { title: '实现功能', kind: 'execute' },
    ])
    service.setMaxStaleMinutes(1)
    vi.advanceTimersByTime(90_000)

    const clarify = service.projectTasks(projectId).find(task => task.kind === 'clarify')!
    const execute = service.projectTasks(projectId).find(task => task.kind === 'execute')!
    // Waiting for the human is not staleness; a silent working phase still is.
    expect(clarify.status).toBe('awaiting-clarification')
    expect(execute.status).toBe('blocked')
    expect(execute.lastFailure?.cause).toBe('stale')
  })
})
