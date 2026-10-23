/**
 * Open a session in the shell's main view.
 *
 * The navigation API moved between DSH versions:
 *
 *  - 0.1.x / 0.2.0: the session-controller client owned it as
 *    `sessions.open(sessionId)`.
 *  - 0.2.1+: the controller deliberately dropped navigation ("导航⋯属于 UI
 *    消费方" — navigation belongs to UI consumers) and the shell exposes it as
 *    the `uiWorkspace` client service: `ctx.uiWorkspace.openSession(id)`, the
 *    same call built-in plugins (ui-schedule, ui-subagent, ui-chat, …) make.
 *
 * The Desktop app auto-updated 0.2.0-rc.2 → 0.2.1-rc.2 and the board's session
 * links started throwing `sessions.open is not a function`, so the opener is
 * feature-detected at call time and both shells stay supported.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Cordis service exposing session navigation on 0.2.1+ shells. */
export const UI_WORKSPACE_SERVICE = 'uiWorkspace'

/** The only face used from `ctx.uiWorkspace` (0.2.1+). */
interface SessionNavigator {
  openSession?: (target: string) => void
}

/** The only face used from `sessions` on 0.1.x / 0.2.0 shells. */
interface LegacySessionOpener {
  open?: (sessionId: SessionId) => void
}

/** Snapshot fields this preflight reads, tolerant of both shells' typings. */
interface SessionListState {
  phase?: string
  /** Canonical membership on 0.2.1+ (the built-in UI checks this). */
  ids?: readonly string[]
  /** Membership on older shells; still present on 0.2.1+ for titles. */
  byId?: Record<string, unknown>
}

interface WorkspaceListState {
  phase?: string
  archivedSessionIds?: readonly string[]
}

const NOT_IN_WORKSPACE = '会话不在当前工作区列表中，请在侧边栏切换到对应工作区后重试'
const ARCHIVED = '该会话已归档，请先在侧边栏「显示已归档」中取消归档后再打开'
const NO_NAVIGATION = '当前 GUI 外壳没有提供会话跳转接口（uiWorkspace.openSession / sessions.open 均不可用）'

/**
 * Reveal one session in the shell's main view.
 * @param ctx - client root context (used to resolve the optional uiWorkspace service).
 * @param sessions - session client service of whichever shell is running.
 * @param workspaces - workspace client service (archive flag lives here).
 * @param sessionId - session to open.
 * @throws {Error} actionable message when the session cannot be opened in this shell.
 */
export function openSessionInShell(
  ctx: Context,
  sessions: ISessions,
  workspaces: IWorkspaces,
  sessionId: string,
): void {
  // Only preflight against a ready list: a pending list misses every session
  // and would false-positive. Archived sessions are members of the list but
  // the shell refuses to reveal them, so name the way out instead.
  const workspaceState = workspaces.list.getSnapshot() as unknown as WorkspaceListState
  if (Array.isArray(workspaceState.archivedSessionIds) && workspaceState.archivedSessionIds.includes(sessionId)) {
    throw new Error(ARCHIVED)
  }

  const listState = sessions.list.getSnapshot() as unknown as SessionListState
  if (listState.phase === 'ready') {
    const present = Array.isArray(listState.ids)
      ? listState.ids.includes(sessionId)
      : listState.byId !== undefined && Object.hasOwn(listState.byId, sessionId)
    if (!present) throw new Error(NOT_IN_WORKSPACE)
  }

  const navigator = ctx.get(UI_WORKSPACE_SERVICE) as SessionNavigator | undefined
  if (typeof navigator?.openSession === 'function') {
    navigator.openSession(sessionId)
    return
  }

  const legacy = sessions as unknown as LegacySessionOpener
  if (typeof legacy.open === 'function') {
    legacy.open.call(sessions, sessionId as SessionId)
    return
  }

  throw new Error(NO_NAVIGATION)
}
