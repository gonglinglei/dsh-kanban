/**
 * Regression repro for the production accident behind board project
 * `0c724876`: 「『全量开源就绪审查并输出报告』里面创建的任务没有展示」.
 *
 * Real timeline (project 5f320d90, leaf 1e673f60, session a3ccb5ab):
 *   turn 1 wrote report.md → turn 1 ended → the board settled the leaf `done`
 *   → the project went `done` → *afterwards* the human kept talking in that
 *   same session and the agent wrote `tasks-additions.json` (4 leaves).
 *
 * Because the leaf had left the observation window, no code path ever read that
 * file again: never materialized, never on the board, never reported. These
 * tests drive that exact ordering and pin the fix: the request is scanned,
 * published as「待处理的新增任务请求（4 项）」, and materialized only by the
 * human click — after which the project re-opens and the new leaves run.
 *
 * Variants cover the other three off-window shapes (B2): a blocked leaf, a
 * blocked project, and a project-level (non-decomposed) execute that is done.
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

/** The four requests the real agent wrote into the orphaned file. */
const REAL_REQUESTS = [
  { title: '补齐 CONTRIBUTING 等社区文档', kind: 'execute' },
  { title: '加 GH Actions CI 与模板', kind: 'execute' },
  { title: 'repro 测试脱敏改名', kind: 'execute' },
  { title: '提供英文 README', kind: 'execute' },
]

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-repro-late-'))
  // Far in the past: every file the test writes has a future mtime, which the
  // probe's half-write guard treats as settled. Handoff note 5 in the
  // implementation artifact documents this deliberately.
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

/** Mark a session's turn as ended successfully; the next poll settles it. */
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

/** A decomposed project (design turn is never ended; the human confirms the plan). */
async function decomposed(service: KanbanHostService, tasks: unknown[]): Promise<Project> {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  await flush(1)
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks }), 'utf8')
  service.confirmPlan(project.id)
  await flush()
  return service.getProject(project.id)!
}

/** A non-decomposed project whose project-level execute turn ends and completes it. */
async function reachProjectExecuteDone(service: KanbanHostService, api: FakeApi): Promise<{ project: Project; ledger: string }> {
  const ledger = join(dir, 'projects.json')
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  await flush(1)
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(planPathFor(project), '# 方案', 'utf8')
  endTurn(api, service.getProject(project.id)!.sessionId!)
  await flush()
  expect(service.getProject(project.id)?.status).toBe('awaiting-review')
  service.confirmPlan(project.id)
  await flush(1)
  const running = service.getProject(project.id)!
  expect(running.sessionRole).toBe('execute')
  endTurn(api, running.sessionId!)
  await flush()
  expect(service.getProject(project.id)?.status).toBe('done')
  return { project: service.getProject(project.id)!, ledger }
}

describe('repro 5f320d90: the request written AFTER the leaf settled', () => {
  it('scans it, shows it, materializes it on the human click, and re-opens the done project', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const ledger = join(dir, 'projects.json')

    // ── The real shape: one clarify leaf + one execute leaf ─────────────────
    const project = await decomposed(service, [
      { title: '明确开源范围与口径', kind: 'clarify', question: '审查范围到哪里？' },
      { title: '全量开源就绪审查并输出报告', kind: 'execute' },
    ])
    const clarify = service.projectTasks(project.id).find(task => task.kind === 'clarify')!
    service.answerClarification(project.id, clarify.id, '全量')
    service.confirmTask(project.id, clarify.id)
    await flush()
    const leaf = service.projectTasks(project.id).find(task => task.titlePath === '全量开源就绪审查并输出报告')!
    expect(leaf.sessionId).toBeDefined()

    // Turn 1: the agent writes its report and the turn ends.
    endTurn(api, leaf.sessionId!)
    await flush()
    expect(service.getTask(leaf.id)?.status).toBe('done')
    expect(service.getProject(project.id)?.status).toBe('done')
    expect(service.projectTasks(project.id)).toHaveLength(2)

    const revisionAtCompletion = service.snapshot().revision
    const sessionsAtCompletion = api.sessions.created.length
    const ledgerAtCompletion = readFileSync(ledger, 'utf8')
    // A normal tick on a done project: nothing to show, nothing written.
    await flush()
    expect(service.snapshot().pendingAdditions).toEqual([])
    expect(service.snapshot().revision).toBe(revisionAtCompletion)

    // ── Turn 2+: the human keeps talking to the SAME session; the agent ────
    // ── writes tasks-additions.json long after the leaf was settled. ───────
    const requestPath = writeAdditions(project, { decomposed: true, tasks: REAL_REQUESTS })
    await flush()

    // A1: the board sees「待处理的新增任务请求（4 项）」— without touching the ledger.
    const entries = service.snapshot().pendingAdditions!
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.projectId).toBe(project.id)
    expect(entry.state).toBe('ready')
    expect(entry.count).toBe(4)
    expect(entry.batches).toBe(1)
    expect(entry.items?.map(item => item.titlePath)).toEqual(REAL_REQUESTS.map(task => task.title))
    expect(entry.file).toMatch(/^tasks-additions\.\d+\.pending\.json$/)
    // Scanning is NOT materializing: no leaf, no session, no ledger write.
    expect(service.projectTasks(project.id)).toHaveLength(2)
    expect(api.sessions.created.length).toBe(sessionsAtCompletion)
    expect(service.snapshot().revision).toBe(revisionAtCompletion)
    expect(readFileSync(ledger, 'utf8')).toBe(ledgerAtCompletion)
    expect(readFileSync(ledger, 'utf8')).not.toContain('pendingAdditions')
    // The overwritable slot was frozen into an immutable batch.
    expect(existsSync(requestPath)).toBe(false)
    expect(staged(project, 'pending')).toHaveLength(1)

    // ── The human click (方案 B: the cost stays under human control) ─────────
    const result = service.materializePendingAdditions(project.id, '按审查结论补齐')
    expect(result.created).toHaveLength(4)
    expect(result.skipped).toEqual([])
    expect(result.reopened).toBe(true)
    expect(result.consumed).toHaveLength(1)
    expect(result.consumed[0]).toMatch(/^tasks-additions\.\d+\.consumed\.json$/)

    // A2/A4: 2 → 6 leaves and the project is back in executing (never done-with-open-leaves).
    const reopened = service.getProject(project.id)!
    expect(reopened.status).toBe('executing')
    expect(service.projectTasks(project.id)).toHaveLength(6)
    // A3: an auditable history note (actor, count, reopen edge, human remark).
    const note = reopened.history.at(-1)!
    expect(note.actor).toBe('human')
    expect(note.note).toContain('人工物化新增任务请求：新建 4 项')
    expect(note.note).toContain('项目重开 done → executing')
    expect(note.note).toContain('备注：按审查结论补齐')
    // The badge disappears with the click, not a tick later.
    expect(service.snapshot().pendingAdditions).toEqual([])

    // The very next tick pulls up one execution session per new leaf.
    await flush()
    const added = service.projectTasks(project.id).filter(task => task.titlePath !== '明确开源范围与口径' && task.titlePath !== '全量开源就绪审查并输出报告')
    expect(added.map(task => task.titlePath)).toEqual(REAL_REQUESTS.map(task => task.title))
    for (const task of added) expect(task.sessionId).toBeDefined()
    expect(api.sessions.created.length).toBe(sessionsAtCompletion + 4)

    // …and the project completes again only when all four are done.
    for (const task of added) {
      endTurn(api, service.getTask(task.id)!.sessionId!)
      await flush()
    }
    expect(service.getProject(project.id)?.status).toBe('done')
    expect(service.projectTasks(project.id).every(task => task.status === 'done')).toBe(true)
  })

  it('handles a request written after a LEAF was terminated (blocked leaf)', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await decomposed(service, [
      { title: '甲任务', kind: 'execute' },
      { title: '乙任务', kind: 'execute' },
    ])
    const first = service.projectTasks(project.id).find(task => task.titlePath === '甲任务')!
    expect(first.sessionId).toBeDefined()
    service.terminateTask(project.id, first.id, '不需要了')
    expect(service.getTask(first.id)?.status).toBe('blocked')

    writeAdditions(project, { decomposed: true, tasks: [{ title: '终止后的补位任务', kind: 'execute' }] })
    await flush()

    expect(service.snapshot().pendingAdditions![0]!.count).toBe(1)
    const result = service.materializePendingAdditions(project.id)
    expect(result.created.map(task => task.titlePath)).toEqual(['终止后的补位任务'])
    expect(result.reopened).toBe(false)
    // The parked leaf stays parked; only the new intent is added.
    expect(service.getTask(first.id)?.status).toBe('blocked')
    expect(service.getProject(project.id)?.status).toBe('executing')
    expect(service.projectTasks(project.id)).toHaveLength(3)
  })

  it('handles a request written after the PROJECT was blocked', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = await decomposed(service, [{ title: '甲任务', kind: 'execute' }])
    service.transition(project.id, 'blocked', '人工暂停')
    expect(service.getProject(project.id)?.status).toBe('blocked')

    writeAdditions(project, { decomposed: true, tasks: [{ title: '暂停期间的补充工作', kind: 'execute' }] })
    await flush()
    expect(service.snapshot().pendingAdditions![0]!.state).toBe('ready')

    const result = service.materializePendingAdditions(project.id)
    expect(result.reopened).toBe(true)
    const after = service.getProject(project.id)!
    expect(after.status).toBe('executing')
    expect(after.history.at(-1)!.note).toContain('项目重开 blocked → executing')
    expect(service.projectTasks(project.id)).toHaveLength(2)
  })

  it('handles a request written after a PROJECT-LEVEL execute finished (no project session is re-spawned)', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const { project } = await reachProjectExecuteDone(service, api)
    expect(service.projectTasks(project.id)).toHaveLength(0)

    writeAdditions(project, { decomposed: true, tasks: [{ title: '追加的修复', kind: 'execute' }] })
    await flush()
    expect(service.snapshot().pendingAdditions![0]!.count).toBe(1)
    // Still nothing materialized by the scan phase.
    expect(service.projectTasks(project.id)).toHaveLength(0)

    const sessionsBefore = api.sessions.created.length
    const result = service.materializePendingAdditions(project.id)
    expect(result.reopened).toBe(true)
    expect(service.getProject(project.id)?.status).toBe('executing')

    await flush()
    expect(service.projectTasks(project.id)).toHaveLength(1)
    // Exactly ONE new session: the added leaf. The split detached the settled
    // project-level session instead of spawning a second agent for the project.
    expect(api.sessions.created.length).toBe(sessionsBefore + 1)
    expect(service.getProject(project.id)?.sessionId).toBeUndefined()
    const added = service.projectTasks(project.id)[0]!
    expect(added.sessionId).toBeDefined()

    endTurn(api, added.sessionId!)
    await flush()
    expect(service.getProject(project.id)?.status).toBe('done')
  })
})
