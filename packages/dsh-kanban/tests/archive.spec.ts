/**
 * Host-side archive core: the periodic sweep, the four ledger actions, the
 * snapshot view, and the invariants the two archive designs share
 * (I1–I20 of `定期相位与运行时不变量设计`, I11–I13 of `数据模型与账本兼容设计`).
 *
 * Clock recipe: never poke `service.state` — drive `Date.now()` with
 * `vi.setSystemTime`, so the tests exercise the very judgement the sweep uses
 * (`archiveWindowReached`) instead of a test-only shortcut.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import type { ArchiveEntry, Project, TaskNode } from '../src/protocol.ts'
import { TASK_ADDITIONS_FILE, decompositionPathFor, planPathFor, projectDir, taskAdditionsPathFor } from '../src/session-runner.ts'
import { TransitionError } from '../src/state-machine.ts'

const DAY = 86_400_000
const T0 = 1_700_000_000_000

interface Policy {
  afterDays: number
  sweepMinutes: number
  doneTaskLeaves?: boolean
}

let dir: string
const services: KanbanHostService[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-archive-'))
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const ledgerFile = (): string => join(dir, 'projects.json')

function makeService(policy?: Policy): KanbanHostService {
  const service = new KanbanHostService(ledgerFile())
  services.push(service)
  service.start()
  if (policy !== undefined) service.setArchivePolicy(policy)
  return service
}

/** A project that is `done` as of the current fake time. */
function createDoneProject(service: KanbanHostService, title = 'p', workspaceDir = dir): string {
  const project = service.createProject({ title, workspaceDir, goal: 'g' })
  service.transition(project.id, 'done')
  return project.id
}

/** A decomposed project with the given leaves, confirmed (materialized) at the current time. */
function decompose(service: KanbanHostService, tasks: unknown[], workspaceDir = dir): string {
  const project = service.createProject({ title: 'leaf-owner', workspaceDir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks }), 'utf8')
  service.confirmPlan(project.id)
  return project.id
}

function writeRequest(project: Project, name = TASK_ADDITIONS_FILE): string {
  mkdirSync(projectDir(project), { recursive: true })
  const path = join(projectDir(project), name)
  writeFileSync(path, JSON.stringify({ decomposed: true, tasks: [{ title: 'X', kind: 'execute' }] }), 'utf8')
  return path
}

function ledger(): { projects: Project[]; tasks: TaskNode[]; revision: number; format: number } {
  return JSON.parse(readFileSync(ledgerFile(), 'utf8'))
}

describe('archive sweep: window and eligibility', () => {
  it('I20: a zero window disables automatic archiving completely', () => {
    const service = makeService({ afterDays: 0, sweepMinutes: 60 })
    const id = createDoneProject(service)
    const revision = service.snapshot().revision

    vi.advanceTimersByTime(10 * DAY)
    // No timer ran, and the explicit call is a no-op as well: `0` means OFF,
    // never "archive everything now".
    expect(service.archiveSweep()).toEqual({ projects: [], tasks: [] })
    expect(service.getProject(id)?.archivedAt).toBeUndefined()
    expect(service.snapshot().revision).toBe(revision)
  })

  it('I20: a non-positive cadence never arms a spinning timer', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 0 })
    const id = createDoneProject(service)
    const revision = service.snapshot().revision

    vi.advanceTimersByTime(10 * DAY)
    expect(service.getProject(id)?.archivedAt).toBeUndefined()
    expect(service.snapshot().revision).toBe(revision)

    // A disposed service cannot be woken up by a stray timer either.
    service.dispose()
    vi.advanceTimersByTime(10 * DAY)
    expect(service.snapshot().revision).toBe(revision)
  })

  it('AC2: the window boundary itself is due, one millisecond earlier is not', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const id = createDoneProject(service)

    vi.setSystemTime(T0 + 7 * DAY - 1)
    expect(service.archiveSweep()).toEqual({ projects: [], tasks: [] })

    vi.setSystemTime(T0 + 7 * DAY)
    expect(service.archiveSweep().projects).toEqual([id])
    const archived = service.getProject(id)!
    expect(archived.status).toBe('done')
    expect(archived.archivedAt).toBe(T0 + 7 * DAY)
    // One shared `now` for the whole batch: the marker and the clock agree.
    expect(archived.updatedAt).toBe(archived.archivedAt)
    expect(archived.archivedBy).toBe('system')
    expect(archived.archiveNote).toContain('自动归档')
    // The ledger still holds the record (soft archive, never a delete).
    expect(ledger().projects.some(project => project.id === id)).toBe(true)
    expect(ledger().format).toBe(1)
  })

  it('I1/I3: only done projects without unfinished leaves are swept', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const designing = service.createProject({ title: 'designing', workspaceDir: dir, goal: 'g' }).id
    const reviewing = service.createProject({ title: 'reviewing', workspaceDir: dir, goal: 'g' }).id
    service.reportDesignDone(reviewing, join(dir, 'plan.md'))
    const clean = createDoneProject(service, 'clean')
    // "Done but with an open leaf" is the contradiction the board reports; the
    // sweep must not hide it behind an archive.
    const contradictory = decompose(service, [{ title: 'A', kind: 'execute' }])
    service.transition(contradictory, 'done')

    vi.setSystemTime(T0 + 8 * DAY)
    expect(service.archiveSweep().projects).toEqual([clean])
    expect(service.getProject(designing)?.archivedAt).toBeUndefined()
    expect(service.getProject(reviewing)?.archivedAt).toBeUndefined()
    expect(service.getProject(contradictory)?.archivedAt).toBeUndefined()
  })

  it('I2: a long-running container is never archived, its one-shot child is', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const container = service.createProject({ title: 'container', workspaceDir: dir, goal: 'g', lifecycle: 'long-running' }).id
    // Even a container a human marked done stays a container.
    service.transition(container, 'done')
    const child = service.createProject({ title: 'child', goal: 'g', parentId: container }).id
    service.transition(child, 'done')

    vi.setSystemTime(T0 + 8 * DAY)
    expect(service.archiveSweep().projects).toEqual([child])
    expect(service.getProject(child)?.archivedAt).toBe(T0 + 8 * DAY)
    // I8: the archived child keeps its affiliation for the archive view's grouping.
    expect(service.getProject(child)?.parentId).toBe(container)
    expect(service.getProject(container)?.archivedAt).toBeUndefined()
  })

  it('I4: a materializable request blocks the sweep, an audit-stage file does not', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const id = createDoneProject(service)
    const project = service.getProject(id)!
    const path = writeRequest(project)

    vi.setSystemTime(T0 + 8 * DAY)
    expect(service.archiveSweep()).toEqual({ projects: [], tasks: [] })
    expect(service.getProject(id)?.archivedAt).toBeUndefined()

    // Parked in a terminal stage, the same file no longer waits for a human.
    rmSync(path)
    writeRequest(project, 'tasks-additions.123.consumed.json')
    expect(service.archiveSweep().projects).toEqual([id])
  })

  it('I12: one sweep persists and broadcasts exactly once, however many records it archives', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const ids = [createDoneProject(service, 'a'), createDoneProject(service, 'b'), createDoneProject(service, 'c')]
    const revision = service.snapshot().revision
    const frames: number[] = []
    service.subscribe(payload => frames.push(payload.revision))

    vi.setSystemTime(T0 + 8 * DAY)
    const hits = service.archiveSweep()

    expect(hits.projects.sort()).toEqual([...ids].sort())
    expect(service.snapshot().revision).toBe(revision + 1)
    expect(frames).toEqual([revision + 1])
    const persisted = ledger()
    expect(persisted.revision).toBe(revision + 1)
    for (const project of persisted.projects.filter(entry => ids.includes(entry.id))) {
      expect(project.archivedAt).toBe(T0 + 8 * DAY)
      expect(project.updatedAt).toBe(project.archivedAt)
      expect(project.history.at(-1)?.note).toContain('自动归档')
    }
  })

  it('I13: a broadcast listener never observes a half-applied batch', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const ids = [createDoneProject(service, 'a'), createDoneProject(service, 'b')]
    let archivedWhenNotified = -1
    service.subscribe(() => {
      archivedWhenNotified = ids.filter(id => service.getProject(id)?.archivedAt !== undefined).length
    })

    vi.setSystemTime(T0 + 8 * DAY)
    service.archiveSweep()
    expect(archivedWhenNotified).toBe(2)
  })

  it('I6: no candidates ⇒ zero mutations, and re-scanning is a no-op', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const id = createDoneProject(service)
    const revision = service.snapshot().revision
    const frames: number[] = []
    service.subscribe(payload => frames.push(payload.revision))

    // Still inside the window.
    expect(service.archiveSweep()).toEqual({ projects: [], tasks: [] })
    expect(service.snapshot().revision).toBe(revision)
    expect(frames).toEqual([])

    vi.setSystemTime(T0 + 8 * DAY)
    service.archiveSweep()
    const afterArchive = service.snapshot().revision
    const version = service.getProject(id)!.version

    // Idempotence before the fact: an explicit re-archive writes nothing.
    expect(service.archiveSweep()).toEqual({ projects: [], tasks: [] })
    expect(service.archiveProject(id)).toBe(service.getProject(id))
    expect(service.snapshot().revision).toBe(afterArchive)
    expect(service.getProject(id)!.version).toBe(version)
    expect(frames).toEqual([afterArchive])
  })

  it('I15: the startup catch-up runs synchronously, once, before anything else', () => {
    const first = makeService()
    const id = createDoneProject(first)

    vi.setSystemTime(T0 + 8 * DAY)
    const restarted = new KanbanHostService(ledgerFile())
    services.push(restarted)
    restarted.start()
    const beforePolicy = restarted.snapshot().revision
    restarted.setArchivePolicy({ afterDays: 7, sweepMinutes: 60 })
    // The catch-up happened inside the call: no timer, no tick, no polling.
    expect(restarted.getProject(id)?.archivedAt).toBe(T0 + 8 * DAY)
    expect(restarted.snapshot().revision).toBe(beforePolicy + 1)
    // And it happened exactly once: a whole cadence later nothing changes.
    const afterCatchUp = restarted.snapshot().revision
    vi.advanceTimersByTime(60 * 60_000)
    expect(restarted.snapshot().revision).toBe(afterCatchUp)
  })

  it('I15: a policy armed before the ledger loads still catches up after start()', () => {
    const first = makeService()
    const id = createDoneProject(first)
    vi.setSystemTime(T0 + 8 * DAY)

    const late = new KanbanHostService(ledgerFile())
    services.push(late)
    late.setArchivePolicy({ afterDays: 7, sweepMinutes: 60 })
    expect(late.snapshot().revision).toBe(0)
    late.start()
    expect(late.getProject(id)?.archivedAt).toBe(T0 + 8 * DAY)
  })

  it('I19: an unreadable request directory is conservative and does not stop the sweep', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const poison = service.createProject({ title: 'poison', workspaceDir: join(dir, 'poison'), goal: 'g' }).id
    service.transition(poison, 'done')
    // A file where the artifact directory should be: `readdirSync` fails.
    mkdirSync(dirname(projectDir(service.getProject(poison)!)), { recursive: true })
    writeFileSync(projectDir(service.getProject(poison)!), 'not a directory')
    const healthy = createDoneProject(service, 'healthy')

    vi.setSystemTime(T0 + 8 * DAY)
    expect(service.archiveSweep().projects).toEqual([healthy])
    expect(service.getProject(poison)?.archivedAt).toBeUndefined()
  })

  it('I16: a failed write rolls the ledger back in memory and the next sweep retries', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const id = createDoneProject(service)
    const revision = service.snapshot().revision
    const before = service.getProject(id)!
    const version = before.version
    const historyLength = before.history.length

    // Block the atomic write: saveState writes `<file>.tmp` first.
    mkdirSync(`${ledgerFile()}.tmp`, { recursive: true })
    vi.setSystemTime(T0 + 8 * DAY)
    expect(service.archiveSweep()).toEqual({ projects: [], tasks: [] })
    const rolledBack = service.getProject(id)!
    expect(rolledBack.archivedAt).toBeUndefined()
    expect(rolledBack.archivedBy).toBeUndefined()
    expect(rolledBack.archiveNote).toBeUndefined()
    expect(rolledBack.version).toBe(version)
    expect(rolledBack.history).toHaveLength(historyLength)
    expect(rolledBack.updatedAt).toBe(before.updatedAt)
    expect(service.snapshot().revision).toBe(revision)

    rmSync(`${ledgerFile()}.tmp`, { recursive: true, force: true })
    expect(service.archiveSweep().projects).toEqual([id])
  })

  it('I20: a throwing sweep is swallowed by the timer and the timer survives', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const id = createDoneProject(service)
    vi.setSystemTime(T0 + 8 * DAY)
    const failing = service as unknown as { hasActionableRequest: (project: Project) => boolean }
    const original = failing.hasActionableRequest
    failing.hasActionableRequest = () => {
      throw new Error('boom')
    }
    expect(() => vi.advanceTimersByTime(60 * 60_000)).not.toThrow()

    // The timer is still alive: the next tick archives normally.
    failing.hasActionableRequest = original
    vi.setSystemTime(T0 + 8 * DAY + 2 * 60 * 60_000)
    vi.advanceTimersByTime(60 * 60_000)
    expect(service.getProject(id)?.archivedAt).toBeDefined()
  })
})

describe('archive actions: manual entry, idempotence, restore', () => {
  it('I1/I2/I3/I4: every rejection is an explanatory ledger-level error', () => {
    const service = makeService()
    const designing = service.createProject({ title: 'designing', workspaceDir: dir, goal: 'g' }).id
    expect(() => service.archiveProject(designing)).toThrow(/尚未完成/)

    const container = service.createProject({ title: 'container', workspaceDir: dir, goal: 'g', lifecycle: 'long-running' }).id
    service.transition(container, 'done')
    expect(() => service.archiveProject(container)).toThrow(/长期执行项目/)

    const unfinished = decompose(service, [{ title: 'A', kind: 'execute' }])
    service.transition(unfinished, 'done')
    expect(() => service.archiveProject(unfinished)).toThrow(/仍有未完成的子任务/)

    const requested = createDoneProject(service, 'requested')
    writeRequest(service.getProject(requested)!)
    expect(() => service.archiveProject(requested)).toThrow(/待处理的新增任务请求/)

    expect(() => service.archiveProject('nope')).toThrow('unknown project nope')
  })

  it('I6/I7: archive is idempotent and restore is a single, exact inverse', () => {
    const service = makeService()
    const id = createDoneProject(service)
    const project = service.getProject(id)!
    mkdirSync(projectDir(project), { recursive: true })
    writeFileSync(planPathFor(project), '# plan\n', 'utf8')

    service.archiveProject(id)
    const archivedRevision = service.snapshot().revision
    const archivedVersion = service.getProject(id)!.version
    expect(service.getProject(id)!.archiveNote).toBe('手动归档')
    expect(service.getProject(id)!.archivedBy).toBe('human')
    // I8: the record is hidden from the view but still addressable by id.
    expect(service.snapshot().projects).toHaveLength(0)
    expect(service.projectIds()).toContain(id)
    expect(service.readProjectFile(planPathFor(project))).toBe('# plan\n')

    expect(service.archiveProject(id)).toBe(service.getProject(id))
    expect(service.snapshot().revision).toBe(archivedRevision)
    expect(service.getProject(id)!.version).toBe(archivedVersion)

    vi.setSystemTime(T0 + 3 * DAY)
    service.unarchiveProject(id)
    const restored = service.getProject(id)!
    expect(restored.archivedAt).toBeUndefined()
    expect(restored.archivedBy).toBeUndefined()
    expect(restored.archiveNote).toBeUndefined()
    expect(restored.status).toBe('done')
    expect(restored.history.at(-1)?.note).toBe('恢复归档')
    expect(restored.updatedAt).toBe(T0 + 3 * DAY)

    // Restoring twice is a no-op, not a second history entry.
    const revision = service.snapshot().revision
    service.unarchiveProject(id)
    expect(service.snapshot().revision).toBe(revision)
  })

  it('I17: a restore buys a full window, so the sweep never undoes it immediately', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const id = createDoneProject(service)
    vi.setSystemTime(T0 + 7 * DAY)
    expect(service.archiveSweep().projects).toEqual([id])

    service.unarchiveProject(id)
    // The next sweep (≤ one cadence later) must not re-archive it.
    vi.setSystemTime(T0 + 7 * DAY + 30 * 60_000)
    expect(service.archiveSweep()).toEqual({ projects: [], tasks: [] })
    expect(service.getProject(id)?.archivedAt).toBeUndefined()

    vi.setSystemTime(T0 + 14 * DAY)
    expect(service.archiveSweep().projects).toEqual([id])
  })

  it('I18: leaves are archived individually and independently of their project', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60, doneTaskLeaves: true })
    const projectId = decompose(service, [{ title: 'A', kind: 'execute' }, { title: 'B', kind: 'execute' }])
    const [leafA, leafB] = service.projectTasks(projectId)
    service.reportTaskExecuteDone(leafA!.id)

    // Shape C: a done leaf of a still-active project.
    vi.setSystemTime(T0 + 7 * DAY)
    expect(service.archiveSweep()).toEqual({ projects: [], tasks: [leafA!.id] })
    expect(service.getTask(leafA!.id)?.archivedAt).toBe(T0 + 7 * DAY)
    expect(service.snapshot().tasks.map(task => task.id)).toEqual([leafB!.id])
    expect(service.snapshot().archivedCounts).toEqual({ projects: 0, tasks: 1 })

    // The project completes and is archived as a whole; its leaves are NOT
    // stamped (a project restore is a single click).
    service.reportTaskExecuteDone(leafB!.id)
    vi.setSystemTime(T0 + 14 * DAY)
    expect(service.archiveSweep().projects).toEqual([projectId])
    expect(service.getTask(leafB!.id)?.archivedAt).toBeUndefined()
    expect(service.snapshot().archivedCounts).toEqual({ projects: 1, tasks: 0 })
    expect(service.snapshot().tasks).toEqual([])

    // Restoring the project brings back everything except the leaf the human
    // had archived on its own: the visible set is the pre-archive one.
    service.unarchiveProject(projectId)
    expect(service.snapshot().projects.map(project => project.id)).toEqual([projectId])
    expect(service.snapshot().tasks.map(task => task.id)).toEqual([leafB!.id])
    expect(service.getTask(leafA!.id)?.archivedAt).toBe(T0 + 7 * DAY)
    expect(service.snapshot().archivedCounts).toEqual({ projects: 0, tasks: 1 })
  })

  it('the leaf-level switch turns automatic leaf archiving off without disabling the manual action', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60, doneTaskLeaves: false })
    const projectId = decompose(service, [{ title: 'A', kind: 'execute' }, { title: 'B', kind: 'execute' }])
    const [leafA] = service.projectTasks(projectId)
    service.reportTaskExecuteDone(leafA!.id)

    vi.setSystemTime(T0 + 7 * DAY)
    expect(service.archiveSweep().tasks).toEqual([])
    expect(service.archiveTask(projectId, leafA!.id).archivedAt).toBe(T0 + 7 * DAY)
  })

  it('archive-task refuses a non-done leaf, a finished project and a foreign project', () => {
    const service = makeService()
    const projectId = decompose(service, [{ title: 'A', kind: 'execute' }])
    const [leaf] = service.projectTasks(projectId)
    expect(() => service.archiveTask(projectId, leaf!.id)).toThrow(/尚未完成/)

    service.reportTaskExecuteDone(leaf!.id)
    // The project is done now, so the leaf hides and returns with it.
    expect(() => service.archiveTask(projectId, leaf!.id)).toThrow(/随项目一起隐藏/)
    expect(() => service.archiveTask(projectId, 'nope')).toThrow('unknown task nope')
    expect(() => service.archiveTask('other', leaf!.id)).toThrow(/does not belong/)
  })

  it('unarchive-task revokes a leaf marker, also while its project is archived', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const projectId = decompose(service, [{ title: 'A', kind: 'execute' }, { title: 'B', kind: 'execute' }])
    const [leafA, leafB] = service.projectTasks(projectId)
    service.reportTaskExecuteDone(leafA!.id)
    vi.setSystemTime(T0 + 7 * DAY)
    service.archiveSweep()
    service.reportTaskExecuteDone(leafB!.id)
    vi.setSystemTime(T0 + 14 * DAY)
    service.archiveSweep()
    expect(service.getProject(projectId)?.archivedAt).toBe(T0 + 14 * DAY)

    // Clearing while hidden is safe: it only revokes an intent, and it shows
    // up when the project comes back.
    service.unarchiveTask(projectId, leafA!.id)
    expect(service.getTask(leafA!.id)?.archivedAt).toBeUndefined()
    service.unarchiveProject(projectId)
    expect(service.snapshot().tasks.map(task => task.id).sort()).toEqual([leafA!.id, leafB!.id].sort())
  })
})

describe('archive and the rest of the ledger', () => {
  it('the snapshot hides archived records, counts them, and never dangles a badge', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const id = createDoneProject(service)
    vi.setSystemTime(T0 + 8 * DAY)
    service.archiveSweep()

    const empty = service.snapshot()
    expect(empty.projects).toEqual([])
    expect(empty.tasks).toEqual([])
    expect(empty.archivedCounts).toEqual({ projects: 1, tasks: 0 })

    // GAP-A/G2: a request that arrives after the archive re-surfaces the
    // project (with its badge) WITHOUT clearing the ledger marker, so the
    // request can never be "materializable but invisible".
    writeRequest(service.getProject(id)!)
    expect(service.refreshPendingAdditions(id)).toBe(true)
    const withRequest = service.snapshot()
    expect(withRequest.projects.map(project => project.id)).toEqual([id])
    expect(withRequest.pendingAdditions?.map(entry => entry.projectId)).toEqual([id])
    expect(service.getProject(id)?.archivedAt).toBe(T0 + 8 * DAY)
    expect(withRequest.archivedCounts).toEqual({ projects: 1, tasks: 0 })
    // The published entry survives the snapshot's hygiene pass (it is keyed on
    // the raw ledger, not on the filtered view).
    expect(service.snapshot().pendingAdditions?.map(entry => entry.projectId)).toEqual([id])

    // Discarding the request puts the project back into the archive view only.
    rmSync(taskAdditionsPathFor(service.getProject(id)!))
    expect(service.refreshPendingAdditions(id)).toBe(true)
    expect(service.snapshot().projects).toEqual([])
    expect(service.snapshot().pendingAdditions).toEqual([])
  })

  it('I11: a status change away from done clears the marker (materialize re-opens for free)', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const id = createDoneProject(service)
    vi.setSystemTime(T0 + 8 * DAY)
    service.archiveSweep()
    expect(service.getProject(id)?.archivedAt).toBe(T0 + 8 * DAY)

    // A human move out of `done` is enough: no explicit unarchive call exists
    // on this path, and the project must not stay hidden while it runs.
    service.transition(id, 'executing')
    const project = service.getProject(id)!
    expect(project.status).toBe('executing')
    expect(project.archivedAt).toBeUndefined()
    expect(project.archiveNote).toBeUndefined()
    expect(service.snapshot().projects.map(entry => entry.id)).toEqual([id])
  })

  it('I5/AC8: archiving never touches a session, a hook or a file', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const id = createDoneProject(service)
    const project = service.getProject(id)!
    mkdirSync(projectDir(project), { recursive: true })
    writeFileSync(planPathFor(project), '# plan\n', 'utf8')
    writeRequest(project, 'tasks-additions.123.discarded.json')

    const hooks = { designing: 0, executing: 0, taskDesigning: 0, taskExecuting: 0 }
    service.setSpawnHooks({
      onEnterDesigning: () => { hooks.designing += 1 },
      onEnterExecuting: () => { hooks.executing += 1 },
      onEnterTaskDesigning: () => { hooks.taskDesigning += 1 },
      onEnterTaskExecuting: () => { hooks.taskExecuting += 1 },
    })
    const cancelled: string[] = []
    service.setSessionCanceller(sessionId => cancelled.push(sessionId))
    const before = readdirSync(projectDir(project)).sort()

    vi.setSystemTime(T0 + 8 * DAY)
    service.archiveSweep()
    service.unarchiveProject(id)
    service.archiveProject(id)

    expect(hooks).toEqual({ designing: 0, executing: 0, taskDesigning: 0, taskExecuting: 0 })
    expect(cancelled).toEqual([])
    expect(readdirSync(projectDir(project)).sort()).toEqual(before)
    expect(service.getProject(id)?.sessionId).toBeUndefined()
  })

  it('I12/archiveEntries: the projection is flat, history-free, and agrees with the counts', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    // Shape A: a plain done project.
    const topLevel = createDoneProject(service, 'top')
    // Shape B: a done one-shot project affiliated to a long-running container.
    const container = service.createProject({ title: 'container', workspaceDir: dir, goal: 'g', lifecycle: 'long-running' }).id
    const child = service.createProject({ title: 'child', goal: 'g', parentId: container }).id
    service.transition(child, 'done')
    // Shape C: a done leaf of a still-active project.
    const active = decompose(service, [{ title: 'A', kind: 'execute' }, { title: 'B', kind: 'execute' }])
    const [leafA] = service.projectTasks(active)
    service.reportTaskExecuteDone(leafA!.id)

    vi.setSystemTime(T0 + 8 * DAY)
    service.archiveSweep()

    const entries = service.archiveEntries()
    expect(entries).toHaveLength(3)
    for (const entry of entries) expect('history' in entry).toBe(false)
    const counts = service.snapshot().archivedCounts!
    expect(counts.projects + counts.tasks).toBe(entries.length)
    expect(counts).toEqual({ projects: 2, tasks: 1 })

    const projectEntries = entries.filter((entry): entry is Extract<ArchiveEntry, { kind: 'project' }> => entry.kind === 'project')
    expect(projectEntries.map(entry => entry.id).sort()).toEqual([topLevel, child].sort())
    const childEntry = projectEntries.find(entry => entry.id === child)!
    expect(childEntry.parentTitle).toBe('container')
    expect(childEntry.taskCount).toBe(0)
    expect(childEntry.status).toBe('done')
    expect(childEntry.archivedBy).toBe('system')

    const taskEntry = entries.find((entry): entry is Extract<ArchiveEntry, { kind: 'task' }> => entry.kind === 'task')!
    expect(taskEntry.projectId).toBe(active)
    expect(taskEntry.titlePath).toBe(taskEntry.title)
    expect(taskEntry.projectTitle).toBe('leaf-owner')
    expect(taskEntry.taskKind).toBe('execute')

    // The cluster read closes a dependency graph: X's own archived leaves plus
    // its archived child projects — never X itself.
    expect(service.archiveEntries(container).map(entry => entry.id)).toEqual([child])
    expect(service.archiveEntries(active).map(entry => entry.id)).toEqual([leafA!.id])
    expect(service.archiveEntries(child)).toEqual([])
    expect(service.archiveEntries('unknown')).toEqual([])
  })

  it('keeps resolving every accessor by id after archiving (I8)', () => {
    const service = makeService({ afterDays: 7, sweepMinutes: 60 })
    const projectId = decompose(service, [{ title: 'A', kind: 'execute' }])
    const [leaf] = service.projectTasks(projectId)
    service.reportTaskExecuteDone(leaf!.id)
    vi.setSystemTime(T0 + 8 * DAY)
    service.archiveSweep()

    expect(service.getProject(projectId)).toBeDefined()
    expect(service.getTask(leaf!.id)).toBeDefined()
    expect(service.projectTasks(projectId)).toHaveLength(1)
    // Deleting an archived record still works: the ledger is the source, not
    // the view.
    service.deleteProject(projectId)
    expect(service.getProject(projectId)).toBeUndefined()
    expect(service.getTask(leaf!.id)).toBeUndefined()
  })
})

describe('archive marker normalization at load (fail open)', () => {
  function writeLedger(projects: unknown[], tasks: unknown[] = []): void {
    writeFileSync(ledgerFile(), JSON.stringify({ format: 1, revision: 7, projects, tasks }, null, 2), 'utf8')
  }

  function baseProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'p1', title: 'p', workspaceDir: dir, goal: 'g', status: 'done',
      version: 1, createdAt: T0, updatedAt: T0, lastActivityAt: T0, history: [],
      ...overrides,
    }
  }

  it('round-trips the three markers and keeps the ledger format', () => {
    const service = makeService()
    const project = service.getProject('p1')
    expect(project).toBeUndefined()

    writeLedger([baseProject({ archivedAt: T0 + 5, archivedBy: 'human', archiveNote: '手动归档' })])
    const loaded = new KanbanHostService(ledgerFile())
    services.push(loaded)
    loaded.start()
    const record = loaded.getProject('p1')!
    expect(record.archivedAt).toBe(T0 + 5)
    expect(record.archivedBy).toBe('human')
    expect(record.archiveNote).toBe('手动归档')
    expect(ledger().format).toBe(1)
    // Normalization never writes: the file on disk is untouched at boot.
    expect(JSON.parse(readFileSync(ledgerFile(), 'utf8')).revision).toBe(7)
  })

  it('drops an unusable marker instead of sending the ledger into the corrupt branch', () => {
    writeLedger(
      [
        baseProject({ id: 'bad', archivedAt: 'yesterday', archivedBy: 'human', archiveNote: 'x' }),
        baseProject({ id: 'actor', archivedAt: T0, archivedBy: 'robot', archiveNote: 'kept' }),
        baseProject({ id: 'orphan', archivedBy: 'human', archiveNote: 'x' }),
      ],
      [{ id: 't1', projectId: 'bad', titlePath: 'T', kind: 'execute', status: 'done', dependencies: [], version: 1, createdAt: T0, updatedAt: T0, lastActivityAt: T0, history: [], archivedAt: 'yesterday' }],
    )
    const service = new KanbanHostService(ledgerFile())
    services.push(service)
    service.start()

    const bad = service.getProject('bad')!
    expect(bad.archivedAt).toBeUndefined()
    expect(bad.archivedBy).toBeUndefined()
    expect(bad.archiveNote).toBeUndefined()
    const actor = service.getProject('actor')!
    expect(actor.archivedAt).toBe(T0)
    expect(actor.archivedBy).toBeUndefined()
    expect(actor.archiveNote).toBe('kept')
    const orphan = service.getProject('orphan')!
    expect(orphan.archivedAt).toBeUndefined()
    expect(orphan.archiveNote).toBeUndefined()
    // The corrupted marker is visible again rather than the whole board being
    // moved aside.
    expect(service.snapshot().projects.map(project => project.id)).toContain('bad')
    expect(service.snapshot().tasks.map(task => task.id)).toEqual(['t1'])
    expect(readdirSync(dir).some(name => name.includes('.corrupt-'))).toBe(false)
  })
})
