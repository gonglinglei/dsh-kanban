/**
 * Sidebar entry injection (self-contained version of the dsh-web-ui
 * sidebar-entry-core pattern, Apache-2.0).
 *
 * dsh's sidebar shell exposes no slot an external plugin can register into
 * (`sidebar.workspaces` / `sidebar.settings` are single-occupant and already
 * taken), so the entry row is injected between the shell's New Session
 * button and the workspace browser. The row is plain DOM (no React tree) so
 * it can never disturb the shell's reconciliation; the view it toggles is a
 * separate React root mounted in the center column (see board-mount.tsx).
 */

/** Stable data attribute identifying the injected entry row. */
export const ENTRY_SELECTOR = '[data-dsh-kanban-entry]'

/** Inline icon (matches the shell's 16px nav-icon look): three kanban columns. */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 6.5v5M10 6.5v3"/></svg>'

/** Entry-row styling (inline; the board's own rules live in board-mount.tsx). */
const ENTRY_STYLE = [
  'display:flex', 'align-items:center', 'gap:8px', 'width:100%',
  'padding:6px 12px', 'border:none', 'background:transparent',
  'color:inherit', 'cursor:pointer', 'font:inherit', 'text-align:left',
].join(';')

function createEntry(onToggle: () => void): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute('data-dsh-kanban-entry', '')
  entry.setAttribute('data-dsh-plugin', 'kanban')
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  entry.style.cssText = ENTRY_STYLE
  entry.setAttribute('aria-label', '看板')
  entry.setAttribute('title', '看板')
  entry.innerHTML = `<span style="display:inline-flex">${ICON}</span><span>看板</span>`
  entry.addEventListener('click', onToggle)
  return entry
}

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Insert the entry after the New Session row (before the browser region). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    // Position relative to the New Session row, never transient logoRow
    // geometry. There is no append-to-end fallback: appending at the end
    // would randomly reorder after a shell re-render.
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    root.insertBefore(entry, base.nextElementSibling)
  }
  return true
}

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @param onToggle - click action (open/toggle the board).
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(onToggle: () => void): () => void {
  // DOM-level idempotency: whatever path mounted an entry row before this
  // call, never mount a second one. A full page reload is the ultimate reset.
  if (typeof document !== 'undefined' && document.querySelector(ENTRY_SELECTOR) !== null) {
    return () => {}
  }
  const entry = createEntry(onToggle)
  let root: HTMLElement | undefined
  let placed = false

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  // Body-level watcher: the "whole rebuild" fallback — when the shell tears
  // down the whole sidebar pane, only this body observation notices the new
  // pane mounting.
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // Self-heal: if a React re-render displaces the row, re-insert it in the
  // same frame (microtask before paint -> no visible flicker).
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placeEntry(root, entry)
  })

  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    entry.remove()
  }
}
