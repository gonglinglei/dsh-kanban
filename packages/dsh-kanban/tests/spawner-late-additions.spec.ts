/**
 * The scan phase's contracts (spawner side).
 *
 * The per-tick probe is the only thing standing between "a request exists on
 * disk" and "the board says nothing": it must be a PURE READ (zero ledger
 * writes, otherwise a 5-second tick becomes a write amplifier), it must never
 * materialize on its own (方案 B: the human click is the gate), and a
 * contradiction it discovers (a done project with open leaves, a broken
 * request) must be surfaced once — not once per tick.
 *
 * It also pins the two settlement-ordering fixes: an empty batch must not
 * strand a project in `executing`, and a settle must never assert completion
 * while a materialized leaf is still running.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import type { Project } from '../src/protocol.ts'
import { KanbanSpawner } from '../src/spawner.ts'
import {
  decompositionPathFor,
  planPathFor,
  projectDir,
  taskAdditionsPathFor,
  type KanbanHistoryEvent,
} from '../src/session-runner.ts'
import { FakeApi } from './fake-api.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-scan-'))
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

async function flush(ms = 5_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

function endTurn(api: FakeApi, sessionId: string): void {
  api.sessions.summaries.set(sessionId, { sessionId, running: false })
  api.sessions.histories.set(sessionId, [{
    event: { type: 'turn/end', seq: 1, time: Date.now() + 1, data: {} },
  } as KanbanHistoryEvent])
}

function writeAdditions(project: Project, body: unknown): string {
  const path = taskAdditionsPathFor(project)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return path
}

function staged(project: Project, stage: string): string[] {
  return readdirSync(projectDir(project)).filter(name => name.endsWith(`.${stage}.json`)).sort()
}

/** A decomposed project with one running execute leaf. */
async function decomposed(service: KanbanHostService, tasks: unknown[]): Promise<Project> {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  await flush(1)
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks }), 'utf8')
  service.confirmPlan(project.id)
  await flush()
  return service.getProject(project.id)!
}

/** A non-decomposed project whose project-level execute session is running. */
async function reachProjectExecute(service: KanbanHostService, api: FakeApi): Promise<Project> {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  await flush(1)
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(planPathFor(project), '# 方案', 'utf8')
  endTurn(api, service.getProject(project.id)!.sessionId!)
  await flush()
  service.confirmPlan(project.id)
  await flush(1)
  const running = service.getProject(project.id)!
  expect(running.sessionRole).toBe('execute')
  return running
}

describe('late task-additions scan phase', () => {
  it('publishes without materializing and never writes the ledger, tick after tick', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await decomposed(service, [{ title: '甲任务', kind: 'execute' }])
    endTurn(api, service.projectTasks(project.id)[0]!.sessionId!)
    await flush()
    expect(service.getProject(project.id)?.status).toBe('done')

    const ledger = join(dir, 'projects.json')
    const before = readFileSync(ledger, 'utf8')
    const revision = service.snapshot().revision
    writeAdditions(service.getProject(project.id)!, { decomposed: true, tasks: [{ title: '后续工作', kind: 'execute' }] })

    for (let tick = 0; tick < 3; tick += 1) await flush()
    expect(service.snapshot().pendingAdditions).toHaveLength(1)
    expect(service.snapshot().revision).toBe(revision)
    expect(readFileSync(ledger, 'utf8')).toBe(before)
    // Zero sessions, zero leaves: the human click is the only gate.
    expect(service.projectTasks(project.id)).toHaveLength(1)
    expect(api.sessions.created).toHaveLength(2) // design + 甲任务
    expect(service.getProject(project.id)?.history.some(entry => (entry.note ?? '').includes('异常'))).toBe(false)
  })

  it('surfaces a malformed request exactly once and leaves it untouched', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await decomposed(service, [{ title: '甲任务', kind: 'execute' }])
    endTurn(api, service.projectTasks(project.id)[0]!.sessionId!)
    await flush()

    const path = writeAdditions(service.getProject(project.id)!, '{ not json')
    await flush()
    expect(service.snapshot().pendingAdditions![0]!.state).toBe('malformed')

    const notes = (): string[] => service.getProject(project.id)!.history
      .filter(entry => (entry.note ?? '').includes('无法解析'))
      .map(entry => entry.note ?? '')
    expect(notes()).toHaveLength(1)
    expect(notes()[0]).toContain('异常：')
    // Three more ticks: still one note (the (project, file, mtime) key holds).
    await flush()
    await flush()
    await flush()
    expect(notes()).toHaveLength(1)
    // The broken file is evidence, not garbage: kept in place, never ingested.
    expect(existsSync(path)).toBe(true)
    expect(staged(project, 'pending')).toHaveLength(0)
    expect(service.projectTasks(project.id)).toHaveLength(1)
  })

  it('diagnoses a done project that still has open leaves, throttled to one note per window', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await decomposed(service, [{ title: '甲任务', kind: 'execute' }])
    // The human parks the project as done while its leaf is still running.
    service.transition(project.id, 'done', '人工提前收尾')
    expect(service.getProject(project.id)?.status).toBe('done')

    await flush()
    const notes = (): string[] => service.getProject(project.id)!.history
      .filter(entry => (entry.note ?? '').includes('但仍存在未完成的子任务'))
      .map(entry => entry.note ?? '')
    expect(notes()).toHaveLength(1)
    // Inside the 10-minute window the same contradiction is not re-reported.
    await flush()
    await flush()
    expect(notes()).toHaveLength(1)
    // Past the window it is reported again (the board must not go quiet forever).
    await flush(11 * 60_000)
    expect(notes()).toHaveLength(2)
  })

  it('does not strand a project on an empty batch at settle time', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await reachProjectExecute(service, api)

    // An agent that reported "nothing to add" must not leave the project
    // pinned in executing forever.
    writeAdditions(project, { decomposed: true, tasks: [] })
    endTurn(api, project.sessionId!)
    await flush()

    const after = service.getProject(project.id)!
    expect(after.status).toBe('done')
    expect(service.projectTasks(project.id)).toHaveLength(0)
    expect(staged(after, 'consumed')).toHaveLength(1)
  })

  it('never asserts completion at settle while a materialized leaf is still running (B5 race)', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await reachProjectExecute(service, api)

    // The human materializes a late request while the project-level execute
    // session is still running: the poll must not treat the old session's
    // verdict as the project's completion.
    writeAdditions(project, { decomposed: true, tasks: [{ title: '追加的修复', kind: 'execute' }] })
    await flush()
    service.materializePendingAdditions(project.id)
    await flush()
    const leaf = service.projectTasks(project.id)[0]!
    expect(leaf.sessionId).toBeDefined()

    endTurn(api, project.sessionId!)
    await flush()
    const after = service.getProject(project.id)!
    expect(after.status).toBe('executing')
    expect(service.getTask(leaf.id)?.status).toBe('executing')
    // Several more ticks keep it honest.
    await flush()
    await flush()
    expect(service.getProject(project.id)?.status).toBe('executing')

    endTurn(api, service.getTask(leaf.id)!.sessionId!)
    await flush()
    expect(service.getProject(project.id)?.status).toBe('done')
  })

  it('publishes every project’s pending request in one tick with zero ledger writes (R5 cost guard)', async () => {
    const service = makeService()
    const projectCount = 30
    for (let index = 0; index < projectCount; index += 1) {
      const project = service.createProject({ title: `p${index}`, workspaceDir: dir, goal: 'g' })
      mkdirSync(projectDir(project), { recursive: true })
      writeFileSync(decompositionPathFor(project), JSON.stringify({
        decomposed: true,
        tasks: [{ title: `叶子${index}`, kind: 'execute' }],
      }), 'utf8')
      service.confirmPlan(project.id)
      service.reportTaskExecuteDone(service.projectTasks(project.id)[0]!.id, 'system')
      writeAdditions(service.getProject(project.id)!, {
        decomposed: true,
        tasks: [{ title: `后续工作${index}`, kind: 'execute' }],
      })
    }
    expect(service.snapshot().projects.filter(project => project.status === 'done')).toHaveLength(projectCount)

    const ledger = join(dir, 'projects.json')
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const before = readFileSync(ledger, 'utf8')
    const revision = service.snapshot().revision

    await flush()

    expect(service.snapshot().pendingAdditions).toHaveLength(projectCount)
    expect(service.snapshot().revision).toBe(revision)
    expect(readFileSync(ledger, 'utf8')).toBe(before)
    // Still nothing materialized and nothing dispatched: the human gate holds at scale.
    expect(api.sessions.created).toHaveLength(0)
    expect(service.snapshot().tasks).toHaveLength(projectCount)
  })

  it('a fresh design round clears plan.md but KEEPS a pending request and says so', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await reachProjectExecute(service, api)
    endTurn(api, project.sessionId!)
    await flush()
    expect(service.getProject(project.id)?.status).toBe('done')
    const sessionsBefore = api.sessions.created.length

    writeAdditions(service.getProject(project.id)!, { decomposed: true, tasks: [{ title: '重新设计期间的诉求', kind: 'execute' }] })
    await flush()
    expect(service.snapshot().pendingAdditions).toHaveLength(1)

    // A fresh design round: the plan is stale, the request is not.
    service.transition(project.id, 'designing', '重新设计')
    await flush()

    expect(existsSync(planPathFor(service.getProject(project.id)!))).toBe(false)
    const kept = staged(service.getProject(project.id)!, 'pending').length + (existsSync(taskAdditionsPathFor(service.getProject(project.id)!)) ? 1 : 0)
    expect(kept).toBe(1)
    expect(service.getProject(project.id)!.history.some(entry => (entry.note ?? '').includes('全新设计轮：保留了 1 个待处理的新增任务请求'))).toBe(true)
    // The request was NOT materialized by the re-design; it is still pending.
    expect(service.projectTasks(project.id)).toHaveLength(0)
    expect(service.snapshot().pendingAdditions).toHaveLength(1)
    // A new design session was launched (the round really started).
    expect(api.sessions.created.length).toBe(sessionsBefore + 1)
  })
})
