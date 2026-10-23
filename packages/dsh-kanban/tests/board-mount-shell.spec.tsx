// @vitest-environment jsdom
/**
 * Shell-shape compatibility of the DOM mounts.
 *
 * Regression (Desktop 0.2.0): the board view used to be
 * `position: absolute; inset: 0`. The Desktop shell's center column is a
 * STATIC grid item — hashed class `_6Qf49G_centerCol`, no `data-pane` — so the
 * view resolved against the positioned `_6Qf49G_frame` and covered the whole
 * frame, sidebar track included. Two independent guarantees are pinned here:
 *
 *   1. the view is mounted INSIDE the center column in both shell shapes
 *      (hashed Desktop classes and the legacy `data-pane="conversation"`), and
 *   2. the view's own rule keeps it in NORMAL FLOW, so it can never anchor to
 *      an ancestor that spans the sidebar.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountBoard } from '../src/client/board-mount.tsx'
import { mountSidebarEntry } from '../src/client/sidebar-entry.ts'
import { BOARD_CSS } from '../src/client/board-style.ts'
import { isBoardOpen, toggleBoard } from '../src/client/view-state.ts'
import { BoardStore } from '../src/client/store.ts'
import { FakeTransport } from './fake-transport.ts'

/** The Desktop shell's frame: positioned, so it is a tempting containing block. */
const DESKTOP_FRAME = `
  <div class="_6Qf49G_frame">
    <div class="_6Qf49G_sidebarCol">
      <div class="_3WPZCG_root">
        <div class="_3WPZCG_logoRow"><button class="_3WPZCG_newSession">New</button></div>
        <div class="_3WPZCG_browser"></div>
      </div>
    </div>
    <div class="_6Qf49G_centerCol"><div class="_1a2b3c_conversation">chat</div></div>
  </div>
`

beforeEach(() => {
  document.body.innerHTML = DESKTOP_FRAME
  if (isBoardOpen()) toggleBoard()
})

afterEach(() => {
  document.body.innerHTML = ''
  // The injected stylesheet lives in <head> and outlives the board, so each
  // test starts from a clean slate.
  for (const tag of document.querySelectorAll('style[data-plugin-css="dsh-kanban/board.css"]')) tag.remove()
})

describe('Desktop shell (hashed classes, no data-pane)', () => {
  it('mounts the board view inside the center column, never the frame or sidebar', async () => {
    const store = new BoardStore(new FakeTransport())
    const unmount = mountBoard(store, () => {}, () => '/tmp')
    await act(async () => { await Promise.resolve() })

    const view = document.querySelector('[data-dsh-kanban-view]')
    expect(view).not.toBeNull()
    expect(view!.parentElement?.classList.contains('_6Qf49G_centerCol')).toBe(true)
    expect(view!.parentElement?.classList.contains('_6Qf49G_frame')).toBe(false)
    expect(document.querySelector('._6Qf49G_sidebarCol [data-dsh-kanban-view]')).toBeNull()
    unmount()
  })

  it('injects the sidebar entry after the logo row, before the browser region', async () => {
    const unmount = mountSidebarEntry(() => {})
    await act(async () => { await Promise.resolve() })

    const entry = document.querySelector('[data-dsh-kanban-entry]')
    const logoRow = document.querySelector('._3WPZCG_logoRow')
    expect(entry).not.toBeNull()
    expect(entry!.previousElementSibling).toBe(logoRow)
    unmount()
  })
})

describe('board view stylesheet contract', () => {
  it('keeps the view in normal flow instead of absolute anchoring', () => {
    const start = BOARD_CSS.indexOf('[data-dsh-kanban-view] {')
    expect(start, 'view rule present').toBeGreaterThanOrEqual(0)
    const rule = BOARD_CSS.slice(start, BOARD_CSS.indexOf('}', start))

    // Absolute + inset: 0 was the defect: against the static Desktop column the
    // containing block became the positioned frame, i.e. everywhere.
    expect(rule).not.toContain('position: absolute')
    expect(rule).not.toContain('inset: 0')
    // In-flow fill: flex column (today's shell) and definite-height columns.
    expect(rule).toContain('flex: 1 1 0')
    expect(rule).toContain('height: 100%')
  })

  it('still hides the conversation column siblings while the board is open', () => {
    expect(BOARD_CSS).toContain("html[data-dsh-kanban-active] [class*='centerCol'] > :not([data-dsh-kanban-view])")
    expect(BOARD_CSS).toContain('display: none !important')
  })

  it('replaces a stale injected stylesheet instead of leaving it applied', async () => {
    // A style tag outlives the fiber that injected it, so a hot-reloaded bundle
    // must overwrite the text rather than skip an already-present tag.
    const stale = document.createElement('style')
    stale.dataset.plugin = 'dsh-kanban'
    stale.dataset.pluginCss = 'dsh-kanban/board.css'
    stale.textContent = '[data-dsh-kanban-view]{position:absolute;inset:0}'
    document.head.appendChild(stale)

    const store = new BoardStore(new FakeTransport())
    const unmount = mountBoard(store, () => {}, () => '/tmp')
    await act(async () => { await Promise.resolve() })

    const tags = document.querySelectorAll('style[data-plugin-css="dsh-kanban/board.css"]')
    expect(tags.length).toBe(1)
    // Exact replacement, not a merge: the tag now carries this build's rules.
    expect(tags[0].textContent).toBe(BOARD_CSS)

    unmount()
  })
})
