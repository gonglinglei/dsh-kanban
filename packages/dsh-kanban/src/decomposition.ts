/**
 * Decomposition protocol: the design agent's tasks.json. The tree may nest
 * arbitrarily (full recursion); the host flattens it into task leaves, where
 * inner nodes only contribute title-path prefixes. A leaf is concrete and
 * typed; only leaves get sessions and statuses.
 *
 * tasks.json shape (written by the design agent next to plan.md):
 *   {
 *     "decomposed": true,
 *     "tasks": [
 *       { "title": "...", "kind": "clarify", "question": "..." },
 *       { "title": "...", "kind": "research", "subtasks": [ ... ] },
 *       { "title": "...", "kind": "execute" }
 *     ]
 *   }
 */
import { readFileSync } from 'node:fs'
import type { TaskKind } from './protocol.ts'

/** One entry of the design agent's decomposition tree. */
export interface DecompositionTask {
  title: string
  kind: TaskKind
  question?: string
  /** Titles (or title paths) of sibling leaves this task depends on; the leaf spawns only when all are done. */
  dependsOn?: string[]
  subtasks?: DecompositionTask[]
}

export interface Decomposition {
  decomposed: boolean
  tasks: DecompositionTask[]
}

/** One flattened leaf: its title chain, its own metadata, and its dependency references. */
export interface TaskLeaf {
  titlePath: string
  kind: TaskKind
  question?: string
  dependsOn: string[]
}

export class DecompositionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecompositionError'
  }
}

const KINDS: readonly TaskKind[] = ['clarify', 'research', 'design', 'execute']

/** Parse and validate a decomposition body. Returns undefined when not decomposed (missing file or empty list). */
export function parseDecomposition(body: string): Decomposition {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new DecompositionError('tasks.json is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new DecompositionError('tasks.json must be an object')
  const d = parsed as Partial<Decomposition>
  if (!Array.isArray(d.tasks)) throw new DecompositionError('tasks.json must contain a "tasks" array')
  for (const task of d.tasks) validateTask(task, '')
  return { decomposed: d.decomposed === true || d.tasks.length > 0, tasks: d.tasks }
}

function validateTask(task: unknown, path: string): asserts task is DecompositionTask {
  if (typeof task !== 'object' || task === null) throw new DecompositionError(`task at ${path} is not an object`)
  const t = task as Partial<DecompositionTask>
  if (typeof t.title !== 'string' || t.title.trim() === '') throw new DecompositionError(`task at ${path} needs a title`)
  if (typeof t.kind !== 'string' || !KINDS.includes(t.kind as TaskKind)) {
    throw new DecompositionError(`task "${t.title}" has an unknown kind: ${String(t.kind)}`)
  }
  if (t.kind === 'clarify' && (typeof t.question !== 'string' || t.question.trim() === '')) {
    throw new DecompositionError(`clarify task "${t.title}" needs a question`)
  }
  if (t.dependsOn !== undefined && (!Array.isArray(t.dependsOn) || t.dependsOn.some(ref => typeof ref !== 'string' || ref.trim() === ''))) {
    throw new DecompositionError(`task "${t.title}" dependsOn must be an array of titles`)
  }
  if (t.subtasks !== undefined && !Array.isArray(t.subtasks)) {
    throw new DecompositionError(`task "${t.title}" subtasks must be an array`)
  }
  for (const subtask of t.subtasks ?? []) validateTask(subtask, `${path}${path === '' ? '' : ' > '}${t.title}`)
}

/**
 * Flatten a decomposition tree into leaves. Inner nodes contribute only the
 * title-path prefix; a leaf carries its own kind and question.
 * @param decomposition - the parsed decomposition.
 * @returns the ordered leaf list.
 */
export function flattenDecomposition(decomposition: Decomposition): TaskLeaf[] {
  const leaves: TaskLeaf[] = []
  const walk = (tasks: DecompositionTask[], prefix: string): void => {
    for (const task of tasks) {
      const path = prefix === '' ? task.title : `${prefix} > ${task.title}`
      if (task.subtasks !== undefined && task.subtasks.length > 0) {
        walk(task.subtasks, path)
      } else {
        leaves.push({
          titlePath: path,
          kind: task.kind,
          dependsOn: task.dependsOn ?? [],
          ...(task.question === undefined ? {} : { question: task.question }),
        })
      }
    }
  }
  walk(decomposition.tasks, '')
  return leaves
}

/** Load and parse the decomposition file; a missing file means "not decomposed". */
export function loadDecomposition(file: string): Decomposition | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const decomposition = parseDecomposition(raw)
  return decomposition.decomposed ? decomposition : undefined
}
