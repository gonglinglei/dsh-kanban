/**
 * Protocol surface of the late task-additions fix: the `materialize-additions`
 * action envelope (the human gate) and the capability token that gates the
 * board entry.
 *
 * These live in their own file (rather than being appended to protocol.spec.ts)
 * because the fix and the in-flight sibling project 18db4cdd both edit
 * `src/protocol.ts`; a separate suite keeps the two test edits independent.
 */
import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_ADDITIONS_DISCARD,
  CAPABILITY_LATE_TASK_ADDITIONS,
  CAPABILITY_TASK_RECOVERY,
  HOST_CAPABILITIES,
  PENDING_ITEMS_MAX,
  PENDING_PROBLEMS_MAX,
  parseActionEnvelope,
} from '../src/protocol.ts'

function envelope(action: unknown): string {
  return JSON.stringify({ requestId: 'req-1', action })
}

describe('parseActionEnvelope materialize-additions', () => {
  it('parses the minimal envelope and drops redundant fields', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'materialize-additions', projectId: 'p1', unused: 'dropped',
    }))
    expect(parsed).toEqual({ requestId: 'req-1', action: { kind: 'materialize-additions', projectId: 'p1' } })
  })

  it('keeps an explicit note (empty string included, it is the caller’s own wording)', () => {
    const withNote = parseActionEnvelope(envelope({ kind: 'materialize-additions', projectId: 'p1', note: '按澄清结论补齐' }))
    expect(withNote?.action).toEqual({ kind: 'materialize-additions', projectId: 'p1', note: '按澄清结论补齐' })
    const empty = parseActionEnvelope(envelope({ kind: 'materialize-additions', projectId: 'p1', note: '' }))
    expect(empty?.action).toEqual({ kind: 'materialize-additions', projectId: 'p1', note: '' })
  })

  it('rejects a missing, empty, or non-string projectId', () => {
    expect(parseActionEnvelope(envelope({ kind: 'materialize-additions' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'materialize-additions', projectId: '' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'materialize-additions', projectId: 42 }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'materialize-additions', projectId: null }))).toBeUndefined()
  })

  it('rejects a non-string note', () => {
    expect(parseActionEnvelope(envelope({ kind: 'materialize-additions', projectId: 'p1', note: 7 }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'materialize-additions', projectId: 'p1', note: null }))).toBeUndefined()
  })

  it('rejects a snapshot-shaped object smuggled into the action slot', () => {
    // The badge is a snapshot field; a client must never be able to POST it back.
    expect(parseActionEnvelope(envelope({
      kind: 'materialize-additions',
      projectId: 'p1',
      pendingAdditions: [{ projectId: 'p1', count: 4 }],
    }))?.action).toEqual({ kind: 'materialize-additions', projectId: 'p1' })
    expect(parseActionEnvelope(envelope({ kind: 'materialize-additions', pendingAdditions: [] }))).toBeUndefined()
  })

  it('rejects malformed bodies and unknown kinds (strictness shared with every action)', () => {
    expect(parseActionEnvelope('{ not json')).toBeUndefined()
    expect(parseActionEnvelope(JSON.stringify({ requestId: 'r' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'materialize-addition', projectId: 'p1' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'materialize-additions', projectId: 'p1', note: {} }))).toBeUndefined()
  })
})

describe('late task-additions capability handshake', () => {
  it('declares late-task-additions and appends it LAST so existing orderings never shift', () => {
    expect(HOST_CAPABILITIES).toContain(CAPABILITY_LATE_TASK_ADDITIONS)
    // The sibling fix's token keeps its position: the fix must not renumber it.
    expect(HOST_CAPABILITIES.indexOf(CAPABILITY_TASK_RECOVERY)).toBe(3)
    expect(HOST_CAPABILITIES.indexOf(CAPABILITY_LATE_TASK_ADDITIONS)).toBe(4)
    // …and the discard token layered on top is appended AFTER it, so neither
    // the badge capability nor the sibling's token ever moves.
    expect(HOST_CAPABILITIES.indexOf(CAPABILITY_ADDITIONS_DISCARD)).toBe(5)
    // task-archive came later still: it is last, and the six tokens above kept
    // their exact positions.
    expect(HOST_CAPABILITIES.at(-1)).toBe('task-archive')
  })

  it('bounds the per-snapshot preview (hot SSE data) at a small constant', () => {
    expect(PENDING_ITEMS_MAX).toBeGreaterThan(0)
    expect(PENDING_ITEMS_MAX).toBeLessThanOrEqual(50)
    expect(PENDING_PROBLEMS_MAX).toBeGreaterThan(0)
    expect(PENDING_PROBLEMS_MAX).toBeLessThanOrEqual(20)
  })
})
