import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-additions-spawner-'))
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

function turnEnd(time: number): KanbanHistoryEvent {
  return { event: { type: 'turn/end', seq: 1, time, data: {} } }
}

async function flush(ms = 5_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Mark a session's turn as ended successfully; the next poll settles it. */
function endTurn(api: FakeApi, sessionId: string): void {
  api.sessions.summaries.set(sessionId, { sessionId, running: false })
  api.sessions.histories.set(sessionId, [turnEnd(Date.now() + 1)])
}

function writeAdditions(project: Project, body: unknown): void {
  writeFileSync(
    taskAdditionsPathFor(project),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8',
  )
}

function consumedFiles(project: Project): string[] {
  return readdirSync(projectDir(project)).filter(name => /^tasks-additions\.\d+\.consumed\.json$/.test(name))
}

/**
 * Walk a project to its project-level execute session: design turn ends with
 * plan.md, the human confirms, the execute session spawns. Returns the
 * project (refreshed) and its execute session id.
 */
async function reachProjectExecute(
  service: KanbanHostService,
  api: FakeApi,
): Promise<{ project: Project; execSessionId: string }> {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  await flush(1)
  writeFileSync(planPathFor(project), '# 方案', 'utf8')
  endTurn(api, service.getProject(project.id)!.sessionId!)
  await flush()
  expect(service.getProject(project.id)?.status).toBe('awaiting-review')
  service.confirmPlan(project.id)
  await flush(1)
  const refreshed = service.getProject(project.id)!
  expect(refreshed.sessionRole).toBe('execute')
  return { project: refreshed, execSessionId: refreshed.sessionId! }
}

describe('KanbanSpawner task additions — project-level execute settlement', () => {
  it('consumes the split request, spawns the new leaves, keeps the project executing until they finish', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const { project, execSessionId } = await reachProjectExecute(service, api)

    // The execution agent writes a split request, then ends its turn.
    writeAdditions(project, {
      decomposed: true,
      tasks: [{ title: '追加的修复', kind: 'execute' }],
    })
    endTurn(api, execSessionId)
    await flush()

    // The project must NOT be reported done; its session is detached.
    const after = service.getProject(project.id)!
    expect(after.status).toBe('executing')
    expect(after.sessionId).toBeUndefined()
    expect(after.sessionRole).toBeUndefined()
    expect(after.history.some(entry => entry.note === 'execution split into new task leaves')).toBe(true)

    // The new leaf was materialized and its own session spawned.
    const leaves = service.projectTasks(project.id)
    expect(leaves.map(task => task.titlePath)).toEqual(['追加的修复'])
    expect(leaves[0]?.status).toBe('executing')
    expect(leaves[0]?.sessionId).toBeDefined()
    expect(api.sessions.created).toHaveLength(3) // design + project execute + new leaf

    // The request file was consumed exactly once.
    expect(existsSync(taskAdditionsPathFor(after))).toBe(false)
    expect(consumedFiles(after)).toHaveLength(1)

    // The detached old session never re-settles the project: more ticks, still executing.
    await flush()
    expect(service.getProject(project.id)?.status).toBe('executing')
    expect(service.projectTasks(project.id)).toHaveLength(1) // no double materialization

    // The project completes only when the added leaf completes.
    endTurn(api, leaves[0]!.sessionId!)
    await flush()
    expect(service.getTask(leaves[0]!.id)?.status).toBe('done')
    expect(service.getProject(project.id)?.status).toBe('done')
  })

  it('blocks the project on a malformed split request (loud failure, no done)', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const { project, execSessionId } = await reachProjectExecute(service, api)

    writeAdditions(project, '{ not json')
    endTurn(api, execSessionId)
    await flush()

    const after = service.getProject(project.id)!
    expect(after.status).toBe('blocked')
    expect(after.history.at(-1)?.note).toContain('task additions')
    expect(service.projectTasks(project.id)).toHaveLength(0)
    // A failed consumption keeps the request file for inspection.
    expect(existsSync(taskAdditionsPathFor(after))).toBe(true)
  })

  it('a project-level execute turn without a split request still reports done (regression)', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const { project, execSessionId } = await reachProjectExecute(service, api)

    endTurn(api, execSessionId)
    await flush()
    expect(service.getProject(project.id)?.status).toBe('done')
    expect(service.projectTasks(project.id)).toHaveLength(0)
  })

  it('a clarify addition gates the new execute leaf until the human answers', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const { project, execSessionId } = await reachProjectExecute(service, api)

    writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: '口径确认', kind: 'clarify', question: '口径是？' },
        { title: '追加实现', kind: 'execute', dependsOn: ['口径确认'] },
      ],
    })
    endTurn(api, execSessionId)
    await flush()

    const clarify = service.projectTasks(project.id).find(task => task.titlePath === '口径确认')!
    const execute = service.projectTasks(project.id).find(task => task.titlePath === '追加实现')!
    expect(clarify.status).toBe('awaiting-clarification')
    expect(clarify.sessionId).toBeUndefined()
    // The execute leaf waits: pending clarification + unfinished dependency.
    expect(execute.sessionId).toBeUndefined()
    expect(service.getProject(project.id)?.status).toBe('executing')

    // The human answers and confirms; the next tick releases the execute leaf.
    service.answerClarification(project.id, clarify.id, '按新口径')
    service.confirmTask(project.id, clarify.id)
    await flush()
    expect(service.getTask(execute.id)?.sessionId).toBeDefined()
    // Its prompt carries the confirmed clarification.
    const prompted = api.sessions.prompted.find(entry => entry.sessionId === service.getTask(execute.id)!.sessionId)
    expect(prompted?.text).toContain('按新口径')
  })
})

describe('KanbanSpawner task additions — leaf-level execute settlement', () => {
  /** A decomposed project whose single execute leaf is mid-run. */
  async function reachLeafExecute(
    service: KanbanHostService,
    api: FakeApi,
    tasks: unknown[],
  ): Promise<Project> {
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    await flush(1)
    mkdirSync(projectDir(project), { recursive: true })
    writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks }), 'utf8')
    service.confirmPlan(project.id)
    await flush()
    return service.getProject(project.id)!
  }

  it('consumes the split request, reports THIS leaf done, spawns the new sibling, keeps the project executing', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await reachLeafExecute(service, api, [{ title: '实现功能', kind: 'execute' }])
    const leaf = service.projectTasks(project.id).find(task => task.titlePath === '实现功能')!
    expect(leaf.sessionId).toBeDefined()

    // The leaf's agent splits out follow-up work depending on itself.
    writeAdditions(project, {
      decomposed: true,
      tasks: [{ title: '补充测试', kind: 'execute', dependsOn: ['实现功能'] }],
    })
    endTurn(api, leaf.sessionId!)
    await flush()

    // This leaf's work is done; the new sibling resolves the dependency and spawns.
    expect(service.getTask(leaf.id)?.status).toBe('done')
    const added = service.projectTasks(project.id).find(task => task.titlePath === '补充测试')!
    expect(added.dependencies).toEqual([leaf.id])
    expect(added.sessionId).toBeDefined()
    // Exactly one session per leaf (the mid-tick spawn guard held).
    expect(api.sessions.created).toHaveLength(3) // project design + 实现功能 + 补充测试
    expect(api.sessions.prompted.filter(entry => entry.sessionId === added.sessionId)).toHaveLength(1)
    // The project waits for the new leaf.
    expect(service.getProject(project.id)?.status).toBe('executing')
    expect(consumedFiles(service.getProject(project.id)!)).toHaveLength(1)

    endTurn(api, added.sessionId!)
    await flush()
    expect(service.getProject(project.id)?.status).toBe('done')
  })

  it('a split depending on an already-done leaf spawns in the same tick', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await reachLeafExecute(service, api, [
      { title: '甲任务', kind: 'execute' },
      { title: '乙任务', kind: 'execute' },
    ])
    const first = service.projectTasks(project.id).find(task => task.titlePath === '甲任务')!
    const second = service.projectTasks(project.id).find(task => task.titlePath === '乙任务')!

    // 甲任务 finishes first (no split); the project stays executing (乙任务 runs).
    endTurn(api, first.sessionId!)
    await flush()
    expect(service.getTask(first.id)?.status).toBe('done')
    expect(service.getProject(project.id)?.status).toBe('executing')

    // 乙任务 splits out work depending on the already-done 甲任务.
    writeAdditions(service.getProject(project.id)!, {
      decomposed: true,
      tasks: [{ title: '甲的回归验证', kind: 'execute', dependsOn: ['甲任务'] }],
    })
    endTurn(api, second.sessionId!)
    await flush()

    expect(service.getTask(second.id)?.status).toBe('done')
    const added = service.projectTasks(project.id).find(task => task.titlePath === '甲的回归验证')!
    // The done dependency satisfied the scheduler immediately.
    expect(added.dependencies).toEqual([first.id])
    expect(added.sessionId).toBeDefined()
    expect(service.getProject(project.id)?.status).toBe('executing')
  })

  it('blocks the leaf on a malformed split request and does NOT report it done', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await reachLeafExecute(service, api, [
      { title: '口径确认', kind: 'clarify', question: '口径是？' },
      { title: '实现功能', kind: 'execute' },
    ])
    const leaf = service.projectTasks(project.id).find(task => task.titlePath === '实现功能')!
    expect(leaf.sessionId).toBeUndefined() // waits on the pending clarification
    const clarify = service.projectTasks(project.id).find(task => task.kind === 'clarify')!
    service.answerClarification(project.id, clarify.id, '按新口径')
    service.confirmTask(project.id, clarify.id)
    await flush()
    const running = service.getTask(leaf.id)!
    expect(running.sessionId).toBeDefined()

    writeAdditions(service.getProject(project.id)!, '{ not json')
    endTurn(api, running.sessionId!)
    await flush()

    const after = service.getTask(leaf.id)!
    expect(after.status).toBe('blocked')
    expect(after.history.at(-1)?.note).toContain('task additions')
    // No half-batch, no consumption, and the project stays executing.
    expect(service.projectTasks(project.id)).toHaveLength(2)
    expect(existsSync(taskAdditionsPathFor(service.getProject(project.id)!))).toBe(true)
    expect(service.getProject(project.id)?.status).toBe('executing')
  })
})
