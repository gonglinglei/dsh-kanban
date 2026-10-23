/**
 * Host loader entry for the dsh-kanban plugin.
 *
 * The Host owns the project ledger, the state machine, persistence, SSE
 * broadcast, the stale timer, and the session spawner (design → human
 * confirm → execute relay). The browser is a same-origin asynchronous view
 * over that service.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config, resolveProjectsFile, type Config as ConfigShape } from './config.ts'
import { KanbanHostService } from './host-service.ts'
import { makeKanbanRoutes } from './host-routes.ts'
import { mountOnce } from './mount-once.ts'
import { createKanbanApi } from './session-runner.ts'
import { KanbanSpawner } from './spawner.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const KANBAN_GUIDANCE = '本机已安装 dsh-kanban 插件（DSH Web GUI 的项目看板）：侧边栏「看板」入口。能力：以「设计 → 人工确认 → 执行」的接力方式管理项目（MVP 开发中：新建项目会自动拉起设计 agent 产出方案，人工确认后拉起执行 agent 落地）。用户提到「项目看板 / 看板」时即指本插件，请据此协作。'

export const inject = ['webServer', 'systemPrompt', 'sessionController']

export const apply = mountOnce('dsh-kanban', applyImpl)

function applyImpl(ctx: Context, rawConfig?: ConfigShape): void {
  const config = Config(rawConfig ?? {})
  const service = new KanbanHostService(resolveProjectsFile(config.projectsFile))
  service.start()
  service.setMaxStaleMinutes(config.maxStaleMinutes ?? 0)
  // The archive phase is armed exactly like the stale timer: outside
  // `ctx.effect`, torn down by `service.dispose()`. The position matters —
  // the startup catch-up runs synchronously here, i.e. BEFORE the spawner's
  // restart replay and before its first poll, so an already-archived record
  // never enters either.
  service.setArchivePolicy({
    afterDays: config.archiveAfterDays ?? 7,
    sweepMinutes: config.archiveSweepMinutes ?? 60,
    doneTaskLeaves: config.archiveDoneTaskLeaves ?? true,
  })
  const spawner = new KanbanSpawner(service, createKanbanApi(ctx.sessionController))
  // Terminate/delete entry point: the service cancels sessions through the
  // spawner (which also forgets the launch timestamp so no poll settles it).
  service.setSessionCanceller(sessionId => { void spawner.cancelSession(sessionId) })

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      disposers.push(spawner.start())
      for (const route of makeKanbanRoutes(service)) disposers.push(ctx.webServer.register(route))
      if (config.announceToAgent ?? true) {
        disposers.push(ctx.systemPrompt.section({
          name: 'plugin:dsh-kanban',
          order: SECTION_ORDER,
          text: KANBAN_GUIDANCE,
        }))
      }
    } catch (error) {
      for (const dispose of disposers) dispose()
      service.dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
      service.dispose()
    }
  }, 'dsh-kanban: host service, spawner, routes, and announcement')
}
