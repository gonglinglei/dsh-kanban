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
