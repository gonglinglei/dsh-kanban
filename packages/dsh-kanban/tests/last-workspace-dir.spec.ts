// @vitest-environment jsdom
/**
 * The localStorage persistence layer behind「记住上次提交的工作目录」:
 * reads and writes are fully try/catch guarded, blanks never clobber, and
 * the remembered dir always wins over the workspace-list fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultWorkspaceDir, readLastWorkspaceDir, rememberWorkspaceDir } from '../src/client/last-workspace-dir.ts'

const KEY = 'dsh-kanban:last-workspace-dir'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('last-workspace-dir', () => {
  it('falls back to the provided fallback when nothing was remembered', () => {
    expect(readLastWorkspaceDir()).toBe('')
    expect(defaultWorkspaceDir(() => '/first/workspace')).toBe('/first/workspace')
  })

  it('remembers a submitted dir and prefers it over the fallback', () => {
    rememberWorkspaceDir('/path/a')
    expect(readLastWorkspaceDir()).toBe('/path/a')
    expect(defaultWorkspaceDir(() => '/first/workspace')).toBe('/path/a')
  })

  it('a later submission overwrites the previous record', () => {
    rememberWorkspaceDir('/path/a')
    rememberWorkspaceDir('/path/b')
    expect(readLastWorkspaceDir()).toBe('/path/b')
    expect(localStorage.getItem(KEY)).toBe('/path/b')
  })

  it('trims surrounding whitespace before storing', () => {
    rememberWorkspaceDir('  /path/a  ')
    expect(readLastWorkspaceDir()).toBe('/path/a')
  })

  it('blank writes never clobber an existing record', () => {
    rememberWorkspaceDir('/path/a')
    rememberWorkspaceDir('')
    rememberWorkspaceDir('   ')
    expect(readLastWorkspaceDir()).toBe('/path/a')
  })

  it('a throwing localStorage falls back silently and never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })

    expect(() => { rememberWorkspaceDir('/path/a') }).not.toThrow()
    expect(readLastWorkspaceDir()).toBe('')
    expect(defaultWorkspaceDir(() => '/first/workspace')).toBe('/first/workspace')
  })
})
