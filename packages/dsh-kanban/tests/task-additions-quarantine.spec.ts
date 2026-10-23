/**
 * The two exits of a request that can NEVER be materialized:
 *
 *  - `*.failed.json` — the system's quarantine. A batch that parses but the
 *    planner rejects (unknown dependency, cycle) used to fail on every click
 *    and forever: it stayed actionable, so the badge kept promising a
 *    materialization that could not happen. Now the human's click isolates it
 *    (verbatim, with its own anomaly note) and moves on with the rest.
 *  - `discard-additions` — the human's exit. The only way out of a body that
 *    will never be fixed (or work nobody wants any more), which previously
 *    required hand-editing files in the project directory.
 *
 * Contracts pinned here:
 *  - one poison request never cancels the healthy batches of the same click;
 *  - a broken body is left EXACTLY where it is (it is the evidence) and is
 *    never silently renamed away;
 *  - a broken batch no longer shadows the healthy ones in the snapshot;
 *  - terminal stages (`consumed` / `failed` / `discarded`) are never
 *    actionable again;
 *  - discarding touches no leaf, no session and NO PROJECT STATUS.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { TransitionError } from '../src/state-machine.ts'
import type { Project } from '../src/protocol.ts'
import { PENDING_PROBLEMS_MAX } from '../src/protocol.ts'
import {
  classifyTaskAdditionsFile, decompositionPathFor, projectDir, taskAdditionsPathFor,
} from '../src/session-runner.ts'

let dir: string
let ledger: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-quarantine-'))
  ledger = join(dir, 'projects.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeService(): KanbanHostService {
  const service = new KanbanHostService(ledger)
  service.start()
  return service
}

function decomposedProject(service: KanbanHostService, tasks: unknown[]): Project {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks }), 'utf8')
  service.confirmPlan(project.id)
  return service.getProject(project.id)!
}

/** A decomposed project whose only leaf is done (so the project itself is done). */
function completedProject(service: KanbanHostService): Project {
  const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
  service.reportTaskExecuteDone(service.projectTasks(project.id)[0]!.id, 'system')
  expect(service.getProject(project.id)?.status).toBe('done')
  return service.getProject(project.id)!
}

function writeAdditions(project: Project, body: unknown): string {
  const path = taskAdditionsPathFor(project)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return path
}

/** Back-date a file so the probe's half-write guard (>= 1500 ms of quiet) accepts it. */
function backdate(path: string, ms = 5_000): void {
  const at = new Date(Date.now() - ms)
  utimesSync(path, at, at)
}

/** Freeze the live slot into an immutable `*.pending.json` batch (phase 0). */
function ingest(service: KanbanHostService, project: Project, body: unknown): string {
  const path = writeAdditions(project, body)
  backdate(path)
  service.ingestPendingAdditions()
  const staged = readdirSync(projectDir(project)).filter(name => name.endsWith('.pending.json'))
  expect(staged).toHaveLength(1)
  return join(projectDir(project), staged[0]!)
}

function files(project: Project, suffix: string): string[] {
  return readdirSync(projectDir(project)).filter(name => name.endsWith(suffix)).sort()
}

const UNKNOWN_DEPENDENCY = { decomposed: true, tasks: [{ title: '孤儿任务', kind: 'execute', dependsOn: ['根本不存在'] }] }
const CYCLE = {
  decomposed: true,
  tasks: [
    { title: '甲', kind: 'execute', dependsOn: ['乙'] },
    { title: '乙', kind: 'execute', dependsOn: ['甲'] },
  ],
}
const ONE_TASK = { decomposed: true, tasks: [{ title: '补充测试', kind: 'execute' }] }

describe('unplannable requests are quarantined, not retried forever', () => {
  it('isolates the poison batch on the human click: *.failed.json, anomaly note, no leaf, status untouched', () => {
    const service = makeService()
    const project = completedProject(service)
    const path = writeAdditions(project, UNKNOWN_DEPENDENCY)
    backdate(path)

    const revision = service.snapshot().revision
    let thrown: unknown
    try {
      service.materializePendingAdditions(project.id)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TransitionError)
    expect((thrown as Error).message).toMatch(/均无法物化，已隔离/)
    expect((thrown as Error).message).toContain('*.failed.json')

    // The request is parked verbatim: quarantined, never deleted.
    expect(existsSync(path)).toBe(false)
    const failed = files(project, '.failed.json')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatch(/^tasks-additions\.\d+\.failed\.json$/)
    expect(JSON.parse(readFileSync(join(projectDir(project), failed[0]!), 'utf8'))).toEqual(UNKNOWN_DEPENDENCY)

    // The audit trail says what happened, and it is an anomaly (system actor).
    const history = service.getProject(project.id)!.history
    const anomaly = history.at(-1)!
    expect(anomaly.actor).toBe('system')
    expect(anomaly.note).toContain('异常：')
    expect(anomaly.note).toContain('无法物化')
    expect(anomaly.note).toContain(failed[0]!)

    // No leaf, no status change: a quarantine is not a materialization.
    expect(service.projectTasks(project.id)).toHaveLength(1)
    expect(service.getProject(project.id)?.status).toBe('done')
    expect(service.snapshot().revision).toBeGreaterThan(revision)
    // …and it never comes back: the badge is gone and a second click has
    // nothing left to chew on.
    expect(service.snapshot().pendingAdditions).toEqual([])
    expect(() => service.materializePendingAdditions(project.id)).toThrowError(/no pending task-additions request/)
  })

  it('quarantines a dependency cycle as well (any planner rejection isolates)', () => {
    const service = makeService()
    const project = completedProject(service)
    const path = writeAdditions(project, CYCLE)
    backdate(path)

    expect(() => service.materializePendingAdditions(project.id)).toThrowError(TransitionError)
    expect(files(project, '.failed.json')).toHaveLength(1)
    expect(service.getProject(project.id)!.history.at(-1)!.note).toContain('dependency cycle')
  })

  it('one poison batch does not cancel the healthy batch of the same click', () => {
    const service = makeService()
    const project = completedProject(service)
    // Two batches: an ingested healthy one, then a fresh poison one.
    ingest(service, project, ONE_TASK)
    const poison = writeAdditions(project, UNKNOWN_DEPENDENCY)
    backdate(poison)

    const result = service.materializePendingAdditions(project.id)
    expect(result.created.map(task => task.titlePath)).toEqual(['补充测试'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.file).toMatch(/\.failed\.json$/)
    expect(result.failed[0]!.error).toContain('根本不存在')
    expect(result.broken).toEqual([])
    // The audit line names both halves: what was created and what was isolated.
    const audit = service.getProject(project.id)!.history
      .filter(entry => entry.actor === 'human')
      .map(entry => entry.note)
      .find(note => note.includes('人工物化新增任务请求'))!
    expect(audit).toContain('新建 1 项')
    expect(audit).toContain('隔离 1 个无法物化的请求（tasks-additions.json）')
    expect(service.projectTasks(project.id)).toHaveLength(2)
  })

  it('leaves an unparsable body exactly where it is and keeps the healthy batch clickable', () => {
    const service = makeService()
    const project = completedProject(service)
    ingest(service, project, ONE_TASK)
    const broken = writeAdditions(project, '{ not json at all')
    backdate(broken)

    // The broken file no longer SHADOWS the healthy one: the badge counts the
    // materializable leaves and lists the broken file next to them.
    service.refreshPendingAdditions(project.id)
    const entry = service.snapshot().pendingAdditions![0]!
    expect(entry.state).toBe('ready')
    expect(entry.count).toBe(1)
    expect(entry.items!.map(item => item.titlePath)).toEqual(['补充测试'])
    expect(entry.malformed!.map(problem => problem.file)).toEqual(['tasks-additions.json'])
    expect(entry.malformed![0]!.error.length).toBeLessThanOrEqual(200)

    const result = service.materializePendingAdditions(project.id)
    expect(result.created).toHaveLength(1)
    expect(result.broken.map(problem => problem.file)).toEqual(['tasks-additions.json'])
    expect(result.failed).toEqual([])
    expect(service.getProject(project.id)!.history
      .filter(entry => entry.actor === 'human')
      .map(entry => entry.note)
      .find(note => note.includes('人工物化新增任务请求'))!)
      .toContain('保留 1 个无法解析的请求（tasks-additions.json）')
    // Evidence preserved: the broken body is still there, byte for byte.
    expect(readFileSync(broken, 'utf8')).toBe('{ not json at all')
    expect(files(project, '.failed.json')).toEqual([])
    // Only the broken file is left, so the board now says exactly that.
    expect(service.snapshot().pendingAdditions![0]!.state).toBe('malformed')
  })

  it('consumes a batch that materializes nothing WITHOUT re-opening a done project', () => {
    const service = makeService()
    const project = completedProject(service)
    // Every requested titlePath already exists: the click has nothing to add.
    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '实现功能', kind: 'execute' }] })
    backdate(path)

    const result = service.materializePendingAdditions(project.id)
    expect(result.created).toEqual([])
    expect(result.skipped).toEqual(['实现功能'])
    expect(result.reopened).toBe(false)
    // The audit says what happened, and never claims a re-open it did not do.
    const note = service.getProject(project.id)!.history.at(-1)!
    expect(note.note).toContain('人工物化新增任务请求：新建 0 项；跳过 1 项（已存在：实现功能）')
    expect(note.note).not.toContain('项目重开')
    // The project is still done (a re-open would strand it: no new leaf runs,
    // and no session is left to settle it back).
    expect(service.getProject(project.id)?.status).toBe('done')
    expect(files(project, '.consumed.json')).toHaveLength(1)
    expect(service.snapshot().pendingAdditions).toEqual([])
  })

  it('bounds the published problem list (the snapshot is hot SSE data)', () => {
    const service = makeService()
    const project = completedProject(service)
    const dir = projectDir(project)
    for (let mtime = 1; mtime <= 7; mtime += 1) {
      writeFileSync(join(dir, `tasks-additions.${mtime}.pending.json`), '{ broken', 'utf8')
    }

    service.refreshPendingAdditions(project.id)
    const entry = service.snapshot().pendingAdditions![0]!
    expect(entry.state).toBe('malformed')
    expect(entry.batches).toBe(7)
    expect(entry.malformed).toHaveLength(PENDING_PROBLEMS_MAX)
    expect(entry.malformed!.map(problem => problem.file)).toEqual([
      'tasks-additions.1.pending.json',
      'tasks-additions.2.pending.json',
      'tasks-additions.3.pending.json',
      'tasks-additions.4.pending.json',
      'tasks-additions.5.pending.json',
    ])
  })

  it('keeps the SETTLE path loud: an unplannable request throws and stays actionable (no silent quarantine)', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, UNKNOWN_DEPENDENCY)
    backdate(path)

    expect(() => service.applyTaskAdditions(project.id)).toThrowError(/unknown task/)
    // The spawner parks the node on this throw; the file is untouched, so the
    // human still sees the request and can materialize/discard it.
    expect(existsSync(path)).toBe(true)
    expect(files(project, '.failed.json')).toEqual([])
    expect(service.projectTasks(project.id)).toHaveLength(1)
  })
})

describe('discard-additions: the human exit', () => {
  it('parks a ready request as *.discarded.json, audits it as human, and does NOT re-open the project', () => {
    const service = makeService()
    const project = completedProject(service)
    const path = writeAdditions(project, ONE_TASK)
    backdate(path)
    service.refreshPendingAdditions(project.id)
    expect(service.snapshot().pendingAdditions).toHaveLength(1)

    const result = service.discardPendingAdditions(project.id, '不再需要')
    expect(result.discarded).toHaveLength(1)
    expect(result.discarded[0]!.file).toMatch(/^tasks-additions\.\d+\.discarded\.json$/)
    expect(result.project.status).toBe('done')

    expect(existsSync(path)).toBe(false)
    const parked = join(projectDir(project), result.discarded[0]!.file)
    expect(JSON.parse(readFileSync(parked, 'utf8'))).toEqual(ONE_TASK)
    expect(files(project, '.consumed.json')).toEqual([])

    const note = service.getProject(project.id)!.history.at(-1)!
    expect(note.actor).toBe('human')
    expect(note.note).toContain('人工废弃新增任务请求：1 个批次')
    expect(note.note).toContain(result.discarded[0]!.file)
    expect(note.note).toContain('备注：不再需要')

    // The badge clears immediately, nothing is left to consume, and the
    // project status never moved.
    expect(service.snapshot().pendingAdditions).toEqual([])
    expect(service.getProject(project.id)?.status).toBe('done')
    expect(service.projectTasks(project.id)).toHaveLength(1)
    expect(() => service.materializePendingAdditions(project.id)).toThrowError(/no pending task-additions request/)
    expect(() => service.discardPendingAdditions(project.id)).toThrowError(/no pending task-additions request to discard/)
  })

  it('is the only exit for a malformed body: the file survives, byte for byte', () => {
    const service = makeService()
    const project = completedProject(service)
    const path = writeAdditions(project, '{ broken')
    backdate(path)
    service.refreshPendingAdditions(project.id)
    expect(service.snapshot().pendingAdditions![0]!.state).toBe('malformed')

    const result = service.discardPendingAdditions(project.id)
    expect(result.discarded).toHaveLength(1)
    expect(readFileSync(join(projectDir(project), result.discarded[0]!.file), 'utf8')).toBe('{ broken')
    expect(service.snapshot().pendingAdditions).toEqual([])
    expect(service.getProject(project.id)!.history.at(-1)!.note).toContain('人工废弃新增任务请求：1 个批次')
  })

  it('discards every accumulated batch of a project in one action', () => {
    const service = makeService()
    const project = completedProject(service)
    ingest(service, project, ONE_TASK)
    const fresh = writeAdditions(project, { decomposed: true, tasks: [{ title: '第二项', kind: 'execute' }] })
    backdate(fresh)

    const result = service.discardPendingAdditions(project.id)
    expect(result.discarded).toHaveLength(2)
    expect(files(project, '.discarded.json')).toHaveLength(2)
    expect(files(project, '.pending.json')).toEqual([])
    expect(service.snapshot().pendingAdditions).toEqual([])
    expect(service.projectTasks(project.id)).toHaveLength(1)
  })

  it('changes nothing when there is nothing pending', () => {
    const service = makeService()
    const project = completedProject(service)
    const revision = service.snapshot().revision
    expect(() => service.discardPendingAdditions(project.id)).toThrowError(/no pending task-additions request/)
    expect(() => service.discardPendingAdditions('unknown-project')).toThrowError(TransitionError)
    expect(service.snapshot().revision).toBe(revision)
  })
})

describe('terminal stages are never actionable again', () => {
  it('ignores consumed / failed / discarded files written by hand', () => {
    const service = makeService()
    const project = completedProject(service)
    const projectDirPath = projectDir(project)
    for (const name of ['tasks-additions.111.consumed.json', 'tasks-additions.222.failed.json', 'tasks-additions.333.discarded.json']) {
      writeFileSync(join(projectDirPath, name), JSON.stringify(ONE_TASK), 'utf8')
    }

    expect(service.peekAdditions(project.id)).toBeUndefined()
    expect(service.snapshot().pendingAdditions).toEqual([])
    expect(() => service.materializePendingAdditions(project.id)).toThrowError(/no pending task-additions request/)
    expect(() => service.discardPendingAdditions(project.id)).toThrowError(/no pending task-additions request/)
    expect(readdirSync(projectDirPath).filter(name => name.startsWith('tasks-additions')).sort())
      .toEqual(['tasks-additions.111.consumed.json', 'tasks-additions.222.failed.json', 'tasks-additions.333.discarded.json'])

    // …and the classifier is the single source of that vocabulary.
    expect(classifyTaskAdditionsFile('tasks-additions.1.failed.json')).toEqual({ name: 'tasks-additions.1.failed.json', stage: 'failed', mtimeMs: 1, ordinal: 0 })
    expect(classifyTaskAdditionsFile('tasks-additions.1.2.discarded.json')).toEqual({ name: 'tasks-additions.1.2.discarded.json', stage: 'discarded', mtimeMs: 1, ordinal: 2 })
    expect(classifyTaskAdditionsFile('tasks-additions.1.orphaned.json')).toBeUndefined()
  })
})
