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
import type { Actor, ArchiveMarker, KanbanSnapshot, Project, TaskNode } from './protocol.ts'

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

/** The actors an archive marker may name; anything else is dropped (not the marker). */
const ARCHIVE_ACTORS: readonly Actor[] = ['human', 'agent', 'system']

/**
 * Normalize an archive marker IN PLACE and report whether anything was dropped.
 *
 * Fail open, never closed: a malformed marker is discarded (the record becomes
 * visible again and, at worst, is archived once more later) while a corrupt
 * ledger would take the whole board down. Only structural checks — a negative,
 * future or inconsistent timestamp is tolerated on purpose.
 *
 * The three fields live and die together when `archivedAt` itself is unusable;
 * `archivedBy` / `archiveNote` are advisory and are dropped alone.
 */
function normalizeArchiveMarker<T extends ArchiveMarker>(node: T): boolean {
  if (node.archivedAt === undefined) {
    const orphan = node.archivedBy !== undefined || node.archiveNote !== undefined
    delete node.archivedBy
    delete node.archiveNote
    return orphan
  }
  if (typeof node.archivedAt !== 'number' || !Number.isFinite(node.archivedAt)) {
    delete node.archivedAt
    delete node.archivedBy
    delete node.archiveNote
    return true
  }
  let dropped = false
  if (node.archivedBy !== undefined && !ARCHIVE_ACTORS.includes(node.archivedBy)) {
    delete node.archivedBy
    dropped = true
  }
  if (node.archiveNote !== undefined && typeof node.archiveNote !== 'string') {
    delete node.archiveNote
    dropped = true
  }
  return dropped
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
    // Both maps keep spreading the unknown keys (`{...t}`, projects passthrough):
    // that is what makes a downgrade lossless — an older host's loader preserves
    // the archive fields it does not understand instead of wiping them.
    let droppedMarkers = 0
    const projects = (parsed.projects as Project[]).map(project => {
      if (normalizeArchiveMarker(project)) droppedMarkers += 1
      return project
    })
    const tasks = (parsed.tasks ?? []).map(t => {
      const task: TaskNode = {
        ...t,
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        history: Array.isArray(t.history) ? t.history : [],
      }
      if (normalizeArchiveMarker(task)) droppedMarkers += 1
      return task
    })
    if (droppedMarkers > 0) {
      // One line per load, never per record: this is a self-healing read.
      console.warn(`[dsh-kanban] dropped ${droppedMarkers} invalid archive marker(s) from ${file}`)
    }
    // Normalization stays in memory: boot never rewrites the ledger (a dropped
    // marker disappears with the next real mutation, and `revision` only moves
    // on a mutation).
    return { format: 1, revision: parsed.revision, projects, tasks }
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
