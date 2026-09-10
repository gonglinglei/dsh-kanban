import { describe, expect, it } from 'vitest'
import { parseActionEnvelope } from '../src/protocol.ts'

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
