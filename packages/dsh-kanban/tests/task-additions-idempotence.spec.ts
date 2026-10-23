/**
 * Idempotence of the late task-additions consumption (B3 / R4).
 *
 * The claim is an atomic rename; the plan skips `titlePath`s that already
 * exist, so every crash point replays safely:
 *   - crash AFTER the claim, BEFORE the commit → the `.consuming` batch is
 *     replayed and materialized exactly once;
 *   - crash AFTER the commit, BEFORE the audit rename → the replay skips every
 *     leaf and only appends the audit note;
 *   - two batches sharing one mtime must never overwrite each other's audit
 *     file (a POSIX rename silently replaces the target).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import type { Project } from '../src/protocol.ts'
import { decompositionPathFor, projectDir, taskAdditionsPathFor } from '../src/session-runner.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-idempotence-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeService(): KanbanHostService {
  const service = new KanbanHostService(join(dir, 'projects.json'))
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

function names(project: Project): string[] {
  return readdirSync(projectDir(project)).sort()
}

function staged(project: Project, stage: string): string[] {
  return names(project).filter(name => name.endsWith(`.${stage}.json`))
}

describe('late task-additions idempotence', () => {
  it('replays a claimed (`.consuming`) batch after a crash-before-commit: skips what exists, keeps the file count stable', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: '实现功能', kind: 'execute' },
        { title: '补充测试', kind: 'execute' },
      ],
    })
    backdate(path)
    service.ingestPendingAdditions()
    expect(staged(project, 'pending')).toHaveLength(1)

    // Simulate a consumer that claimed the batch (atomic rename) and died
    // before committing anything.
    const pending = staged(project, 'pending')[0]!
    renameSync(join(projectDir(project), pending), join(projectDir(project), pending.replace('.pending.json', '.consuming.json')))
    expect(staged(project, 'consuming')).toHaveLength(1)

    const result = service.materializePendingAdditions(project.id)
    expect(result.created.map(task => task.titlePath)).toEqual(['补充测试'])
    expect(result.skipped).toEqual(['实现功能'])
    expect(service.projectTasks(project.id).map(task => task.titlePath).sort()).toEqual(['实现功能', '补充测试'])
    // The claimed batch reached its terminal audit name; no `.consuming` residue.
    expect(staged(project, 'consuming')).toHaveLength(0)
    expect(staged(project, 'consumed')).toHaveLength(1)
    expect(service.getProject(project.id)!.history.at(-1)!.note).toContain('跳过 1 项（已存在：实现功能）')
  })

  it('replays a batch whose commit already happened (crash-before-audit-rename) as an audit-only note', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: '补充测试', kind: 'execute' },
        { title: '补充文档', kind: 'execute' },
      ],
    })
    backdate(path)
    expect(service.materializePendingAdditions(project.id).created).toHaveLength(2)
    const consumed = staged(project, 'consumed')
    expect(consumed).toHaveLength(1)

    // The audit rename never happened before the crash: a leftover copy is
    // still claimed as `.consuming`.
    const leftover = consumed[0]!.replace('.consumed.json', '.consuming.json')
    copyFileSync(join(projectDir(project), consumed[0]!), join(projectDir(project), leftover))

    const project2 = service.getProject(project.id)!
    const result = service.materializePendingAdditions(project.id)
    expect(result.created).toEqual([])
    expect([...result.skipped].sort()).toEqual(['补充文档', '补充测试'])
    expect(service.projectTasks(project.id)).toHaveLength(3)
    // Exactly one audit file per batch: the replay allocated its own name.
    expect(staged(project, 'consumed')).toHaveLength(2)
    expect(staged(project, 'consuming')).toHaveLength(0)
    expect(service.getProject(project.id)!.history.at(-1)!.note).toContain('新建 0 项')
    expect(project2.status).toBe('executing')
  })

  it('gives two batches that share one mtime two distinct audit files (no silent overwrite)', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])

    const first = writeAdditions(project, { decomposed: true, tasks: [{ title: '第一批', kind: 'execute' }] })
    backdate(first, 6_000)
    service.ingestPendingAdditions()
    const second = writeAdditions(project, { decomposed: true, tasks: [{ title: '第二批', kind: 'execute' }] })
    // Same source mtime as the first request: the identity collides on purpose.
    const same = new Date(Date.now() - 6_000)
    utimesSync(second, same, same)
    service.ingestPendingAdditions()

    const pending = staged(project, 'pending')
    expect(pending).toHaveLength(2)
    const result = service.materializePendingAdditions(project.id)
    expect(result.created.map(task => task.titlePath).sort()).toEqual(['第一批', '第二批'])
    const consumed = staged(project, 'consumed')
    expect(consumed).toHaveLength(2)
    // Both payloads survived: an ordinal suffix was inserted instead of a rename overwrite.
    const bodies = consumed.map(name => readFileSync(join(projectDir(project), name), 'utf8'))
    expect(bodies.some(body => body.includes('第一批'))).toBe(true)
    expect(bodies.some(body => body.includes('第二批'))).toBe(true)
    expect(new Set(consumed).size).toBe(2)
  })

  it('does not touch a half-written fresh slot, then accepts it once it stops changing', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '后续工作', kind: 'execute' }] })

    // Written a moment ago: the atomic-write window is still open.
    expect(service.peekAdditions(project.id)).toBeUndefined()
    expect(service.refreshPendingAdditions(project.id)).toBe(false)
    service.ingestPendingAdditions()
    expect(existsSync(path)).toBe(true)
    expect(staged(project, 'pending')).toHaveLength(0)
    expect(service.snapshot().pendingAdditions).toEqual([])

    backdate(path)
    expect(service.peekAdditions(project.id)?.state).toBe('ready')
    expect(service.refreshPendingAdditions(project.id)).toBe(true)
    expect(service.snapshot().pendingAdditions![0]!.count).toBe(1)
  })

  it('keeps a malformed request visible and untouched (no ingest, no rename, no materialization)', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, '{ half-written')
    backdate(path)

    service.ingestPendingAdditions()
    expect(existsSync(path)).toBe(true)
    expect(staged(project, 'pending')).toHaveLength(0)
    service.refreshPendingAdditions(project.id)
    expect(service.snapshot().pendingAdditions![0]!.state).toBe('malformed')
    expect(() => service.materializePendingAdditions(project.id)).toThrowError(/malformed/)
    expect(existsSync(path)).toBe(true)
  })

  it('stays exactly-once across repeated scans and repeated clicks', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '补充测试', kind: 'execute' }] })
    backdate(path)
    service.ingestPendingAdditions()
    expect(service.materializePendingAdditions(project.id).created).toHaveLength(1)

    for (let tick = 0; tick < 3; tick += 1) {
      service.ingestPendingAdditions()
      service.refreshPendingAdditions(project.id)
    }
    expect(service.snapshot().pendingAdditions).toEqual([])
    expect(service.applyTaskAdditions(project.id)).toBeUndefined()
    expect(() => service.materializePendingAdditions(project.id)).toThrowError(/no pending task-additions request/)
    expect(service.projectTasks(project.id)).toHaveLength(2)
    expect(staged(project, 'consumed')).toHaveLength(1)
  })

  it('keeps the settle path loud for a duplicate in the LIVE slot but idempotent for a staged batch', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])

    // A staged batch (already a receipt) is replayed idempotently, even by the
    // system actor: a crash replay must never block a project.
    writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: '实现功能', kind: 'execute' },
        { title: '补充测试', kind: 'execute' },
      ],
    })
    backdate(taskAdditionsPathFor(project))
    service.ingestPendingAdditions()
    const created = service.applyTaskAdditions(project.id)
    expect(created?.map(task => task.titlePath)).toEqual(['补充测试'])
    expect(service.projectTasks(project.id)).toHaveLength(2)

    // A brand-new live slot with a duplicate stays a loud failure (the agent's
    // own mistake must be seen, and the file is preserved for inspection).
    const path = writeAdditions(project, {
      decomposed: true,
      tasks: [{ title: '实现功能', kind: 'execute' }],
    })
    backdate(path)
    expect(() => service.applyTaskAdditions(project.id)).toThrowError(/duplicate task title path/)
    expect(existsSync(path)).toBe(true)
  })
})
