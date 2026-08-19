// @vitest-environment jsdom
/**
 * The open/close contract of the board: entering shows the board and hides
 * the conversation; there must be a way back — the sidebar entry toggles
 * again, AND the board itself offers a visible close action (the reported
 * defect: after entering the board the user could not go back).
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountBoard } from '../src/client/board-mount.tsx'
import { mountSidebarEntry } from '../src/client/sidebar-entry.ts'
import { isBoardOpen, subscribeBoard, toggleBoard } from '../src/client/view-state.ts'
import { BoardStore } from '../src/client/store.ts'
import { FakeTransport } from './fake-transport.ts'

let body: HTMLElement

beforeEach(() => {
  body = document.body
  body.innerHTML = `
    <div id="shell">
      <div class="sidebarCol"><div class="logoRow"><button class="newSession">New Session</button></div></div>
      <div class="centerCol"><div data-pane="conversation"></div></div>
    </div>
  `
  // The board open state is module-level; reset it so each test starts closed.
  if (isBoardOpen()) toggleBoard()
})

afterEach(() => {
  body.innerHTML = ''
})

function boardView(): HTMLElement | null {
  return body.querySelector('[data-dsh-kanban-view]')
}

describe('board open/close contract', () => {
  it('toggle opens and closes: html attribute follows, view visibility flips', async () => {
    const store = new BoardStore(new FakeTransport())
    const unmountBoard = mountBoard(store, () => {}, () => '/tmp')
    await act(async () => { await Promise.resolve() })

    // Enter: the board view is hidden by default, then shown on toggle.
    expect(isBoardOpen()).toBe(false)
    await act(async () => { toggleBoard() })
    expect(isBoardOpen()).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-kanban-active')).toBe(true)

    // Back: toggling again restores the conversation.
    await act(async () => { toggleBoard() })
    expect(isBoardOpen()).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-kanban-active')).toBe(false)
    unmountBoard()
  })

  it('the sidebar entry is the toggle: clicking it opens and closes the board', async () => {
    const store = new BoardStore(new FakeTransport())
    const unmountEntry = mountSidebarEntry(toggleBoard)
    const unmountBoard = mountBoard(store, () => {}, () => '/tmp')
    await act(async () => { await Promise.resolve() })

    const entry = body.querySelector<HTMLButtonElement>('[data-dsh-kanban-entry]')
    expect(entry).toBeDefined()
    await act(async () => { entry!.click() })
    expect(isBoardOpen()).toBe(true)
    await act(async () => { entry!.click() })
    expect(isBoardOpen()).toBe(false)
    unmountEntry()
    unmountBoard()
  })

  it('the board itself offers a visible close action (regression: no way back)', async () => {
    const store = new BoardStore(new FakeTransport())
    const unmountBoard = mountBoard(store, () => {}, () => '/tmp')
    await act(async () => { await Promise.resolve() })
    await act(async () => { toggleBoard() })

    const view = boardView()
    expect(view).not.toBeNull()
    const closeButton = [...view!.querySelectorAll('button')].find(button => button.textContent === '返回')
    expect(closeButton, 'board must render a visible back action').toBeDefined()

    await act(async () => { closeButton!.click() })
    expect(isBoardOpen()).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-kanban-active')).toBe(false)
    unmountBoard()
  })

  it('notifies subscribers on toggle (active-state highlight source)', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeBoard(() => { seen.push(isBoardOpen()) })
    toggleBoard()
    toggleBoard()
    expect(seen).toEqual([true, false])
    unsubscribe()
  })
})
