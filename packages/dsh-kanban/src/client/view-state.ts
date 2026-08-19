/**
 * Board visibility state shared by the sidebar entry (toggle) and the board
 * view. The board's visibility is driven by a data attribute on <html> and a
 * stylesheet rule, so the conversation subtree underneath stays mounted and
 * stateful while hidden.
 */
let open = false
const listeners = new Set<() => void>()

/** Whether the board is currently open. */
export function isBoardOpen(): boolean {
  return open
}

/** Toggle the board view; notifies subscribers and sibling panels. */
export function toggleBoard(): void {
  open = !open
  document.documentElement.toggleAttribute('data-dsh-kanban-active', open)
  // Cross-plugin activation notice (dsh-web-ui family protocol): sibling
  // panels (task board, ssh) clear their own activation when this fires.
  window.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: { panel: 'kanban' } }))
  for (const listener of listeners) listener()
}

/** Close the board explicitly (the board's own back action; the sidebar entry keeps toggling). */
export function closeBoard(): void {
  if (open) toggleBoard()
}

/**
 * Subscribe to board open/close changes.
 * @param listener - called on every toggle.
 * @returns unsubscribe.
 */
export function subscribeBoard(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
