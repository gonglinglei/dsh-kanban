/**
 * Remembers the workspace dir of the last successful project submission in
 * browser localStorage, so the new-project modal can pre-fill it next time.
 *
 * Pure client-side state: the host and the protocol stay untouched. Every
 * localStorage access is try/catch guarded — private mode or a throwing
 * Storage implementation must never break project creation; the callers
 * silently fall back to the existing workspace-list default.
 */

/** localStorage key for the last successfully submitted workspace dir. */
const KEY = 'dsh-kanban:last-workspace-dir'

/**
 * Read the remembered dir. Returns '' when nothing was stored, the stored
 * value is blank, or localStorage is unavailable/throws.
 */
export function readLastWorkspaceDir(): string {
  try {
    return (globalThis.localStorage.getItem(KEY) ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * Remember a dir after the host accepted it. Blank values (after trim) are
 * ignored so they never clobber a useful record; storage errors are silent.
 */
export function rememberWorkspaceDir(dir: string): void {
  const trimmed = dir.trim()
  if (trimmed === '') return
  try {
    globalThis.localStorage.setItem(KEY, trimmed)
  } catch {
    // localStorage unavailable (private mode, quota, ...) — ignore.
  }
}

/**
 * The modal's default: the remembered dir when present, otherwise the
 * fallback (lazily read, e.g. the workspace list's first item which may not
 * be ready yet).
 */
export function defaultWorkspaceDir(fallback: () => string): string {
  return readLastWorkspaceDir() || fallback()
}
