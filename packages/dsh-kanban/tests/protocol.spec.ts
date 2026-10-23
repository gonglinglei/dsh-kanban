import { describe, expect, it } from 'vitest'
import { CAPABILITY_TASK_ARCHIVE, HOST_CAPABILITIES, parseActionEnvelope } from '../src/protocol.ts'

function envelope(action: unknown): string {
  return JSON.stringify({ requestId: 'req-1', action })
}

describe('parseActionEnvelope create-project', () => {
  it('parses a plain one-shot creation (no lifecycle, no parent)', () => {
    const parsed = parseActionEnvelope(envelope({ kind: 'create-project', title: 't', workspaceDir: '/w', goal: 'g' }))
    expect(parsed?.action).toEqual({ kind: 'create-project', title: 't', workspaceDir: '/w', goal: 'g' })
  })

  it('parses a long-running creation', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', workspaceDir: '/w', goal: 'g', lifecycle: 'long-running',
    }))
    expect(parsed?.action).toEqual({ kind: 'create-project', title: 't', workspaceDir: '/w', goal: 'g', lifecycle: 'long-running' })
  })

  it('parses an affiliated creation', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', workspaceDir: '/w', goal: 'g', parentId: 'p-1',
    }))
    expect(parsed?.action).toEqual({ kind: 'create-project', title: 't', workspaceDir: '/w', goal: 'g', parentId: 'p-1' })
  })

  it('parses an affiliated creation without workspaceDir (host inherits the parent dir)', () => {
    const parsed = parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', goal: 'g', parentId: 'p-1',
    }))
    expect(parsed?.action).toEqual({ kind: 'create-project', title: 't', goal: 'g', parentId: 'p-1' })
    // A blank-string dir counts as omitted too.
    const blank = parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', workspaceDir: '  ', goal: 'g', parentId: 'p-1',
    }))
    expect(blank?.action).toEqual({ kind: 'create-project', title: 't', goal: 'g', parentId: 'p-1' })
  })

  it('rejects a standalone creation without workspaceDir (strictness towards old clients)', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', goal: 'g',
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', workspaceDir: '', goal: 'g',
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', workspaceDir: 42, goal: 'g',
    }))).toBeUndefined()
    // Long-running projects never inherit, so the dir stays required there.
    expect(parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', goal: 'g', lifecycle: 'long-running',
    }))).toBeUndefined()
  })

  it('rejects an unknown lifecycle value', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', workspaceDir: '/w', goal: 'g', lifecycle: 'eternal',
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', workspaceDir: '/w', goal: 'g', lifecycle: 1,
    }))).toBeUndefined()
  })

  it('rejects an empty or non-string parentId', () => {
    expect(parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', workspaceDir: '/w', goal: 'g', parentId: '',
    }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({
      kind: 'create-project', title: 't', workspaceDir: '/w', goal: 'g', parentId: 42,
    }))).toBeUndefined()
  })
})

describe('parseActionEnvelope terminate-task / delete-task', () => {
  it('parses a terminate-task with and without a note', () => {
    const withNote = parseActionEnvelope(envelope({ kind: 'terminate-task', projectId: 'p1', taskId: 't1', note: '不需要了' }))
    expect(withNote?.action).toEqual({ kind: 'terminate-task', projectId: 'p1', taskId: 't1', note: '不需要了' })
    const withoutNote = parseActionEnvelope(envelope({ kind: 'terminate-task', projectId: 'p1', taskId: 't1' }))
    expect(withoutNote?.action).toEqual({ kind: 'terminate-task', projectId: 'p1', taskId: 't1' })
  })

  it('rejects a terminate-task with a non-string note or missing ids', () => {
    expect(parseActionEnvelope(envelope({ kind: 'terminate-task', projectId: 'p1', taskId: 't1', note: 42 }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'terminate-task', projectId: '', taskId: 't1' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'terminate-task', projectId: 'p1' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'terminate-task', projectId: 'p1', taskId: 42 }))).toBeUndefined()
  })

  it('parses a delete-task', () => {
    const parsed = parseActionEnvelope(envelope({ kind: 'delete-task', projectId: 'p1', taskId: 't1' }))
    expect(parsed?.action).toEqual({ kind: 'delete-task', projectId: 'p1', taskId: 't1' })
  })

  it('rejects a delete-task with missing or empty ids', () => {
    expect(parseActionEnvelope(envelope({ kind: 'delete-task', projectId: 'p1' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'delete-task', projectId: '', taskId: 't1' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'delete-task', projectId: 'p1', taskId: '' }))).toBeUndefined()
  })
})

describe('parseActionEnvelope recover-task', () => {
  it('parses a minimal recover-task (the strategy default is the host\'s call)', () => {
    const parsed = parseActionEnvelope(envelope({ kind: 'recover-task', projectId: 'p1', taskId: 't1' }))
    expect(parsed?.action).toEqual({ kind: 'recover-task', projectId: 'p1', taskId: 't1' })
  })

  it('parses both strategies and an optional note', () => {
    for (const strategy of ['reinspect', 'requeue'] as const) {
      const parsed = parseActionEnvelope(envelope({
        kind: 'recover-task', projectId: 'p1', taskId: 't1', strategy, note: '存量卡片处置',
      }))
      expect(parsed?.action).toEqual({ kind: 'recover-task', projectId: 'p1', taskId: 't1', strategy, note: '存量卡片处置' })
    }
  })

  it('rejects an unknown strategy, a non-string note, and missing ids', () => {
    expect(parseActionEnvelope(envelope({ kind: 'recover-task', projectId: 'p1', taskId: 't1', strategy: 'retry' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'recover-task', projectId: 'p1', taskId: 't1', note: 42 }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'recover-task', projectId: 'p1' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'recover-task', projectId: '', taskId: 't1' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'recover-task', projectId: 'p1', taskId: '' }))).toBeUndefined()
  })

  it('an old host (unknown kind) still rejects the action, so the client gates on the capability', () => {
    // The parser's default branch is the downgrade guarantee: a host that does
    // not know recover-task answers 400 invalid-action instead of corrupting
    // the ledger, which is exactly why the button is capability-gated.
    expect(parseActionEnvelope(envelope({ kind: 'recover-task-future', projectId: 'p1', taskId: 't1' }))).toBeUndefined()
  })
})

describe('parseActionEnvelope archive-project / unarchive-project', () => {
  const projectKinds = ['archive-project', 'unarchive-project'] as const

  it('parses the minimal body and omits an absent note', () => {
    for (const kind of projectKinds) {
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1' }))?.action)
        .toEqual({ kind, projectId: 'p1' })
    }
  })

  it('keeps an explicit note (including the empty string) and drops redundant fields', () => {
    for (const kind of projectKinds) {
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', note: '手动归档', extra: 1 }))?.action)
        .toEqual({ kind, projectId: 'p1', note: '手动归档' })
      // '' is a legal string: the archive cases deliberately match the strictness
      // of terminate-task / discard-additions rather than inventing a new rule.
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', note: '' }))?.action)
        .toEqual({ kind, projectId: 'p1', note: '' })
    }
  })

  it('rejects a missing / blank / non-string projectId', () => {
    for (const kind of projectKinds) {
      expect(parseActionEnvelope(envelope({ kind }))).toBeUndefined()
      expect(parseActionEnvelope(envelope({ kind, projectId: '' }))).toBeUndefined()
      expect(parseActionEnvelope(envelope({ kind, projectId: 7 }))).toBeUndefined()
      expect(parseActionEnvelope(envelope({ kind, projectId: { id: 'p1' } }))).toBeUndefined()
    }
  })

  it('rejects a note that is present but not a string', () => {
    for (const kind of projectKinds) {
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', note: 42 }))).toBeUndefined()
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', note: null }))).toBeUndefined()
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', note: {} }))).toBeUndefined()
    }
  })

  it('never echoes snapshot-side fields back into the action', () => {
    const parsed = parseActionEnvelope(envelope({ kind: 'archive-project', projectId: 'p1', archivedAt: 1, history: [] }))
    expect(Object.keys(parsed!.action).sort()).toEqual(['kind', 'projectId'])
  })
})

describe('parseActionEnvelope archive-task / unarchive-task', () => {
  const taskKinds = ['archive-task', 'unarchive-task'] as const

  it('parses the minimal body and keeps an optional note', () => {
    for (const kind of taskKinds) {
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', taskId: 't1' }))?.action)
        .toEqual({ kind, projectId: 'p1', taskId: 't1' })
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', taskId: 't1', note: '累积的已完成叶子' }))?.action)
        .toEqual({ kind, projectId: 'p1', taskId: 't1', note: '累积的已完成叶子' })
    }
  })

  it('rejects a missing / blank / non-string projectId or taskId', () => {
    for (const kind of taskKinds) {
      expect(parseActionEnvelope(envelope({ kind, taskId: 't1' }))).toBeUndefined()
      expect(parseActionEnvelope(envelope({ kind, projectId: '', taskId: 't1' }))).toBeUndefined()
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1' }))).toBeUndefined()
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', taskId: '' }))).toBeUndefined()
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', taskId: 42 }))).toBeUndefined()
    }
  })

  it('rejects a note that is present but not a string', () => {
    for (const kind of taskKinds) {
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', taskId: 't1', note: 42 }))).toBeUndefined()
      expect(parseActionEnvelope(envelope({ kind, projectId: 'p1', taskId: 't1', note: null }))).toBeUndefined()
    }
  })
})

describe('task-archive capability handshake', () => {
  it('appends the token after the frozen pre-existing ordering', () => {
    // The first six tokens are load-bearing for older clients and must never
    // move; new capabilities only ever append.
    expect(HOST_CAPABILITIES.slice(0, 6)).toEqual([
      'long-running-projects',
      'parent-workspace-inheritance',
      'task-terminate-delete',
      'task-recovery',
      'late-task-additions',
      'additions-discard',
    ])
    expect(HOST_CAPABILITIES.at(-1)).toBe(CAPABILITY_TASK_ARCHIVE)
    expect(CAPABILITY_TASK_ARCHIVE).toBe('task-archive')
    expect(HOST_CAPABILITIES).toHaveLength(7)
  })
})

describe('parseActionEnvelope archive misspellings', () => {
  it('keeps the default branch: a near-miss kind is still rejected', () => {
    // Guard against a copy-paste typo in the hand-written switch: an unknown
    // kind must fall through to `undefined` (route answers 400 invalid-action)
    // rather than being silently accepted.
    expect(parseActionEnvelope(envelope({ kind: 'archive-projectt', projectId: 'p1' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'archive', projectId: 'p1' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'archivetask', projectId: 'p1', taskId: 't1' }))).toBeUndefined()
    expect(parseActionEnvelope(envelope({ kind: 'unarchive', projectId: 'p1' }))).toBeUndefined()
  })
})
