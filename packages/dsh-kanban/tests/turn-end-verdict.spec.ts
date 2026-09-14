/**
 * The turn/end vocabulary, unit-tested at its three seams:
 * `decodeTurnEnd` (facts) → `verdictFor` (disposition) → `describeTurnEnd`
 * (the one human-readable note).
 *
 * Why this file exists: the production incident turned entirely on this table.
 * The pre-recovery build collapsed the 6-value `reason.kind` enum into a
 * boolean — `kind === 'error'` meant "failed", EVERYTHING ELSE meant
 * "succeeded" — so it both (a) pinned a finished leaf in `blocked` after a
 * recoverable 403 quota error and (b) marked `max-tokens` / `aborted` /
 * `blocked` turns as done. The disposition is now a total, typed map, and this
 * suite is the guard that keeps every arm of it honest.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeTurnEnd,
  describeTurnEnd,
  failureDiagnostic,
  SESSION_CANNOT_PROGRESS_CODES,
  turnEndDiagnostic,
  verdictFor,
  type TurnEndFacts,
  type TurnEndKind,
} from '../src/session-runner.ts'

/** Deterministic evidence time: 2026-01-02T03:04:05.000Z. */
const T = Date.UTC(2026, 0, 2, 3, 4, 5)
const ISO = '2026-01-02T03:04:05.000Z'

/** The verbatim turn/end payload of the incident's turn 1 (session-7bcb72ad, seq 201). */
const QUOTA_ERROR_DATA = {
  turn: 1,
  reason: {
    kind: 'error',
    error: {
      type: 'permission_error',
      message: "You've reached your 5-hour usage limit",
      code: 'AUTH',
      status: 403,
    },
  },
}

/** Decode a raw `data` payload with the incident's seq/time evidence. */
function decode(data: unknown, seq = 201, time = T): TurnEndFacts {
  return decodeTurnEnd(data, seq, time)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('decodeTurnEnd: facts only, nothing folded away', () => {
  it('reads the incident payload verbatim (message / code / status / turn / seq / time)', () => {
    expect(decode(QUOTA_ERROR_DATA)).toEqual({
      kind: 'error',
      failure: { message: "You've reached your 5-hour usage limit", code: 'AUTH', status: 403 },
      seq: 201,
      time: T,
      turn: 1,
    })
  })

  it('keeps a payload with only a message usable, and tolerates a partial failure object', () => {
    expect(decode({ reason: { kind: 'error', message: 'flat message' } })).toMatchObject({
      kind: 'error',
      failure: { message: 'flat message' },
    })
    expect(decode({ reason: { kind: 'error' } })).toMatchObject({
      kind: 'error',
      failure: { message: 'unrecognized failure' },
    })
  })

  it('treats an event WITHOUT any reason as the historical success, but flags it as legacy', () => {
    // Several round-trip fixtures predate the vocabulary; their meaning must
    // not change, but they have to stay countable.
    expect(decode(undefined)).toEqual({ kind: 'completed', legacyReason: true, seq: 201, time: T })
    expect(decode(null)).toEqual({ kind: 'completed', legacyReason: true, seq: 201, time: T })
    expect(decode('boom')).toEqual({ kind: 'completed', legacyReason: true, seq: 201, time: T })
    expect(decode({})).toEqual({ kind: 'completed', legacyReason: true, seq: 201, time: T })
    expect(decode({ turn: 3, reason: null })).toEqual({ kind: 'completed', legacyReason: true, seq: 201, time: T, turn: 3 })
    // The empty data of the old fixtures still carries the evidence bracket.
    expect(describeTurnEnd('s', decode({}))).toBe(`session s completed: legacy turn/end without a reason [seq 201, ${ISO}]`)
  })

  it('is fail-safe on a PRESENT but unrecognized reason: unknown, never success', () => {
    // This is the asymmetry that matters: a missing reason is the legacy
    // success, a reason we do not understand is not.
    const cases: unknown[] = [
      { reason: 'completed' },
      { reason: { kind: 7 } },
      { reason: { kind: 'invented-by-a-newer-dsh' } },
    ]
    for (const data of cases) {
      const facts = decode(data)
      expect(facts.kind).toBe('unknown')
      expect(facts.legacyReason).toBeUndefined()
    }
    expect(decode({ reason: { kind: 'invented-by-a-newer-dsh' } }).rawKind).toBe('invented-by-a-newer-dsh')
    expect(decode({ reason: { kind: 7 } }).rawKind).toBeUndefined()
  })

  it('reads the abort cause out of the nested reason, defaulting to legacy', () => {
    for (const cause of ['user', 'parent', 'hook', 'disposed'] as const) {
      expect(decode({ reason: { kind: 'aborted', reason: { kind: cause } } })).toMatchObject({
        kind: 'aborted',
        cancelCause: cause,
      })
    }
    // A crash-orphaned or older log may carry no nested cause at all.
    expect(decode({ reason: { kind: 'aborted' } })).toMatchObject({ kind: 'aborted', cancelCause: 'legacy' })
    expect(decode({ reason: { kind: 'aborted', reason: { kind: 7 } } })).toMatchObject({ kind: 'aborted', cancelCause: 'legacy' })
  })

  it('passes the four parameterless kinds straight through', () => {
    for (const kind of ['completed', 'blocked', 'max-tokens', 'interrupted'] as const) {
      expect(decode({ turn: 2, reason: { kind } })).toEqual({ kind, seq: 201, time: T, turn: 2 })
    }
  })

  it('omits seq/time/turn rather than inventing them', () => {
    expect(decodeTurnEnd({ reason: { kind: 'completed' } })).toEqual({ kind: 'completed' })
  })
})

describe('verdictFor: the disposition table (policy A)', () => {
  const verdict = (kind: TurnEndKind, extra: Partial<TurnEndFacts> = {}) =>
    verdictFor('s', { kind, seq: 1, time: T, ...extra }).verdict

  it('only `completed` is an explicit success terminal', () => {
    expect(verdict('completed')).toBe('succeeded')
  })

  it('a RECOVERABLE error keeps observing — the incident must never be blocked again (A1/A5)', () => {
    // The exact production payload: a 5-hour quota exhaustion behind HTTP 403.
    expect(verdictFor('sess', decode(QUOTA_ERROR_DATA)).verdict).toBe('observing')
    // Not just AUTH: an error with no code, or with the other quota-ish codes,
    // is still "the session can be continued".
    expect(verdict('error', { failure: { message: 'boom' } })).toBe('observing')
    for (const code of ['QUOTA', 'RATE_LIMIT', 'AUTH', 'TIMEOUT', 'INTERNAL']) {
      expect(verdict('error', { failure: { message: 'boom', code } })).toBe('observing')
    }
    // The regression guard itself: adding AUTH here would re-break the incident.
    expect([...SESSION_CANNOT_PROGRESS_CODES]).not.toContain('AUTH')
    expect([...SESSION_CANNOT_PROGRESS_CODES]).not.toContain('QUOTA')
  })

  it('only the two "this session cannot progress" codes stop an error turn', () => {
    for (const code of SESSION_CANNOT_PROGRESS_CODES) {
      expect(verdict('error', { failure: { message: 'boom', code } })).toBe('stopped')
    }
  })

  it('an aborted turn stops the leaf — except a host shutdown, which resumes on restart', () => {
    for (const cause of ['user', 'parent', 'hook', 'legacy']) {
      expect(verdict('aborted', { cancelCause: cause })).toBe('stopped')
    }
    expect(verdict('aborted', { cancelCause: 'disposed' })).toBe('observing')
  })

  it('truncated / blocked turns stop the leaf; a crash-orphaned turn keeps observing', () => {
    expect(verdict('max-tokens')).toBe('stopped')
    expect(verdict('blocked')).toBe('stopped')
    expect(verdict('interrupted')).toBe('observing')
  })

  it('an unrecognized reason is fail-safe: stopped, never a silent success', () => {
    expect(verdict('unknown', { rawKind: 'invented' })).toBe('stopped')
  })

  it('every known reason kind has an explicit verdict (no arm falls through to success)', () => {
    const kinds: TurnEndKind[] = ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted']
    const seen = kinds.map(kind => verdictFn(kind))
    // Only `completed` may ever be `succeeded`; the table is not "default allow".
    expect(seen.filter(v => v === 'succeeded')).toHaveLength(1)

    function verdictFn(kind: TurnEndKind) {
      return verdictFor('s', { kind, seq: 1 }).verdict
    }
  })
})

describe('describeTurnEnd: the one readable note', () => {
  it('an error note carries the real code, HTTP status and message (A6)', () => {
    const note = describeTurnEnd('session-7bcb72ad', decode(QUOTA_ERROR_DATA))
    expect(note).toContain('session-7bcb72ad')
    expect(note).toContain('failed:')
    expect(note).toContain('AUTH')
    expect(note).toContain('HTTP 403')
    expect(note).toContain("You've reached your 5-hour usage limit")
    expect(note).toContain(`[turn 1, seq 201, ${ISO}]`)
    // The whole point: the old fixed string is gone, and the leaf's fate is stated.
    expect(note).not.toContain('agent turn ended with an error')
    expect(note).toContain('keeping the leaf under observation')
    expect(note).toBe(`session session-7bcb72ad failed: AUTH (HTTP 403) You've reached your 5-hour usage limit [turn 1, seq 201, ${ISO}] (keeping the leaf under observation for a later turn in this session)`)
  })

  it('an unrecoverable error says so, in the same shape', () => {
    const note = describeTurnEnd('s', decode({ turn: 4, reason: { kind: 'error', error: { message: 'context too long', code: 'CONTEXT_WINDOW_EXCEEDED' } } }))
    expect(note).toContain('CONTEXT_WINDOW_EXCEEDED')
    expect(note).toContain('this session cannot progress; needs a human')
  })

  it('an error with no code still names its message', () => {
    expect(describeTurnEnd('s', decode({ reason: { kind: 'error', error: { message: 'boom' } } })))
      .toBe(`session s failed: boom [seq 201, ${ISO}] (keeping the leaf under observation for a later turn in this session)`)
  })

  it('names the abort cause, and the shutdown case explains the resume', () => {
    expect(describeTurnEnd('s', decode({ reason: { kind: 'aborted', reason: { kind: 'user' } } })))
      .toBe(`session s aborted: cancelled by user [seq 201, ${ISO}]`)
    expect(describeTurnEnd('s', decode({ reason: { kind: 'aborted', reason: { kind: 'disposed' } } })))
      .toBe(`session s aborted: cancelled by disposed [seq 201, ${ISO}] (host shutdown; the restart recovery resumes it)`)
  })

  it('describes the three remaining known kinds and the unknown one', () => {
    expect(describeTurnEnd('s', decode({ reason: { kind: 'completed' } }))).toBe(`session s completed [seq 201, ${ISO}]`)
    expect(describeTurnEnd('s', decode({ reason: { kind: 'blocked' } }))).toBe(`session s ended: blocked [seq 201, ${ISO}]`)
    expect(describeTurnEnd('s', decode({ reason: { kind: 'max-tokens' } }))).toBe(`session s ended: hit the output token ceiling [seq 201, ${ISO}]`)
    expect(describeTurnEnd('s', decode({ reason: { kind: 'interrupted' } }))).toBe(`session s interrupted: crash-orphaned turn closed after the fact [seq 201, ${ISO}] (keeping the leaf under observation)`)
    expect(describeTurnEnd('s', decode({ reason: { kind: 'invented' } }))).toBe(`session s unknown: unrecognized turn/end reason invented [seq 201, ${ISO}]`)
    expect(describeTurnEnd('s', decode({ reason: { kind: 7 } }))).toContain('unrecognized turn/end reason <missing>')
  })

  it('omits the evidence bracket when nothing is known, and scrubs hostile text', () => {
    expect(describeTurnEnd('s', decodeTurnEnd({ reason: { kind: 'completed' } }))).toBe('session s completed')
    // The ledger is a whole-file write-through: newlines/control characters are
    // flattened and the note is bounded (the ellipsis counts against the bound).
    const hostile = describeTurnEnd('s', decode({
      reason: { kind: 'error', error: { message: `line one\nline two\t\u0007 ${'x'.repeat(500)}` } },
    }))
    expect(hostile).not.toMatch(/[\n\r\t\u0007]/)
    expect(hostile.length).toBeLessThanOrEqual(400)
    expect(hostile).toContain('line one line two')
    // The nested message cap (200) already keeps this whole note under 400.
    expect(hostile).not.toContain('x'.repeat(201))

    // A note that does exceed 400 is truncated WITH the ellipsis inside the bound.
    const long = describeTurnEnd('s'.repeat(400), decode({ reason: { kind: 'completed' } }))
    expect(long.length).toBe(400)
    expect(long.endsWith('…')).toBe(true)
    expect(long.startsWith('session sss')).toBe(true)
  })
})

describe('diagnostics: the machine-readable counterpart of the note', () => {
  it('turnEndDiagnostic carries the turn/end facts and is advisory-recoverable', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_789_026_487_696))
    const diagnostic = turnEndDiagnostic('session-7bcb72ad', decode(QUOTA_ERROR_DATA))
    expect(diagnostic).toEqual({
      at: 1_789_026_487_696,
      cause: 'turn-end',
      message: describeTurnEnd('session-7bcb72ad', decode(QUOTA_ERROR_DATA)),
      reason: 'error',
      code: 'AUTH',
      status: 403,
      turn: 1,
      seq: 201,
      sessionId: 'session-7bcb72ad',
      recoverable: true,
    })
  })

  it('turnEndDiagnostic omits unknown fields and forwards a non-default cause', () => {
    const diagnostic = turnEndDiagnostic('s', decode({ reason: { kind: 'aborted', reason: { kind: 'user' } } }), 'recovery')
    expect(diagnostic).toMatchObject({ cause: 'recovery', reason: 'aborted', cancelCause: 'user', sessionId: 's' })
    expect(diagnostic.code).toBeUndefined()
    expect(diagnostic.status).toBeUndefined()
    expect(diagnostic.turn).toBeUndefined()
  })

  it('failureDiagnostic scrubs, and only a vanished session is marked unrecoverable', () => {
    const generic = failureDiagnostic('launch', `boom\n${'y'.repeat(500)}`)
    expect(generic.recoverable).toBe(true)
    expect(generic.sessionId).toBeUndefined()
    expect(generic.message).not.toMatch(/[\n\r]/)
    // The ellipsis counts against the 400-char bound, not on top of it.
    expect(generic.message.length).toBe(400)
    expect(generic.message.endsWith('…')).toBe(true)
    // A message at exactly the bound is left alone.
    expect(failureDiagnostic('launch', 'z'.repeat(400)).message).toBe('z'.repeat(400))

    expect(failureDiagnostic('session-missing', 'gone', 's')).toMatchObject({
      cause: 'session-missing',
      message: 'gone',
      sessionId: 's',
      recoverable: false,
    })
  })
})
