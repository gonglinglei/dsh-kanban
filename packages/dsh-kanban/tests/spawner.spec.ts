import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { KanbanSpawner } from '../src/spawner.ts'
import type { KanbanHistoryEvent, KanbanSessionSummary } from '../src/session-runner.ts'
import { FakeApi } from './fake-api.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-spawner-'))
  vi.useFakeTimers()
  // Pinned clock: launchedAt timestamps and turn/end event times must be
  // comparable within one test (fake timers otherwise start at real now).
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

function turnEnd(time: number): KanbanHistoryEvent {
  return { event: { type: 'turn/end', seq: 1, time, data: {} } }
}

/** Let the async spawn/resume chains and one poll tick settle. */
async function flush(ms = 5_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('KanbanSpawner', () => {
  it('spawns a design session on create and attaches it to the project', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    await flush(1)
    expect(api.sessions.created).toHaveLength(1)
    expect(service.getProject(project.id)?.sessionId).toBe('sess-1')
    expect(service.getProject(project.id)?.sessionRole).toBe('design')
  })

  it('walks the relay: design done (with plan.md) → awaiting-review; confirm → execute done → done', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    await flush(1)

    // Design turn finishes with the plan artifact on disk.
    writeFileSync(join(dir, 'plan.md'), '# 方案', 'utf8')
    api.sessions.summaries.set('sess-1', { sessionId: 'sess-1', running: false })
    api.sessions.histories.set('sess-1', [turnEnd(Date.now() + 1)])
    await flush()
    expect(service.getProject(project.id)?.status).toBe('awaiting-review')
    expect(service.getProject(project.id)?.planPath).toBe(join(dir, 'plan.md'))

    // Human confirms → execution session spawns.
    service.confirmPlan(project.id)
    await flush(1)
    expect(api.sessions.created).toHaveLength(2)
    expect(service.getProject(project.id)?.sessionRole).toBe('execute')

    // Execution turn finishes.
    api.sessions.summaries.set('sess-2', { sessionId: 'sess-2', running: false })
    api.sessions.histories.set('sess-2', [turnEnd(Date.now() + 1)])
    await flush()
    expect(service.getProject(project.id)?.status).toBe('done')
  })

  it('blocks a design that ended without producing plan.md', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    await flush(1)
    api.sessions.summaries.set('sess-1', { sessionId: 'sess-1', running: false })
    api.sessions.histories.set('sess-1', [turnEnd(Date.now() + 1)])
    await flush()
    expect(service.getProject(project.id)?.status).toBe('blocked')
    expect(service.getProject(project.id)?.history.at(-1)?.note).toContain('plan.md is missing')
  })

  it('blocks a failed session run', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    await flush(1)
    api.sessions.summaries.set('sess-1', { sessionId: 'sess-1', running: false })
    api.sessions.histories.set('sess-1', [{ event: { type: 'turn/end', seq: 1, time: Date.now() + 1, data: { reason: { kind: 'error' } } } }])
    await flush()
    expect(service.getProject(project.id)?.status).toBe('blocked')
  })

  it('resumes the same design session on rejection, with the feedback', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    await flush(1)
    writeFileSync(join(dir, 'plan.md'), '# 方案', 'utf8')
    api.sessions.summaries.set('sess-1', { sessionId: 'sess-1', running: false })
    api.sessions.histories.set('sess-1', [turnEnd(Date.now() + 1)])
    await flush()
    expect(service.getProject(project.id)?.status).toBe('awaiting-review')

    service.rejectPlan(project.id, '需要预算章节')
    await flush(1)
    // No new session: the attached design session was re-prompted.
    expect(api.sessions.created).toHaveLength(1)
    expect(api.sessions.prompted.at(-1)?.sessionId).toBe('sess-1')
    expect(api.sessions.prompted.at(-1)?.text).toContain('需要预算章节')
    expect(service.getProject(project.id)?.status).toBe('designing')
  })

  it('blocks when the session launch fails', async () => {
    const service = makeService()
    const api = new FakeApi()
    api.sessions.create = async () => ({ result: { ok: false as const, error: { code: 'x', message: 'cannot create' } } })
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    await flush(1)
    expect(service.getProject(project.id)?.status).toBe('blocked')
    expect(service.getProject(project.id)?.history.at(-1)?.note).toContain('design phase')
  })

  it('recovers phases that survived a host restart by re-firing the hook', async () => {
    const service = makeService()
    // Project exists with an attached design session but no spawner (crash
    // happened after attach, before completion).
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    service.attachSession(project.id, 'sess-old', 'design')

    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start() // recovery refire: resume the attached session
    await flush(1)
    expect(api.sessions.prompted.at(-1)?.sessionId).toBe('sess-old')
  })
})
