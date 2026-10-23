/**
 * The read-only half of the late task-additions fix: the per-tick probe that
 * publishes「N 项待处理的新增任务请求」into the snapshot.
 *
 * Contracts pinned here:
 *  - a ready request is visible with its file / mtime / batches / count / items;
 *  - a malformed request is a SHAPED outcome (`state:'malformed'`), never
 *    `undefined` — a node that already left the observation window has no
 *    other code path that could ever throw;
 *  - the field is an ASSEMBLY field: it is never persisted to the ledger;
 *  - the probe is a pure read, but a malformed version writes at most ONE
 *    anomaly note (a 5-second tick must never become a ledger-write amplifier);
 *  - ingestion (P0) freezes the mutable slot and is idempotent.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { PENDING_ITEMS_MAX, type Project } from '../src/protocol.ts'
import { projectDir, taskAdditionsPathFor } from '../src/session-runner.ts'

let dir: string
let ledger: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-pending-'))
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

/** A project in the classic executing phase (no decomposition, no leaves). */
function executingProject(service: KanbanHostService): Project {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
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

function stagedNames(project: Project, stage: string): string[] {
  return readdirSync(projectDir(project)).filter(name => name.endsWith(`.${stage}.json`)).sort()
}

describe('KanbanHostService pending additions probe', () => {
  it('publishes a ready request with file, mtime, batches, count and items', () => {
    const service = makeService()
    const project = executingProject(service)
    const path = writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: '补齐社区文档', kind: 'execute' },
        { title: '口径确认', kind: 'clarify', question: '范围？' },
      ],
    })
    backdate(path)

    expect(service.refreshPendingAdditions(project.id)).toBe(true)
    const entries = service.snapshot().pendingAdditions!
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.projectId).toBe(project.id)
    expect(entry.state).toBe('ready')
    expect(entry.file).toBe('tasks-additions.json')
    expect(entry.batches).toBe(1)
    expect(entry.count).toBe(2)
    expect(entry.error).toBeUndefined()
    expect(entry.items).toEqual([
      { titlePath: '补齐社区文档', kind: 'execute' },
      { titlePath: '口径确认', kind: 'clarify' },
    ])
    expect(entry.at).toBeGreaterThan(0)
    // Publishing is idempotent: an unchanged probe is a complete no-op.
    expect(service.refreshPendingAdditions(project.id)).toBe(false)
  })

  it('carries an empty array (not undefined) when nothing is pending', () => {
    const service = makeService()
    const project = executingProject(service)
    expect(service.refreshPendingAdditions(project.id)).toBe(false)
    expect(service.snapshot().pendingAdditions).toEqual([])
    expect(service.peekAdditions(project.id)).toBeUndefined()
    expect(service.peekAdditions('unknown-project')).toBeUndefined()
  })

  it('is an assembly field: the probe never writes the ledger and never bumps the revision', () => {
    const service = makeService()
    const project = executingProject(service)
    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '后续工作', kind: 'execute' }] })
    backdate(path)
    const before = service.snapshot().revision
    const bytes = readFileSync(ledger, 'utf8')

    expect(service.refreshPendingAdditions(project.id)).toBe(true)
    expect(service.snapshot().revision).toBe(before)
    expect(readFileSync(ledger, 'utf8')).toBe(bytes)
    // The hot SSE payload carries the field too, but the ledger text never does.
    expect(service.eventPayload().pendingAdditions).toHaveLength(1)
    expect(readFileSync(ledger, 'utf8')).not.toContain('pendingAdditions')
  })

  it('reports a malformed request as a shaped, bounded outcome and keeps the file', () => {
    const service = makeService()
    const project = executingProject(service)
    const path = writeAdditions(project, '{ not json')
    backdate(path)

    const probe = service.peekAdditions(project.id)
    expect(probe?.state).toBe('malformed')
    expect(probe?.count).toBe(0)
    expect(probe?.items).toEqual([])
    expect(probe?.error).toBeTruthy()
    expect((probe?.error ?? '').length).toBeLessThanOrEqual(200)
    expect(probe?.file).toBe('tasks-additions.json')

    service.refreshPendingAdditions(project.id)
    const entry = service.snapshot().pendingAdditions![0]!
    expect(entry.state).toBe('malformed')
    expect(entry.items).toBeUndefined()
    expect(entry.error).toBeTruthy()
    // Evidence is preserved: the host never renames a broken request away.
    expect(existsSync(path)).toBe(true)
  })

  it('writes exactly ONE anomaly note per malformed file version (no per-tick amplification)', () => {
    const service = makeService()
    const project = executingProject(service)
    const path = writeAdditions(project, '{ not json')
    backdate(path)

    service.refreshPendingAdditions(project.id)
    service.refreshPendingAdditions(project.id)
    service.refreshPendingAdditions(project.id)
    const notes = () => service.getProject(project.id)!.history.filter(entry => (entry.note ?? '').includes('无法解析'))
    expect(notes()).toHaveLength(1)
  })

  it('reports a repaired-then-broken-again file as a NEW version (second note)', () => {
    const service = makeService()
    const project = executingProject(service)
    const broken = writeAdditions(project, '{ not json')
    backdate(broken, 9_000)
    service.refreshPendingAdditions(project.id)
    expect(service.snapshot().pendingAdditions![0]!.state).toBe('malformed')

    // The human fixes it: the same file becomes valid, the badge turns ready.
    writeAdditions(project, { decomposed: true, tasks: [{ title: '后续工作', kind: 'execute' }] })
    backdate(taskAdditionsPathFor(project), 8_000)
    service.refreshPendingAdditions(project.id)
    expect(service.snapshot().pendingAdditions![0]!.state).toBe('ready')

    // A new breakage is a new (file, mtime) version and is reported again.
    writeAdditions(project, '{ still not json')
    backdate(taskAdditionsPathFor(project), 7_000)
    service.refreshPendingAdditions(project.id)
    const notes = service.getProject(project.id)!.history.filter(entry => (entry.note ?? '').includes('无法解析'))
    expect(notes).toHaveLength(2)
    expect(service.snapshot().pendingAdditions![0]!.state).toBe('malformed')
  })

  it('aggregates several batches and bounds the preview at PENDING_ITEMS_MAX', () => {
    const service = makeService()
    const project = executingProject(service)
    // A frozen batch plus the live slot: the badge must count BOTH.
    writeAdditions(project, { decomposed: true, tasks: [{ title: '第一批', kind: 'execute' }] })
    backdate(taskAdditionsPathFor(project), 9_000)
    service.ingestPendingAdditions()
    expect(stagedNames(project, 'pending')).toHaveLength(1)

    const many = Array.from({ length: PENDING_ITEMS_MAX + 5 }, (_, index) => ({ title: `第十二批-${index}`, kind: 'execute' as const }))
    writeAdditions(project, { decomposed: true, tasks: many })
    backdate(taskAdditionsPathFor(project), 8_000)
    service.refreshPendingAdditions(project.id)

    const entry = service.snapshot().pendingAdditions![0]!
    expect(entry.state).toBe('ready')
    expect(entry.batches).toBe(2)
    expect(entry.count).toBe(PENDING_ITEMS_MAX + 6)
    expect(entry.items).toHaveLength(PENDING_ITEMS_MAX)
  })

  it('drops a ghost entry when its project disappears', () => {
    const service = makeService()
    const project = executingProject(service)
    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '后续工作', kind: 'execute' }] })
    backdate(path)
    service.refreshPendingAdditions(project.id)
    expect(service.snapshot().pendingAdditions).toHaveLength(1)

    service.deleteProject(project.id)
    expect(service.snapshot().pendingAdditions).toEqual([])
    expect(service.peekAdditions(project.id)).toBeUndefined()
  })

  it('pushes the new badge over SSE without bumping the revision or saving the ledger', () => {
    const service = makeService()
    const project = executingProject(service)
    const payloads: Array<{ revision: number; pendingAdditions?: unknown[] }> = []
    service.subscribe(payload => { payloads.push(payload) })
    const revision = service.snapshot().revision
    const bytes = readFileSync(ledger, 'utf8')

    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '后续工作', kind: 'execute' }] })
    backdate(path)
    expect(service.refreshPendingAdditions(project.id)).toBe(true)

    expect(payloads).toHaveLength(1)
    expect(payloads[0]!.revision).toBe(revision)
    expect(payloads[0]!.pendingAdditions).toHaveLength(1)
    expect(readFileSync(ledger, 'utf8')).toBe(bytes)
  })

  it('freezes the mutable fresh slot into an immutable staged file (idempotent ingestion)', () => {
    const service = makeService()
    const project = executingProject(service)
    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '后续工作', kind: 'execute' }] })
    backdate(path)

    service.ingestPendingAdditions()
    // The agent's overwritable slot is gone; the request survives as a batch.
    expect(existsSync(path)).toBe(false)
    expect(stagedNames(project, 'pending')).toHaveLength(1)
    // A second ingest is a no-op: nothing fresh is left to freeze.
    service.ingestPendingAdditions()
    expect(stagedNames(project, 'pending')).toHaveLength(1)

    service.refreshPendingAdditions(project.id)
    const entry = service.snapshot().pendingAdditions![0]!
    expect(entry.state).toBe('ready')
    expect(entry.count).toBe(1)
    expect(entry.file).toBe(stagedNames(project, 'pending')[0])
  })
})
