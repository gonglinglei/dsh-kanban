/**
 * POST /kanban/action with the `materialize-additions` envelope — the HTTP
 * surface of the board's「物化到看板」button.
 *
 * A success answers 200 + the NEW snapshot (badge gone, leaves added); every
 * failure is an explanatory 400 `{ ok:false, error }` and never a silent no-op.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKanbanRoutes } from '../src/host-routes.ts'
import { KanbanHostService } from '../src/host-service.ts'
import type { Project } from '../src/protocol.ts'
import { decompositionPathFor, projectDir, taskAdditionsPathFor } from '../src/session-runner.ts'

let dir: string
let service: KanbanHostService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-routes-materialize-'))
  service = new KanbanHostService(join(dir, 'projects.json'))
  service.start()
})

afterEach(() => {
  service.dispose()
  rmSync(dir, { recursive: true, force: true })
})

interface FakeResponse {
  status: number
  body: { ok: boolean; error?: string; snapshot?: { pendingAdditions?: unknown[]; tasks?: Array<{ titlePath: string }> } }
}

function fakeResponse(): { res: ServerResponse; result(): FakeResponse } {
  const captured: { status: number; body: string } = { status: 0, body: '' }
  const res = {
    writeHead(status: number): void { captured.status = status },
    end(body?: string): void { captured.body = body ?? '' },
  } as unknown as ServerResponse
  return { res, result: () => ({ status: captured.status, body: JSON.parse(captured.body) as FakeResponse['body'] }) }
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

async function callAction(req: IncomingMessage): Promise<FakeResponse> {
  const route = makeKanbanRoutes(service).find(candidate => candidate.path === '/kanban/action')
  expect(route, 'the /kanban/action route must be registered').toBeDefined()
  const { res, result } = fakeResponse()
  await route!.handler(req, res)
  return result()
}

/** A decomposed project whose only leaf is done (so the project is done). */
function doneProject(): Project {
  const project = service.createProject({ title: '代码开源审查', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({
    decomposed: true,
    tasks: [{ title: '全量开源就绪审查并输出报告', kind: 'execute' }],
  }), 'utf8')
  service.confirmPlan(project.id)
  const leaf = service.projectTasks(project.id)[0]!
  service.reportTaskExecuteDone(leaf.id, 'system')
  expect(service.getProject(project.id)?.status).toBe('done')
  return service.getProject(project.id)!
}

function writeAdditions(project: Project, body: unknown): void {
  const path = taskAdditionsPathFor(project)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  const at = new Date(Date.now() - 5_000)
  utimesSync(path, at, at)
}

describe('POST /kanban/action materialize-additions', () => {
  it('materializes the pending request and answers with the NEW snapshot', async () => {
    const project = doneProject()
    writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: '补齐 CONTRIBUTING 等社区文档', kind: 'execute' },
        { title: '提供英文 README', kind: 'execute' },
      ],
    })
    service.refreshPendingAdditions(project.id)
    expect(service.snapshot().pendingAdditions).toHaveLength(1)

    const response = await callAction(postRequest({ kind: 'materialize-additions', projectId: project.id, note: '人工确认' }))
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    // The badge is gone and the two leaves are on the board.
    expect(response.body.snapshot?.pendingAdditions).toEqual([])
    expect(response.body.snapshot?.tasks?.map(task => task.titlePath).sort())
      .toEqual(['全量开源就绪审查并输出报告', '补齐 CONTRIBUTING 等社区文档', '提供英文 README'].sort())
    expect(service.getProject(project.id)?.status).toBe('executing')
  })

  it('answers 400 with the host reason when there is nothing to materialize', async () => {
    const project = doneProject()
    const response = await callAction(postRequest({ kind: 'materialize-additions', projectId: project.id }))
    expect(response.status).toBe(400)
    expect(response.body.ok).toBe(false)
    expect(response.body.error).toMatch(/no pending task-additions request/)
    expect(service.getProject(project.id)?.status).toBe('done')
  })

  it('answers 400 for an unknown project', async () => {
    const response = await callAction(postRequest({ kind: 'materialize-additions', projectId: 'nope' }))
    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/unknown project/)
  })

  it('answers 400 on a malformed request and keeps the file for the human', async () => {
    const project = doneProject()
    writeAdditions(project, '{ not json')
    service.refreshPendingAdditions(project.id)

    const response = await callAction(postRequest({ kind: 'materialize-additions', projectId: project.id }))
    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/malformed/)
    expect(existsSync(taskAdditionsPathFor(service.getProject(project.id)!))).toBe(true)
  })

  it('rejects an envelope without a projectId before touching the service', async () => {
    const project = doneProject()
    const response = await callAction(postRequest({ kind: 'materialize-additions' }))
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ ok: false, error: 'invalid-action' })
    expect(service.getProject(project.id)?.status).toBe('done')
  })

  it('keeps the method fence (GET is not an action)', async () => {
    const response = await callAction(postRequest({ kind: 'materialize-additions', projectId: 'p' }, 'GET'))
    expect(response.status).toBe(405)
    expect(response.body).toEqual({ ok: false, error: 'method-not-allowed' })
  })
})
