/**
 * The /kanban/file route is the one route that reads user disk files, so its
 * safety contract gets a dedicated suite: workspaceDir prefix whitelist
 * (including `..` escape attempts), regular-file + 512KB ceiling, GET-only,
 * and the loopback fence — plus the happy path that serves plan.md content.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKanbanRoutes } from '../src/host-routes.ts'
import { KanbanHostService, PROJECT_FILE_LIMIT } from '../src/host-service.ts'

let dir: string
let service: KanbanHostService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-routes-'))
  service = new KanbanHostService(join(dir, 'projects.json'))
  service.start()
})

afterEach(() => {
  service.dispose()
  rmSync(dir, { recursive: true, force: true })
})

interface FakeResponse {
  status: number
  body: { ok: boolean; content?: string; error?: string }
}

function fakeRequest(overrides: {
  method?: string
  url?: string
  remoteAddress?: string
} = {}): IncomingMessage {
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/kanban/file',
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

/** Invoke the /kanban/file handler directly (exact-path match is the webserver's job). */
async function callFileRoute(req: IncomingMessage): Promise<FakeResponse> {
  const route = makeKanbanRoutes(service).find(candidate => candidate.path === '/kanban/file')
  expect(route, 'the /kanban/file route must be registered').toBeDefined()
  const { res, result } = fakeResponse()
  await route!.handler(req, res)
  return result()
}

describe('GET /kanban/file', () => {
  it('serves a text file inside a project workspaceDir', async () => {
    writeFileSync(join(dir, 'plan.md'), '# 方案\n\n正文')
    service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })

    const response = await callFileRoute(fakeRequest({ url: `/kanban/file?path=${encodeURIComponent(join(dir, 'plan.md'))}` }))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, path: join(dir, 'plan.md'), content: '# 方案\n\n正文' })
  })

  it('rejects a path outside every project workspaceDir', async () => {
    service.createProject({ title: 't', workspaceDir: join(dir, 'ws'), goal: 'g' })
    const outside = join(dir, 'secret.txt')
    writeFileSync(outside, 'top secret')

    const response = await callFileRoute(fakeRequest({ url: `/kanban/file?path=${encodeURIComponent(outside)}` }))
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ ok: false, error: 'path-outside-workspace' })
  })

  it('rejects a .. escape that resolves outside the workspaceDir', async () => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    service.createProject({ title: 't', workspaceDir: workspace, goal: 'g' })
    writeFileSync(join(dir, 'secret.txt'), 'top secret')
    const escape = join(workspace, '..', 'secret.txt')

    const response = await callFileRoute(fakeRequest({ url: `/kanban/file?path=${encodeURIComponent(escape)}` }))
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ ok: false, error: 'path-outside-workspace' })
  })

  it('rejects a sibling directory whose name shares a prefix (prefix check must include the separator)', async () => {
    const workspace = join(dir, 'ws')
    const sibling = join(dir, 'ws-evil')
    mkdirSync(workspace)
    mkdirSync(sibling)
    service.createProject({ title: 't', workspaceDir: workspace, goal: 'g' })
    writeFileSync(join(sibling, 'secret.txt'), 'top secret')

    const response = await callFileRoute(fakeRequest({ url: `/kanban/file?path=${encodeURIComponent(join(sibling, 'secret.txt'))}` }))
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ ok: false, error: 'path-outside-workspace' })
  })

  it('rejects a directory inside the workspaceDir', async () => {
    const workspace = join(dir, 'ws')
    mkdirSync(join(workspace, 'sub'), { recursive: true })
    service.createProject({ title: 't', workspaceDir: workspace, goal: 'g' })

    const response = await callFileRoute(fakeRequest({ url: `/kanban/file?path=${encodeURIComponent(join(workspace, 'sub'))}` }))
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ ok: false, error: 'not-a-file' })
  })

  it('rejects a missing file inside the workspaceDir', async () => {
    service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })

    const response = await callFileRoute(fakeRequest({ url: `/kanban/file?path=${encodeURIComponent(join(dir, 'nope.md'))}` }))
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ ok: false, error: 'file-not-found' })
  })

  it('rejects a file larger than the 512KB ceiling', async () => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'huge.md'), 'x'.repeat(PROJECT_FILE_LIMIT + 1))
    service.createProject({ title: 't', workspaceDir: workspace, goal: 'g' })

    const response = await callFileRoute(fakeRequest({ url: `/kanban/file?path=${encodeURIComponent(join(workspace, 'huge.md'))}` }))
    expect(response.status).toBe(413)
    expect(response.body).toEqual({ ok: false, error: 'file-too-large' })
  })

  it('rejects non-GET methods before touching the filesystem', async () => {
    service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })

    const response = await callFileRoute(fakeRequest({ method: 'POST', url: `/kanban/file?path=${encodeURIComponent(join(dir, 'plan.md'))}` }))
    expect(response.status).toBe(405)
    expect(response.body).toEqual({ ok: false, error: 'method-not-allowed' })
  })

  it('rejects a missing path parameter', async () => {
    const response = await callFileRoute(fakeRequest({ url: '/kanban/file' }))
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ ok: false, error: 'path-required' })
  })

  it('keeps the loopback fence: a non-loopback socket is forbidden', async () => {
    service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })

    const response = await callFileRoute(fakeRequest({
      url: `/kanban/file?path=${encodeURIComponent(join(dir, 'plan.md'))}`,
      remoteAddress: '10.0.0.8',
    }))
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ ok: false, error: 'forbidden' })
  })
})
