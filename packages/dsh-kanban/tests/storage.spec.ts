import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '../src/protocol.ts'
import { emptyState, loadState, saveState } from '../src/storage.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-storage-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function sampleProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: 'demo',
    workspaceDir: '/tmp/work',
    goal: 'build it',
    status: 'designing',
    version: 2,
    createdAt: 1,
    updatedAt: 2,
    lastActivityAt: 2,
    history: [{ at: 1, actor: 'system', from: 'backlog', to: 'designing' }],
    ...overrides,
  }
}

describe('storage', () => {
  it('loads an empty state when the file is missing', () => {
    expect(loadState(join(dir, 'nope.json'))).toEqual(emptyState())
  })

  it('round-trips a state through save and load', () => {
    const file = join(dir, 'projects.json')
    const state = { format: 1 as const, revision: 5, projects: [sampleProject()], tasks: [] }
    saveState(file, state)
    expect(loadState(file)).toEqual(state)
  })

  it('loads a legacy ledger without lifecycle/parentId unchanged', () => {
    // Pre-lifecycle ledgers have neither field; absence must mean one-shot.
    const file = join(dir, 'projects.json')
    const legacy = sampleProject()
    expect('lifecycle' in legacy).toBe(false)
    expect('parentId' in legacy).toBe(false)
    writeFileSync(file, JSON.stringify({ format: 1, revision: 1, projects: [legacy] }), 'utf8')
    const state = loadState(file)
    expect(state.projects[0]).toEqual(legacy)
    expect(state.projects[0]?.lifecycle).toBeUndefined()
    expect(state.projects[0]?.parentId).toBeUndefined()
  })

  it('leaves no temp file behind after a save', () => {
    const file = join(dir, 'projects.json')
    saveState(file, { format: 1, revision: 1, projects: [] })
    expect(readFileSync(file, 'utf8')).toContain('"revision": 1')
    // No .tmp residue: the atomic rename consumed it.
    expect(loadState(join(dir, 'projects.json.tmp'))).toEqual(emptyState())
  })

  it('passes the additive failure/recovery fields through untouched (no migration)', () => {
    // lastFailure on a project and lastFailure + recovery on a leaf are
    // additive optional fields: the on-disk format stays 1 and a round trip
    // must preserve them verbatim (an old ledger simply lacks them).
    const file = join(dir, 'projects.json')
    const failure = {
      at: 1789026487696,
      cause: 'turn-end' as const,
      message: 'session s failed: AUTH (HTTP 403) quota',
      reason: 'error',
      code: 'AUTH',
      status: 403,
      turn: 1,
      seq: 201,
      sessionId: 's',
      recoverable: true,
    }
    const project = sampleProject({ lastFailure: failure })
    const task = {
      id: 't1',
      projectId: 'p1',
      titlePath: '实现功能',
      kind: 'execute' as const,
      status: 'executing' as const,
      dependencies: [],
      lastFailure: failure,
      recovery: { at: 5, strategy: 'reinspect' as const, sessionId: 's' },
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
      history: [],
    }
    saveState(file, { format: 1, revision: 3, projects: [project], tasks: [task] })
    const loaded = loadState(file)
    expect(loaded.projects[0]?.lastFailure).toEqual(failure)
    expect(loaded.tasks[0]?.lastFailure).toEqual(failure)
    expect(loaded.tasks[0]?.recovery).toEqual({ at: 5, strategy: 'reinspect', sessionId: 's' })
    expect(loaded.format).toBe(1)
  })

  it('moves a corrupt file aside and starts fresh', () => {
    const file = join(dir, 'projects.json')
    writeFileSync(file, '{not json', 'utf8')
    const state = loadState(file)
    expect(state).toEqual(emptyState())
    // The offender was renamed aside, never deleted: exactly one .corrupt-* file holds the garbage.
    const asides = readdirSync(dir).filter(name => name.startsWith('projects.json.corrupt-'))
    expect(asides).toHaveLength(1)
    expect(readFileSync(join(dir, asides[0]!), 'utf8')).toBe('{not json')
  })

  it('rejects an unsupported format loudly and recovers fresh', () => {
    const file = join(dir, 'projects.json')
    writeFileSync(file, JSON.stringify({ format: 99, revision: 0, projects: [] }), 'utf8')
    expect(loadState(file)).toEqual(emptyState())
  })
})
