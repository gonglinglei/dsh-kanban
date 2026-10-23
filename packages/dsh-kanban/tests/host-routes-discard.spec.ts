/**
 * POST /kanban/action with the `discard-additions` envelope — the HTTP surface
 * of the board's「废弃该请求」button, plus the malformed-body receipt of
 * `materialize-additions`.
 *
 * The pair matters: a request that can no longer be materialized must have a
 * reachable exit through the SAME channel every other board action uses.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-routes-discard-'))
  service = new KanbanHostService(join(dir, 'projects.json'))
  service.start()
})

afterEach(() => {
  service.dispose()
  rmSync(dir, { recursive: true, force: true })
})

interface FakeResponse {
  status: number
  body: { ok: boolean; error?: string; snapshot?: { pendingAdditions?: unknown[] } }
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
  service.reportTaskExecuteDone(service.projectTasks(project.id)[0]!.id, 'system')
  expect(service.getProject(project.id)?.status).toBe('done')
  return service.getProject(project.id)!
}

function writeAdditions(project: Project, body: unknown): string {
  const path = taskAdditionsPathFor(project)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  const at = new Date(Date.now() - 5_000)
  utimesSync(path, at, at)
  return path
}

describe('POST /kanban/action discard-additions', () => {
  it('parks the request and answers with the snapshot that no longer shows it', async () => {
    const project = doneProject()
    writeAdditions(project, { decomposed: true, tasks: [{ title: '补充测试', kind: 'execute' }] })
    service.refreshPendingAdditions(project.id)
    expect(service.snapshot().pendingAdditions).toHaveLength(1)

    const response = await callAction(postRequest({ kind: 'discard-additions', projectId: project.id, note: '不要了' }))
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.snapshot?.pendingAdditions).toEqual([])
    expect(readdirSync(projectDir(project)).filter(name => name.endsWith('.discarded.json'))).toHaveLength(1)
    // Discarding never materializes and never re-opens.
    expect(service.projectTasks(project.id)).toHaveLength(1)
    expect(service.getProject(project.id)?.status).toBe('done')
  })

  it('is the reachable exit for a malformed body (the materialize button cannot help there)', async () => {
    const project = doneProject()
    const path = writeAdditions(project, '{ not json')
    service.refreshPendingAdditions(project.id)

    const materialize = await callAction(postRequest({ kind: 'materialize-additions', projectId: project.id }))
    expect(materialize.status).toBe(400)
    expect(materialize.body.error).toMatch(/废弃该请求/)
    expect(existsSync(path)).toBe(true)

    const discard = await callAction(postRequest({ kind: 'discard-additions', projectId: project.id }))
    expect(discard.status).toBe(200)
    expect(discard.body.snapshot?.pendingAdditions).toEqual([])
    expect(readdirSync(projectDir(project)).filter(name => name.endsWith('.discarded.json'))).toHaveLength(1)
  })

  it('answers 400 with the host reason when there is nothing to discard', async () => {
    const project = doneProject()
    const response = await callAction(postRequest({ kind: 'discard-additions', projectId: project.id }))
    expect(response.status).toBe(400)
    expect(response.body.ok).toBe(false)
    expect(response.body.error).toMatch(/no pending task-additions request to discard/)
  })

  it('answers 400 for an unknown project', async () => {
    const response = await callAction(postRequest({ kind: 'discard-additions', projectId: 'nope' }))
    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/unknown project/)
  })

  it('rejects an envelope without a projectId before touching the service', async () => {
    const project = doneProject()
    const response = await callAction(postRequest({ kind: 'discard-additions' }))
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ ok: false, error: 'invalid-action' })
    expect(service.getProject(project.id)?.status).toBe('done')
  })
})
