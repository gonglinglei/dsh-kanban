/**
 * Regression suite for the client transport's response handling (readJson).
 *
 * Root cause being pinned down: when the running host predates the /kanban/file
 * route, the webserver answers 404 with an EMPTY body. The old implementation
 * called response.json() before checking response.ok, surfacing the raw parse
 * error "Unexpected end of JSON input" and hiding the real HTTP status. Every
 * failure path must now produce a readable message carrying the status code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpKanbanHostTransport } from '../src/client/host-api.ts'
import { KANBAN_API_PREFIX } from '../src/protocol.ts'

function stubFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HttpKanbanHostTransport.file()', () => {
  it('reports the HTTP status (not a raw parse error) on a 404 with an empty body', async () => {
    stubFetch(new Response(null, { status: 404 }))
    const transport = new HttpKanbanHostTransport()

    const failure = await transport.file('/tmp/plan.md').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('404')
    expect((failure as Error).message).not.toContain('Unexpected end of JSON input')
  })

  it('reports a non-JSON body with the HTTP status (e.g. an HTML fallback page)', async () => {
    stubFetch(new Response('<!doctype html><title>404</title>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    }))
    const transport = new HttpKanbanHostTransport()

    const failure = await transport.file('/tmp/plan.md').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('non-JSON')
    expect((failure as Error).message).toContain('404')
  })

  it('surfaces the host-provided error message when the body is JSON', async () => {
    stubFetch(new Response(JSON.stringify({ ok: false, error: 'path-outside-workspace' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }))
    const transport = new HttpKanbanHostTransport()

    await expect(transport.file('/etc/passwd')).rejects.toThrow('path-outside-workspace')
  })

  it('rejects an empty 200 body with a readable message instead of undefined', async () => {
    stubFetch(new Response(null, { status: 200 }))
    const transport = new HttpKanbanHostTransport()

    const failure = await transport.file('/tmp/plan.md').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('empty response')
    expect((failure as Error).message).toContain('200')
  })

  it('returns file content unchanged on the normal 200 JSON path', async () => {
    stubFetch(new Response(JSON.stringify({ ok: true, path: '/tmp/plan.md', content: '# 方案\n\n正文' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const transport = new HttpKanbanHostTransport()

    await expect(transport.file('/tmp/plan.md')).resolves.toBe('# 方案\n\n正文')
    expect(fetch).toHaveBeenCalledWith(
      `${KANBAN_API_PREFIX}/file?path=${encodeURIComponent('/tmp/plan.md')}`,
      expect.objectContaining({ cache: 'no-store' }),
    )
  })
})
