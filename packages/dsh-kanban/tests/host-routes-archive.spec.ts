/**
 * The archive surface of the HTTP layer: the on-demand `GET /kanban/archive`
 * detail read (deliberately NOT part of the hot snapshot) and the four
 * archive/unarchive actions on `POST /kanban/action`.
 *
 * Two properties get their own guards here because both are invisible until a
 * user sees a wrong number:
 *  - the read is a PROJECTION (no `history`) and read-only (no ledger write,
 *    no revision bump);
 *  - the read and the snapshot's `archivedCounts` agree, and a leaf is never
 *    listed while the project that owns it is itself archived.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeKanbanRoutes } from '../src/host-routes.ts'
import { KanbanHostService } from '../src/host-service.ts'
import type { ArchiveEntry, KanbanSnapshot, Project } from '../src/protocol.ts'
import { decompositionPathFor, projectDir } from '../src/session-runner.ts'

let dir: string
let ledger: string
let service: KanbanHostService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-routes-archive-'))
  ledger = join(dir, 'projects.json')
  service = new KanbanHostService(ledger)
  service.start()
})

afterEach(() => {
  service.dispose()
  rmSync(dir, { recursive: true, force: true })
})

interface FakeResponse {
  status: number
  body: { ok: boolean; error?: string; archive?: ArchiveEntry[]; snapshot?: KanbanSnapshot }
}

function fakeRequest(overrides: {
  method?: string
  url?: string
  remoteAddress?: string
} = {}): IncomingMessage {
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/kanban/archive',
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

function fakeResponse(): { res: ServerResponse; result(): FakeResponse } {
  const captured: { status: number; body: string } = { status: 0, body: '' }
  const res = {
    writeHead(status: number): void { captured.status = status },
    end(body?: string): void { captured.body = body ?? '' },
  } as unknown as ServerResponse
  return {
    res,
    result: () => ({ status: captured.status, body: JSON.parse(captured.body) as FakeResponse['body'] }),
  }
}

async function callRoute(req: IncomingMessage, path = '/kanban/archive'): Promise<FakeResponse> {
  const route = makeKanbanRoutes(service).find(candidate => candidate.path === path)
  expect(route, `the ${path} route must be registered`).toBeDefined()
  const { res, result } = fakeResponse()
  await route!.handler(req, res)
  return result()
}

function postRequest(action: unknown, method = 'POST'): IncomingMessage {
  const body = JSON.stringify({ requestId: 'req-1', action })
  const req = new EventEmitter() as IncomingMessage
  Object.assign(req, {
    method,
    url: '/kanban/action',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    destroy: () => {},
  })
  queueMicrotask(() => {
    req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

/** A decomposed project: one clarify leaf stays unfinished, so the project stays visible. */
const MIXED_DECOMPOSITION = {
  decomposed: true,
  tasks: [
    { title: '明确预算', kind: 'clarify', question: '预算上限是多少？' },
    { title: '实现功能', kind: 'execute' },
  ],
}

function createProject(options: { title: string; parentId?: string; lifecycle?: 'long-running' }): Project {
  const created = options.parentId === undefined
    ? service.createProject({
        title: options.title,
        workspaceDir: dir,
        goal: 'g',
        ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
      })
    // An affiliated one-shot project inherits the parent's workspaceDir.
    : service.createProject({ title: options.title, goal: 'g', parentId: options.parentId })
  return service.getProject(created.id)!
}

/** A project whose only leaf is done — i.e. the project itself is `done` (form A / B). */
function doneProject(title: string, parentId?: string): Project {
  const project = createProject({ title, ...(parentId === undefined ? {} : { parentId }) })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({
    decomposed: true,
    tasks: [{ title: '实现功能', kind: 'execute' }],
  }), 'utf8')
  service.confirmPlan(project.id)
  const leaf = service.projectTasks(project.id)[0]!
  service.reportTaskExecuteDone(leaf.id, 'system')
  expect(service.getProject(project.id)?.status).toBe('done')
  return service.getProject(project.id)!
}

/** A visible project that owns one `done` leaf (form C: the leaf is archived alone). */
function projectWithDoneLeaf(title: string): { project: Project; doneLeafId: string } {
  const project = createProject({ title })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify(MIXED_DECOMPOSITION), 'utf8')
  service.confirmPlan(project.id)
  const leaf = service.projectTasks(project.id).find(task => task.kind === 'execute')!
  service.reportTaskExecuteDone(leaf.id, 'system')
  expect(service.getProject(project.id)?.status).not.toBe('done')
  return { project: service.getProject(project.id)!, doneLeafId: leaf.id }
}

describe('GET /kanban/archive', () => {
  it('HRA-1 lists every archived record — projects and stand-alone leaves — and hides the leaves that went with an archived project', async () => {
    const archivedProject = doneProject('已完成一次性项目')
    service.archiveProject(archivedProject.id, 'manual')
    const { project: active, doneLeafId } = projectWithDoneLeaf('活跃项目')
    service.archiveTask(active.id, doneLeafId, '累积的已完成叶子')

    const response = await callRoute(fakeRequest())
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    const entries = response.body.archive!
    expect(entries.map(entry => [entry.kind, entry.id]).sort())
      .toEqual([['project', archivedProject.id], ['task', doneLeafId]].sort())

    // P2: an archived project's leaves are never listed on their own — they
    // went into the archive with the project and come back with it.
    expect(entries.some(entry => entry.kind === 'task' && entry.projectId === archivedProject.id)).toBe(false)
    // P2, the other direction: every listed leaf's project is still visible.
    const snapshot = service.snapshot()
    for (const entry of entries) {
      if (entry.kind !== 'task') continue
      expect(snapshot.projects.some(candidate => candidate.id === entry.projectId)).toBe(true)
    }

    // P3: the header count and the list length are the same number.
    expect(snapshot.archivedCounts!.projects + snapshot.archivedCounts!.tasks).toBe(entries.length)
    expect(snapshot.archivedCounts).toEqual({ projects: 1, tasks: 1 })
  })

  it('HRA-2 narrows to one cluster: a project\'s own archived leaves and its archived child projects', async () => {
    // A long-running container is a board container, never a work item.
    const container = createProject({ title: '长期执行中的项目', lifecycle: 'long-running' })
    const child = doneProject('已完成的关联子项目', container.id)
    service.archiveProject(child.id, 'auto: done for 7d')
    const { project: active, doneLeafId } = projectWithDoneLeaf('活跃项目')
    service.archiveTask(active.id, doneLeafId, '累积的已完成叶子')

    const containerCluster = await callRoute(fakeRequest({
      url: `/kanban/archive?projectId=${encodeURIComponent(container.id)}`,
    }))
    expect(containerCluster.status).toBe(200)
    expect(containerCluster.body.archive!.map(entry => [entry.kind, entry.id]))
      .toEqual([['project', child.id]])
    // The container itself is not archived, so it is not part of its own cluster.
    expect(containerCluster.body.archive!.some(entry => entry.id === container.id)).toBe(false)
    expect(containerCluster.body.archive![0]).toMatchObject({ kind: 'project', parentTitle: container.title })

    const activeCluster = await callRoute(fakeRequest({
      url: `/kanban/archive?projectId=${encodeURIComponent(active.id)}`,
    }))
    expect(activeCluster.body.archive!.map(entry => [entry.kind, entry.id]))
      .toEqual([['task', doneLeafId]])

    // Nothing to pull back for the archived child: its leaves hide with it.
    const childCluster = await callRoute(fakeRequest({
      url: `/kanban/archive?projectId=${encodeURIComponent(child.id)}`,
    }))
    expect(childCluster.status).toBe(200)
    expect(childCluster.body.archive).toEqual([])
  })

  it('HRA-3 rejects a blank projectId without delegating to the service', async () => {
    const spy = vi.spyOn(service, 'archiveEntries')
    for (const blank of ['', '%20', '   ']) {
      const response = await callRoute(fakeRequest({ url: `/kanban/archive?projectId=${blank}` }))
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ ok: false, error: 'projectId-blank' })
    }
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('HRA-4 answers an unknown projectId with an empty list, not 404', async () => {
    doneProject('已完成一次性项目')
    const response = await callRoute(fakeRequest({ url: '/kanban/archive?projectId=nope' }))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, archive: [] })
  })

  it('HRA-5 keeps the method fence and the loopback fence', async () => {
    const wrongMethod = await callRoute(fakeRequest({ method: 'POST' }))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.body).toEqual({ ok: false, error: 'method-not-allowed' })

    const foreign = await callRoute(fakeRequest({ remoteAddress: '10.0.0.8' }))
    expect(foreign.status).toBe(403)
    expect(foreign.body).toEqual({ ok: false, error: 'forbidden' })
  })

  it('HRA-6 serves a projection: no history rides along', async () => {
    const archivedProject = doneProject('已完成一次性项目')
    service.archiveProject(archivedProject.id, 'manual')
    const { project: active, doneLeafId } = projectWithDoneLeaf('活跃项目')
    service.archiveTask(active.id, doneLeafId)

    const response = await callRoute(fakeRequest())
    const entries = response.body.archive!
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      // History is ~half the ledger by size and the archive list shows a title
      // plus three timestamps: this assertion is the guard against a later
      // "just return the record" refactor.
      expect('history' in entry).toBe(false)
    }
  })

  it('HRA-7 is read-only: the ledger bytes and the revision do not move', async () => {
    const archivedProject = doneProject('已完成一次性项目')
    service.archiveProject(archivedProject.id, 'manual')
    const before = readFileSync(ledger, 'utf8')
    const revision = service.snapshot().revision

    await callRoute(fakeRequest())
    await callRoute(fakeRequest({ url: `/kanban/archive?projectId=${encodeURIComponent(archivedProject.id)}` }))

    expect(readFileSync(ledger, 'utf8')).toBe(before)
    expect(service.snapshot().revision).toBe(revision)
  })
})

describe('POST /kanban/action archive-project / unarchive-project', () => {
  it('HRA-8 archives and restores a project in one round trip', async () => {
    const project = doneProject('手动归档的项目')

    const archived = await callRoute(postRequest({ kind: 'archive-project', projectId: project.id, note: '手动归档' }), '/kanban/action')
    expect(archived.status).toBe(200)
    expect(archived.body.snapshot!.projects.some(candidate => candidate.id === project.id)).toBe(false)
    expect(archived.body.snapshot!.archivedCounts).toEqual({ projects: 1, tasks: 0 })
    // Archived ≠ deleted: the record is still addressable by id in the ledger.
    expect(service.getProject(project.id)?.status).toBe('done')

    const restored = await callRoute(postRequest({ kind: 'unarchive-project', projectId: project.id }), '/kanban/action')
    expect(restored.status).toBe(200)
    expect(restored.body.snapshot!.projects.some(candidate => candidate.id === project.id)).toBe(true)
    // An empty archive may be reported as zeros or by omitting the aggregate
    // (both mean "nothing archived"); either way it must never be non-zero.
    expect(restored.body.snapshot!.archivedCounts?.projects ?? 0).toBe(0)
    expect(restored.body.snapshot!.archivedCounts?.tasks ?? 0).toBe(0)
    expect(service.getProject(project.id)?.status).toBe('done')
  })

  it('HRA-9 maps a host refusal to an explanatory 400', async () => {
    // Not `done` yet: only finished nodes may be archived (the message itself
    // belongs to the host half; the route only has to surface it).
    const { project } = projectWithDoneLeaf('还在进行中的项目')
    const refused = await callRoute(postRequest({ kind: 'archive-project', projectId: project.id }), '/kanban/action')
    expect(refused.status).toBe(400)
    expect(refused.body.ok).toBe(false)
    expect(refused.body.error).toBeTruthy()
    expect(service.snapshot().projects.some(candidate => candidate.id === project.id)).toBe(true)

    // An unknown id is refused the same way (never a silent no-op).
    const unknown = await callRoute(postRequest({ kind: 'archive-project', projectId: 'nope' }), '/kanban/action')
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toMatch(/unknown project/)
  })

  it('HRA-10 archives and restores a single finished leaf through the action route', async () => {
    const { project, doneLeafId } = projectWithDoneLeaf('活跃项目')

    const archived = await callRoute(postRequest({ kind: 'archive-task', projectId: project.id, taskId: doneLeafId }), '/kanban/action')
    expect(archived.status).toBe(200)
    expect(archived.body.snapshot!.tasks.some(candidate => candidate.id === doneLeafId)).toBe(false)
    expect(archived.body.snapshot!.archivedCounts).toEqual({ projects: 0, tasks: 1 })
    // The project itself stays visible: archiving a leaf never moves a project.
    expect(archived.body.snapshot!.projects.some(candidate => candidate.id === project.id)).toBe(true)

    const restored = await callRoute(postRequest({ kind: 'unarchive-task', projectId: project.id, taskId: doneLeafId }), '/kanban/action')
    expect(restored.status).toBe(200)
    expect(restored.body.snapshot!.tasks.some(candidate => candidate.id === doneLeafId)).toBe(true)
    expect(restored.body.snapshot!.archivedCounts?.projects ?? 0).toBe(0)
    expect(restored.body.snapshot!.archivedCounts?.tasks ?? 0).toBe(0)
  })

  it('HRA-11 rejects a leaf that does not belong to the named project', async () => {
    const a = projectWithDoneLeaf('项目 A')
    const b = projectWithDoneLeaf('项目 B')
    const response = await callRoute(
      postRequest({ kind: 'archive-task', projectId: a.project.id, taskId: b.doneLeafId }),
      '/kanban/action',
    )
    expect(response.status).toBe(400)
    expect(response.body.ok).toBe(false)
    expect(service.snapshot().tasks.some(candidate => candidate.id === b.doneLeafId)).toBe(true)
  })
})
