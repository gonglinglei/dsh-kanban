/**
 * Session navigation across shells.
 *
 * Regression (Desktop 0.2.1): the session-controller client removed
 * `sessions.open` — navigation became a UI-consumer job — so clicking a session
 * link on the board threw `sessions.open is not a function`. 0.2.1+ shells
 * expose `ctx.uiWorkspace.openSession(id)`; older shells (0.1.x / 0.2.0) only
 * have `sessions.open`. Both must work, and a shell with neither must fail with
 * an actionable message rather than a TypeError.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { describe, expect, it, vi } from 'vitest'
import { openSessionInShell } from '../src/client/open-session.ts'

const SESSION = 'session-1'

/** Canvas of the current shell's list projection: `ids` is the 0.2.1+ membership face. */
function sessionsWith(ids: string[], extra: Record<string, unknown> = {}): ISessions {
  return {
    list: {
      getSnapshot: () => ({
        phase: 'ready',
        ids,
        byId: Object.fromEntries(ids.map(id => [id, { id }])),
      }),
    },
    ...extra,
  } as unknown as ISessions
}

/** Legacy shells may not project `ids`; only `byId` is guaranteed there. */
function legacySessionsWith(ids: string[], extra: Record<string, unknown> = {}): ISessions {
  return {
    list: {
      getSnapshot: () => ({
        phase: 'ready',
        byId: Object.fromEntries(ids.map(id => [id, { id }])),
      }),
    },
    ...extra,
  } as unknown as ISessions
}

function workspacesWith(archivedSessionIds: string[] = []): IWorkspaces {
  return { list: { getSnapshot: () => ({ phase: 'ready', items: [], archivedSessionIds }) } } as unknown as IWorkspaces
}

function contextWith(services: Record<string, unknown> = {}): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

describe('openSessionInShell', () => {
  it('uses ctx.uiWorkspace.openSession on 0.2.1+ shells', () => {
    const openSession = vi.fn()
    openSessionInShell(contextWith({ uiWorkspace: { openSession } }), sessionsWith([SESSION]), workspacesWith(), SESSION)
    expect(openSession).toHaveBeenCalledWith(SESSION)
  })

  it('prefers uiWorkspace over the legacy sessions.open when both exist', () => {
    const openSession = vi.fn()
    const legacyOpen = vi.fn()
    const sessions = sessionsWith([SESSION], { open: legacyOpen })
    openSessionInShell(contextWith({ uiWorkspace: { openSession } }), sessions, workspacesWith(), SESSION)
    expect(openSession).toHaveBeenCalledWith(SESSION)
    expect(legacyOpen).not.toHaveBeenCalled()
  })

  it('falls back to sessions.open on 0.1.x / 0.2.0 shells', () => {
    const legacyOpen = vi.fn()
    const sessions = sessionsWith([SESSION], { open: legacyOpen })
    openSessionInShell(contextWith(), sessions, workspacesWith(), SESSION)
    expect(legacyOpen).toHaveBeenCalledWith(SESSION)
  })

  it('reads legacy byId membership when the list projects no ids', () => {
    const legacyOpen = vi.fn()
    const sessions = legacySessionsWith([SESSION], { open: legacyOpen })
    openSessionInShell(contextWith(), sessions, workspacesWith(), SESSION)
    expect(legacyOpen).toHaveBeenCalledWith(SESSION)
  })

  it('fails with an actionable message when the shell exposes neither interface', () => {
    expect(() => openSessionInShell(contextWith(), sessionsWith([SESSION]), workspacesWith(), SESSION)).toThrow(
      /没有提供会话跳转接口/,
    )
  })

  it('names the archived state instead of opening an archived session', () => {
    const openSession = vi.fn()
    expect(() =>
      openSessionInShell(contextWith({ uiWorkspace: { openSession } }), sessionsWith([SESSION]), workspacesWith([SESSION]), SESSION),
    ).toThrow(/已归档/)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('rejects a session outside the current workspace list', () => {
    const openSession = vi.fn()
    expect(() =>
      openSessionInShell(contextWith({ uiWorkspace: { openSession } }), sessionsWith(['other']), workspacesWith(), SESSION),
    ).toThrow(/不在当前工作区列表/)
    expect(openSession).not.toHaveBeenCalled()
  })
})
