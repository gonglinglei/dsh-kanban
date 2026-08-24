/**
 * Project ledger storage: one JSON file under the DSH home
 * (`<home>/kanban/projects.json` by default), atomic write-through.
 *
 * Concurrency: the host service is the single writer — the browser never
 * touches the file, it only talks to /action — so a synchronous write-through
 * on each mutation cannot interleave. Atomicity comes from write-temp-then-
 * rename; a crash mid-write leaves the previous file intact.
 *
 * Corrupt-file policy: a parse failure renames the offender aside and starts
 * fresh (loudly), because a corrupted kanban file must never take down the
 * whole GUI boot.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { KanbanSnapshot, Project, TaskNode } from './protocol.ts'

/** On-disk shape (revision + projects + task leaves; versioned for future migrations). */
export interface PersistedState {
  format: 1
  revision: number
  projects: Project[]
  tasks: TaskNode[]
}

export function emptyState(): PersistedState {
  return { format: 1, revision: 0, projects: [], tasks: [] }
}

/** Load the ledger; a missing file yields an empty state. */
export function loadState(file: string): PersistedState {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    if (parsed.format !== 1 || !Array.isArray(parsed.projects) || typeof parsed.revision !== 'number') {
      throw new Error(`unsupported format: ${JSON.stringify(parsed.format)}`)
    }
    // tasks is additive (pre-decomposition ledgers have none).
    // Normalize: persisted tasks may be missing array fields from older versions.
    const tasks = (parsed.tasks ?? []).map(t => ({
      ...t,
      dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
      history: Array.isArray(t.history) ? t.history : [],
    }))
    return { format: 1, revision: parsed.revision, projects: parsed.projects, tasks }
  } catch (error) {
    const aside = `${file}.corrupt-${Date.now()}`
    renameSync(file, aside)
    console.error(`[dsh-kanban] ledger ${file} is corrupt (${error instanceof Error ? error.message : String(error)}); moved to ${aside} and starting fresh`)
    return emptyState()
  }
}

/** Atomically persist the ledger (temp file + rename in the same directory). */
export function saveState(file: string, state: PersistedState): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}
