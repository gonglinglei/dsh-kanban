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
import type { ClientContext, ISessions, IWorkspaces, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { mountBoard } from './board-mount.tsx'
import { HttpKanbanHostTransport } from './host-api.ts'
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
export function apply(ctx: ClientContext): void {
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
  const openSession = (sessionId: string): void => {
    // sessions.open only accepts sessions of the current workspace list; a
    // project whose directory is another workspace gets its sessions there,
    // so preflight for an actionable message instead of a silent throw. Only
    // preflight against a ready list: a pending list misses every session
    // and would false-positive, so defer to sessions.select's own check.
    const snapshot = sessions.list.getSnapshot()
    if (snapshot.phase === 'ready' && snapshot.byId[sessionId as SessionId] === undefined) {
      throw new Error('会话不在当前工作区列表中，请在侧边栏切换到对应工作区后重试')
    }
    sessions.open(sessionId as SessionId)
  }
  // Read the workspace default live (when the modal opens), because the
  // workspace list may still be pending at apply time.
  const getDefaultWorkspaceDir = (): string => workspaces.list.getSnapshot().items[0]?.path ?? ''

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
