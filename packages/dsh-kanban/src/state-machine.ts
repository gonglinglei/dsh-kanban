/**
 * The kanban state machine: per-project transitions and the actor policy.
 *
 * MVP machine (flat per project):
 *   backlog → designing → awaiting-review → executing → done
 *   backlog → executing            (system: long-running project creation)
 *   awaiting-review → designing  (human rejection, with feedback)
 *   any → blocked                (stale timer, or human)
 *   any → any                    (human override — the human is always in charge)
 *
 * Agent trust policy: an agent can only report its own phase outcomes
 * (designing → awaiting-review, executing → done); it can never move a
 * project to done on its own without a human-gated review step, and it can
 * never touch states it does not own.
 */
import type { Actor, ProjectStatus } from './protocol.ts'

/** Structured transition failure; the host surfaces the message to the caller. */
export class TransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransitionError'
  }
}

/**
 * Whether an actor may move a project from `from` to `to`.
 * @param from - current status.
 * @param to - requested status.
 * @param actor - who triggers the transition.
 */
export function transitionAllowed(from: ProjectStatus, to: ProjectStatus, actor: Actor): boolean {
  if (from === to) return false
  if (actor === 'human') return true
  if (actor === 'system') {
    // The host drives creation into design, phase outcomes, artifact
    // verification (research leaves: awaiting-review -> done), and staleness.
    if (from === 'backlog' && to === 'designing') return true
    // Long-running projects enter executing directly on creation.
    if (from === 'backlog' && to === 'executing') return true
    if (from === 'designing' && to === 'awaiting-review') return true
    if (from === 'awaiting-review' && to === 'done') return true
    if (from === 'executing' && to === 'done') return true
    if (to === 'blocked') return true
    return false
  }
  // Agent: reports its own phase outcome only.
  if (from === 'designing' && to === 'awaiting-review') return true
  if (from === 'executing' && to === 'done') return true
  return false
}

/** Human-only edges that carry extra semantics (feedback on rejection). */
export function isRejection(from: ProjectStatus, to: ProjectStatus): boolean {
  return from === 'awaiting-review' && to === 'designing'
}

/**
 * Assert an actor may move the project; throws TransitionError otherwise.
 * @param from - current status.
 * @param to - requested status.
 * @param actor - who triggers the transition.
 */
export function assertTransitionAllowed(from: ProjectStatus, to: ProjectStatus, actor: Actor): void {
  if (from === to) throw new TransitionError(`project already in ${from}`)
  if (transitionAllowed(from, to, actor)) return
  throw new TransitionError(`actor ${actor} may not move a project from ${from} to ${to}`)
}
