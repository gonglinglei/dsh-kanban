/**
 * Protocol surface of the additions-discard exit: the `discard-additions`
 * action envelope and the capability token that gates the board entry.
 *
 * Kept in its own file for the same reason as protocol-late-additions.spec.ts:
 * `src/protocol.ts` is a shared battlefront, so each fix owns its own suite.
 */
import { describe, expect, it } from 'vitest'
import { CAPABILITY_ADDITIONS_DISCARD, HOST_CAPABILITIES, parseActionEnvelope } from '../src/protocol.ts'

function envelope(action: unknown): string {
  return JSON.stringify({ requestId: 'req-1', action })
}

function action(body: string): unknown {
  return parseActionEnvelope(body)?.action
}

describe('discard-additions action envelope', () => {
  it('parses the minimal body and omits an absent note', () => {
    expect(action(envelope({ kind: 'discard-additions', projectId: 'p1' })))
      .toEqual({ kind: 'discard-additions', projectId: 'p1' })
  })

  it('keeps an explicit note and drops redundant fields', () => {
    expect(action(envelope({ kind: 'discard-additions', projectId: 'p1', note: '不要了', extra: 1, count: 4 })))
      .toEqual({ kind: 'discard-additions', projectId: 'p1', note: '不要了' })
  })

  it('rejects a missing / blank / non-string projectId', () => {
    expect(action(envelope({ kind: 'discard-additions' }))).toBeUndefined()
    expect(action(envelope({ kind: 'discard-additions', projectId: '' }))).toBeUndefined()
    expect(action(envelope({ kind: 'discard-additions', projectId: 7 }))).toBeUndefined()
    expect(action(envelope({ kind: 'discard-additions', projectId: { id: 'p1' } }))).toBeUndefined()
  })

  it('rejects a note that is present but not a string', () => {
    expect(action(envelope({ kind: 'discard-additions', projectId: 'p1', note: 3 }))).toBeUndefined()
    expect(action(envelope({ kind: 'discard-additions', projectId: 'p1', note: null }))).toBeUndefined()
  })

  it('rejects near-miss kinds and malformed envelopes', () => {
    expect(action(envelope({ kind: 'discard-addition', projectId: 'p1' }))).toBeUndefined()
    expect(action(envelope({ kind: 'discard', projectId: 'p1' }))).toBeUndefined()
    expect(parseActionEnvelope('{ not json')).toBeUndefined()
    expect(parseActionEnvelope(JSON.stringify({ requestId: '', action: { kind: 'discard-additions', projectId: 'p1' } }))).toBeUndefined()
  })

  it('never echoes snapshot-side fields back into the action', () => {
    const parsed = parseActionEnvelope(envelope({ kind: 'discard-additions', projectId: 'p1', pendingAdditions: [{ file: 'x' }] }))
    expect(Object.keys(parsed!.action).sort()).toEqual(['kind', 'projectId'])
  })
})

describe('additions-discard capability handshake', () => {
  it('declares the token and appends it after every pre-existing capability', () => {
    expect(HOST_CAPABILITIES).toContain(CAPABILITY_ADDITIONS_DISCARD)
    // The token's own position is frozen; later capabilities only ever append
    // AFTER it (task-archive came later, so this is no longer the last entry).
    expect(HOST_CAPABILITIES.indexOf(CAPABILITY_ADDITIONS_DISCARD)).toBe(5)
    expect(HOST_CAPABILITIES.slice(0, 6).at(-1)).toBe(CAPABILITY_ADDITIONS_DISCARD)
  })
})
