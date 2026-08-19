/**
 * Board view mounting (DOM-level, mirroring dsh-task-board's board-mount,
 * Apache-2.0).
 *
 * The `conversation` slot is single-occupant (ui-conversation) and external
 * plugins cannot declare slots, so the board takes over the center column at
 * the DOM level: a container is appended inside the center column as an
 * extra trailing child React never manages, and a stylesheet rule hides the
 * conversation content while the board is active. Toggling is a data
 * attribute on <html> — no React involvement, so the conversation subtree
 * underneath stays mounted and stateful.
 */
import { createRoot, type Root } from 'react-dom/client'
import { Board } from './board.tsx'
import { BOARD_CSS } from './board-style.ts'
import type { BoardStore } from './store.ts'

/** The injected board container (kept in the DOM, hidden when inactive). */
export const BOARD_VIEW_SELECTOR = '[data-dsh-kanban-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'

/** One <style data-plugin> tag with the board's rules (idempotent). */
function injectBoardCss(): void {
  const tagId = 'dsh-kanban/board.css'
  if (document.querySelector('style[data-plugin-css="dsh-kanban/board.css"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-kanban'
  tag.dataset.pluginCss = tagId
  tag.textContent = BOARD_CSS
  document.head.appendChild(tag)
}

/** Find the center column, or undefined while the frame is not mounted. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/**
 * Mount the board React tree into the center column.
 * @param store - the board store (already subscribed by the caller).
 * @param openSession - opens a session in the GUI.
 * @param getDefaultWorkspaceDir - live source of the new-project form default.
 * @returns disposer unmounting the tree and restoring the column.
 */
export function mountBoard(store: BoardStore, openSession: (sessionId: string) => void, getDefaultWorkspaceDir: () => string): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined) return
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshKanbanView = ''
    container.dataset.dshPlugin = 'kanban'
    column.appendChild(container)
    root = createRoot(container)
    root.render(<Board store={store} openSession={openSession} getDefaultWorkspaceDir={getDefaultWorkspaceDir} />)
  }

  // The frame mounts after boot settlement; watch for the column's arrival.
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })
  injectBoardCss()
  ensure()

  return () => {
    waitObserver.disconnect()
    root?.unmount()
    container?.remove()
  }
}
