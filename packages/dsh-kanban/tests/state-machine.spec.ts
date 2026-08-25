import { describe, expect, it } from 'vitest'
import { assertTransitionAllowed, transitionAllowed, TransitionError } from '../src/state-machine.ts'

describe('transitionAllowed', () => {
  it('lets the human move any state to any other state', () => {
    for (const from of ['backlog', 'designing', 'awaiting-review', 'executing', 'done', 'blocked'] as const) {
      for (const to of ['backlog', 'designing', 'awaiting-review', 'executing', 'done', 'blocked'] as const) {
        if (from === to) continue
        expect(transitionAllowed(from, to, 'human'), `${from} → ${to}`).toBe(true)
      }
    }
  })

  it('keeps same-state transitions illegal for everyone', () => {
    expect(transitionAllowed('designing', 'designing', 'human')).toBe(false)
    expect(transitionAllowed('done', 'done', 'system')).toBe(false)
    expect(transitionAllowed('blocked', 'blocked', 'agent')).toBe(false)
  })

  it('lets the agent report only its own phase outcomes', () => {
    expect(transitionAllowed('designing', 'awaiting-review', 'agent')).toBe(true)
    expect(transitionAllowed('executing', 'done', 'agent')).toBe(true)
    expect(transitionAllowed('designing', 'done', 'agent')).toBe(false)
    expect(transitionAllowed('executing', 'awaiting-review', 'agent')).toBe(false)
    expect(transitionAllowed('awaiting-review', 'executing', 'agent')).toBe(false)
    expect(transitionAllowed('backlog', 'designing', 'agent')).toBe(false)
  })

  it('lets the system drive creation, phase outcomes, and staleness', () => {
    expect(transitionAllowed('backlog', 'designing', 'system')).toBe(true)
    expect(transitionAllowed('backlog', 'executing', 'system')).toBe(true) // long-running creation
    expect(transitionAllowed('designing', 'awaiting-review', 'system')).toBe(true)
    expect(transitionAllowed('executing', 'done', 'system')).toBe(true)
    expect(transitionAllowed('designing', 'blocked', 'system')).toBe(true)
    expect(transitionAllowed('executing', 'blocked', 'system')).toBe(true)
    expect(transitionAllowed('awaiting-review', 'blocked', 'system')).toBe(true)
    expect(transitionAllowed('backlog', 'done', 'system')).toBe(false)
    expect(transitionAllowed('awaiting-review', 'executing', 'system')).toBe(false)
  })

  it('keeps the long-running creation edge system-only (agents never take it)', () => {
    expect(transitionAllowed('backlog', 'executing', 'agent')).toBe(false)
    expect(transitionAllowed('backlog', 'executing', 'human')).toBe(true)
    expect(() => assertTransitionAllowed('backlog', 'executing', 'agent'))
      .toThrowError(/agent may not move a project from backlog to executing/)
  })

  it('throws TransitionError with the actor and edge in the message', () => {
    expect(() => assertTransitionAllowed('designing', 'done', 'agent'))
      .toThrowError(/agent may not move a project from designing to done/)
    expect(() => assertTransitionAllowed('done', 'done', 'human'))
      .toThrowError(/already in done/)
  })

  it('exposes TransitionError as a named error class', () => {
    const error = new TransitionError('boom')
    expect(error.name).toBe('TransitionError')
    expect(error).toBeInstanceOf(Error)
  })
})
