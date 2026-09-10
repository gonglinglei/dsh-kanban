/**
 * The terminate/delete cancel wiring: the host service's session canceller
 * (registered in index.ts as `spawner.cancelSession`) sends the cancel RPC
 * and drops the launch timestamp so the poll loop never settles the
 * cancelled session afterwards.
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-cancel-'))
  vi.useFakeTimers()
  vi.setSystemTime(new Date(1_000_000_000_000))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function makeStack(): { service: KanbanHostService; api: FakeApi } {
  const service = new KanbanHostService(join(dir, 'projects.json'))
  service.start()
  const api = new FakeApi()
  const spawner = new KanbanSpawner(service, api)
  // The same wiring as src/index.ts.
  service.setSessionCanceller(sessionId => { void spawner.cancelSession(sessionId) })
  spawner.start()
  return { service, api }
}

function decomposeProject(service: KanbanHostService): string {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({
    decomposed: true,
    tasks: [{ title: '技术选型调研', kind: 'research' }],
  }), 'utf8')
  service.confirmPlan(project.id)
  return project.id
}

async function flush(ms = 5_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('KanbanSpawner session cancel wiring', () => {
  it('terminating a running leaf cancels its session and the poll never settles it again', async () => {
    const { service, api } = makeStack()
    const projectId = decomposeProject(service)
    await flush(1)
    const research = service.projectTasks(projectId)[0]!
    const sessionId = research.sessionId!
    expect(sessionId).toBeDefined()

    service.terminateTask(projectId, research.id)
    await flush(1)
    expect(api.sessions.cancelled).toEqual([sessionId])
    expect(service.getTask(research.id)?.status).toBe('blocked')

    // Even if the cancelled session then reports a turn/end, the blocked
    // leaf is out of the poll's scope: no further transitions, no respawn.
    const turnEnd: KanbanHistoryEvent = { event: { type: 'turn/end', seq: 1, time: Date.now(), data: {} } }
    api.sessions.histories.set(sessionId, [turnEnd])
    const summary = api.sessions.summaries.get(sessionId)!
    summary.running = false
    await flush()
    await flush()
    expect(service.getTask(research.id)?.status).toBe('blocked')
    expect(api.sessions.created).toHaveLength(2) // project design + research leaf only
  })

  it('deleting a running leaf cancels its session too', async () => {
    const { service, api } = makeStack()
    const projectId = decomposeProject(service)
    await flush(1)
    const research = service.projectTasks(projectId)[0]!
    const sessionId = research.sessionId!

    service.deleteTask(projectId, research.id)
    await flush(1)
    expect(api.sessions.cancelled).toEqual([sessionId])
    expect(service.getTask(research.id)).toBeUndefined()
  })
})
