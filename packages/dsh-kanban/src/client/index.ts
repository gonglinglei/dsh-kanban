/**
 * dsh-kanban client plugin: mounts the sidebar entry and the board view.
 *
 * External plugins cannot declare slots (the slot surface is compiled into
 * the shipped web bundle), so both surfaces are injected into the shell DOM
 * with self-healing observers — the pattern dsh-web-ui's task-board proves.
 * The board is a same-origin asynchronous view over the host ledger: the
 * store talks to /state, /action and /events and the React tree renders it.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { mountBoard } from './board-mount.tsx'
import { HttpKanbanHostTransport } from './host-api.ts'
import { defaultWorkspaceDir } from './last-workspace-dir.ts'
import { openSessionInShell } from './open-session.ts'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { BoardStore } from './store.ts'
import { toggleBoard } from './view-state.ts'

/** A duplicated client injection (module factory executed twice in one page lifetime) must not double-mount. */
let applied = false

export const inject = ['sessions', 'workspaces']

/**
 * Mount the kanban surfaces.
 * @param ctx - client root context (sessions, workspaces).
 */
export function apply(ctx: Context): void {
  if (applied) return
  applied = true
  // Release the claim when this fiber unloads (the loader supports plugin
  // unloads / hot-reloads), so a rebuilt bundle can claim again in the same
  // page instead of being silently dropped.
  ctx.effect(() => () => {
    applied = false
  }, 'dsh-kanban: apply claim')

  // Host and browser SDK declarations share the Cordis Context name. Read
  // the browser faces explicitly so Host-side declaration merging cannot
  // narrow these two client services during a combined package build.
  const sessions = ctx.get('sessions') as unknown as ISessions
  const workspaces = ctx.get('workspaces') as unknown as IWorkspaces

  const store = new BoardStore(new HttpKanbanHostTransport())
  // Session navigation is feature-detected inside: 0.2.1+ shells expose it as
  // ctx.uiWorkspace.openSession, older shells as sessions.open (the Desktop app
  // auto-update 0.2.0 → 0.2.1 removed the latter).
  const openSession = (sessionId: string): void => {
    openSessionInShell(ctx, sessions, workspaces, sessionId)
  }
  // Read the workspace default live (when the modal opens), because the
  // workspace list may still be pending at apply time. The last submitted
  // dir (remembered in localStorage) wins over the workspace-list fallback.
  const getDefaultWorkspaceDir = (): string =>
    defaultWorkspaceDir(() => workspaces.list.getSnapshot().items[0]?.path ?? '')

  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(toggleBoard))
    disposers.push(mountBoard(store, openSession, getDefaultWorkspaceDir))
    disposers.push(store.start())
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0)) dispose()
    }, 'dsh-kanban: DOM surfaces and store')
  } catch (error) {
    // DOM failures degrade the board, never the GUI.
    for (const dispose of disposers) dispose()
    console.error('[dsh-kanban] mount failed:', error)
  }
}
