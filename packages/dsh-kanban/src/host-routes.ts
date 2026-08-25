/**
 * Kanban webserver routes: state, action, events (SSE), health. Every
 * mutation is a POST /action envelope answered with the new snapshot; the
 * /events stream pushes the same snapshot after each mutation (plus a
 * 15-second heartbeat). The loopback fence guards every route.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { KanbanHostService } from './host-service.ts'
import { isLoopbackRequest } from './loopback.ts'
import { KANBAN_API_PREFIX, parseActionEnvelope, type KanbanAction } from './protocol.ts'

const ACTION_LIMIT = 64 * 1024
const HEARTBEAT_MS = 15_000

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Loopback-only fence: refuse anything that is not a same-machine browser-origin request. */
function guard(req: IncomingMessage, res: ServerResponse): boolean {
  if (isLoopbackRequest(req)) return true
  json(res, 403, { ok: false, error: 'forbidden' })
  return false
}

function readBody(req: IncomingMessage, limit: number): Promise<{ raw: string; value: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      resolve({ raw, value: raw })
    })
    req.on('error', reject)
  })
}

/** Apply one human action from the browser to the service. */
function applyAction(service: KanbanHostService, action: KanbanAction): unknown {
  switch (action.kind) {
    case 'create-project':
      return service.createProject({
        title: action.title,
        workspaceDir: action.workspaceDir,
        goal: action.goal,
        ...(action.lifecycle === undefined ? {} : { lifecycle: action.lifecycle }),
        ...(action.parentId === undefined ? {} : { parentId: action.parentId }),
      })
    case 'confirm-plan':
      return service.confirmPlan(action.projectId)
    case 'reject-plan':
      return service.rejectPlan(action.projectId, action.feedback)
    case 'transition':
      return service.transition(action.projectId, action.to, action.note)
    case 'delete-project':
      service.deleteProject(action.projectId)
      return undefined
    case 'answer-clarification':
      return service.answerClarification(action.projectId, action.taskId, action.answer)
    case 'confirm-task':
      return service.confirmTask(action.projectId, action.taskId)
  }
}

/**
 * Build the kanban route family.
 * @param service - the kanban host service.
 * @returns the route registrations for ctx.webServer.
 */
export function makeKanbanRoutes(service: KanbanHostService): WebRoute[] {
  const state: WebRoute = {
    kind: 'exact',
    path: `${KANBAN_API_PREFIX}/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      json(res, 200, { ok: true, snapshot: service.snapshot() })
    },
  }

  const action: WebRoute = {
    kind: 'exact',
    path: `${KANBAN_API_PREFIX}/action`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return json(res, 415, { ok: false, error: 'json-required' })
      }
      try {
        const body = await readBody(req, ACTION_LIMIT)
        const envelope = parseActionEnvelope(body.value)
        if (envelope === undefined) return json(res, 400, { ok: false, error: 'invalid-action' })
        applyAction(service, envelope.action)
        json(res, 200, { ok: true, snapshot: service.snapshot() })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message })
      }
    },
  }

  const events: WebRoute = {
    kind: 'exact',
    path: `${KANBAN_API_PREFIX}/events`,
    handler: (req, res): void => {
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      if (!guard(req, res)) return
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const push = (): void => {
        const payload = service.eventPayload()
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      const unsubscribe = service.subscribe(push)
      const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS)
      const close = (): void => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      req.once('close', close)
      res.once('close', close)
      push()
    },
  }

  /**
   * Read one project artifact (plan.md preview). GET-only; the service
   * enforces the workspaceDir prefix whitelist, the 512KB ceiling, and the
   * regular-file check; the loopback fence applies like everywhere else.
   */
  const file: WebRoute = {
    kind: 'exact',
    path: `${KANBAN_API_PREFIX}/file`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '', 'http://localhost')
      const path = url.searchParams.get('path')
      if (path === null || path === '') return json(res, 400, { ok: false, error: 'path-required' })
      try {
        const content = service.readProjectFile(path)
        json(res, 200, { ok: true, path, content })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = message === 'path-outside-workspace' ? 403
          : message === 'file-too-large' ? 413
          : message === 'file-not-found' || message === 'not-a-file' ? 404
          : 400
        json(res, status, { ok: false, error: message })
      }
    },
  }

  const health: WebRoute = {
    kind: 'exact',
    path: `${KANBAN_API_PREFIX}/health`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      json(res, 200, { ok: true, plugin: 'dsh-kanban', version: '0.1.0', time: Date.now() })
    },
  }

  return [state, action, events, file, health]
}
