/**
 * `decideSettlement` is the ONE definition of "this phase is finished", shared
 * by the 5-second poll, the recovery window and the blocked-leaf reconcile
 * probe. It is a pure function of (inspection, role, artifact facts), so it is
 * unit-tested here without a filesystem or a timer.
 *
 * What it pins down: an `observing` inspection is never a settlement (policy A
 * — the leaf keeps watching the same session), a `no-evidence` window is only
 * actionable inside a recovery window, and a research/design turn that ends
 * without its artifact is still a failure rather than a silent success.
 */
import { describe, expect, it } from 'vitest'
import { decideSettlement, recoveryCandidateNote, type SettlementDecision, type SettlementRole } from '../src/spawner.ts'
import { describeTurnEnd, type ExecutionInspection, type TurnEndFacts } from '../src/session-runner.ts'

const SESSION = 'session-7bcb72ad'

function facts(overrides: Partial<TurnEndFacts> = {}): TurnEndFacts {
  return { kind: 'completed', seq: 436, time: Date.UTC(2026, 0, 2, 3, 4, 5), turn: 2, ...overrides }
}

/** The incident's turn 1, decoded. */
const AUTH_TURN: TurnEndFacts = {
  kind: 'error',
  failure: { message: "You've reached your 5-hour usage limit", code: 'AUTH', status: 403 },
  seq: 201,
  turn: 1,
}

function decide(
  outcome: ExecutionInspection,
  options: { role?: SettlementRole; artifactPath?: string; artifactExists?: boolean } = {},
): SettlementDecision {
  return decideSettlement({
    role: options.role ?? 'execute',
    sessionId: SESSION,
    outcome,
    artifactPath: options.artifactPath ?? '/tmp/artifact.md',
    artifactExists: options.artifactExists ?? false,
  })
}

describe('decideSettlement: non-terminal inspections never settle', () => {
  it('a running session is "none" — the only legitimate wait', () => {
    expect(decide({ outcome: 'pending', pending: 'running' })).toEqual({ kind: 'none' })
  })

  it('a silent window is "no-evidence", so only a recovery window may converge on it', () => {
    // Never a silent `none`: the caller must be able to tell "alive" from
    // "nothing will ever happen here" (a zombie executing leaf otherwise).
    expect(decide({ outcome: 'pending', pending: 'no-evidence' })).toEqual({ kind: 'no-evidence' })
  })

  it('an observing turn is surfaced, never settled — policy A (A2/A4)', () => {
    const note = describeTurnEnd(SESSION, AUTH_TURN)
    const decision = decide({ outcome: 'observing', turn: AUTH_TURN, note })
    expect(decision).toEqual({ kind: 'observe', note })
    // The quota error is the incident: it must NOT produce a blocked decision.
    expect(decision.kind).not.toBe('blocked')
    expect(note).toContain('AUTH')
  })
})

describe('decideSettlement: terminal inspections converge', () => {
  it('a vanished session blocks with an unrecoverable diagnostic', () => {
    expect(decide({ outcome: 'cancelled', error: 'execution session no longer exists' })).toEqual({
      kind: 'blocked',
      note: `session ${SESSION} cancelled: execution session no longer exists`,
      cause: 'session-missing',
      diagnostic: expect.objectContaining({
        cause: 'session-missing',
        sessionId: SESSION,
        recoverable: false,
      }),
    })
  })

  it('a stopped turn blocks with the turn/end facts as the diagnostic (A5)', () => {
    const turn = facts({ kind: 'max-tokens', seq: 9, turn: 1 })
    const note = describeTurnEnd(SESSION, turn)
    const decision = decide({ outcome: 'stopped', turn, note })
    expect(decision.kind).toBe('blocked')
    if (decision.kind !== 'blocked') throw new Error('unreachable')
    expect(decision.note).toBe(note)
    expect(decision.cause).toBe('turn-end')
    // Shape rather than identity: `at` is the wall clock at write time.
    expect(decision.diagnostic).toMatchObject({
      cause: 'turn-end',
      message: note,
      reason: 'max-tokens',
      seq: 9,
      turn: 1,
      sessionId: SESSION,
      recoverable: true,
    })
    expect(typeof decision.diagnostic.at).toBe('number')
    expect(decision.note).toContain('output token ceiling')
  })

  it('every execute-shaped role settles straight to done, with no artifact gate', () => {
    for (const role of ['execute', 'project-execute', 'project-design'] as const) {
      expect(decide({ outcome: 'succeeded', turn: facts() }, { role })).toEqual({ kind: 'done' })
    }
    // ...even though the artifact does not exist: an execute leaf's product is
    // the work itself, not a markdown artifact.
    expect(decide({ outcome: 'succeeded', turn: facts() }, { role: 'execute', artifactExists: false })).toEqual({ kind: 'done' })
  })

  it('research/design settles to awaiting-review only when its artifact really exists', () => {
    for (const role of ['research', 'design'] as const) {
      expect(decide({ outcome: 'succeeded', turn: facts() }, { role, artifactPath: '/tmp/a.md', artifactExists: true }))
        .toEqual({ kind: 'awaiting-review', artifactPath: '/tmp/a.md' })
    }
  })

  it('research/design that ends without its artifact is a failure, not a silent success (A5)', () => {
    for (const role of ['research', 'design'] as const) {
      const decision = decide({ outcome: 'succeeded', turn: facts() }, { role, artifactPath: '/tmp/a.md', artifactExists: false })
      expect(decision).toEqual({
        kind: 'blocked',
        note: `${role} ended but /tmp/a.md is missing`,
        cause: 'artifact-missing',
        diagnostic: expect.objectContaining({ cause: 'artifact-missing', sessionId: SESSION, recoverable: true }),
      })
    }
  })
})

describe('recoveryCandidateNote: the audit note a blocked leaf earns', () => {
  it('records the exact turn/end evidence for a finished session (B3)', () => {
    const turn = facts()
    const note = recoveryCandidateNote(SESSION, { outcome: 'succeeded', turn })
    expect(note).toContain('恢复复核')
    expect(note).toContain(SESSION)
    expect(note).toContain('kind=completed')
    expect(note).toContain('turn 2')
    expect(note).toContain('seq 436')
    expect(note).toContain('2026-01-02T03:04:05.000Z')
    expect(note).toContain('等待人工确认收敛')
  })

  it('tolerates missing evidence fields and a non-succeeded inspection', () => {
    // With no turn/seq, the note still states the verdict but claims no evidence
    // it does not have (the "最后一个 turn/end" phrasing is fixed copy).
    expect(recoveryCandidateNote(SESSION, { outcome: 'succeeded', turn: { kind: 'completed' } }))
      .toBe(`恢复复核：会话 ${SESSION} 最后一个 turn/end 为 kind=completed，已具备完成依据，等待人工确认收敛`)
    expect(recoveryCandidateNote(SESSION, { outcome: 'observing', turn: AUTH_TURN, note: 'x' }))
      .toBe(`恢复复核：会话 ${SESSION} 已具备收敛依据（observing），等待人工确认收敛`)
  })
})
