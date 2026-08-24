import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DecompositionError, flattenDecomposition, loadDecomposition, parseDecomposition } from '../src/decomposition.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-decomp-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NESTED = {
  decomposed: true,
  tasks: [
    { title: '明确需求', kind: 'clarify', question: '目标用户是谁？' },
    {
      title: '后端',
      kind: 'design',
      subtasks: [
        { title: '数据库设计', kind: 'design' },
        { title: 'API 实现', kind: 'execute' },
      ],
    },
    { title: '竞品调研', kind: 'research' },
  ],
}

describe('parseDecomposition', () => {
  it('parses a valid nested tree', () => {
    const d = parseDecomposition(JSON.stringify(NESTED))
    expect(d.decomposed).toBe(true)
    expect(d.tasks).toHaveLength(3)
  })

  it('flattens the tree into leaves; inner nodes only contribute title prefixes', () => {
    const leaves = flattenDecomposition(parseDecomposition(JSON.stringify(NESTED)))
    expect(leaves).toEqual([
      { titlePath: '明确需求', kind: 'clarify', question: '目标用户是谁？', dependsOn: [] },
      { titlePath: '后端 > 数据库设计', kind: 'design', dependsOn: [] },
      { titlePath: '后端 > API 实现', kind: 'execute', dependsOn: [] },
      { titlePath: '竞品调研', kind: 'research', dependsOn: [] },
    ])
  })

  it('an empty tasks list is not decomposed', () => {
    const d = parseDecomposition(JSON.stringify({ decomposed: false, tasks: [] }))
    expect(d.decomposed).toBe(false)
  })

  it('rejects malformed trees loudly', () => {
    expect(() => parseDecomposition('{not json')).toThrowError(DecompositionError)
    expect(() => parseDecomposition(JSON.stringify({ tasks: [{ kind: 'execute' }] }))).toThrowError(/needs a title/)
    expect(() => parseDecomposition(JSON.stringify({ tasks: [{ title: 'x', kind: 'wat' }] }))).toThrowError(/unknown kind/)
    expect(() => parseDecomposition(JSON.stringify({ tasks: [{ title: 'x', kind: 'clarify' }] }))).toThrowError(/needs a question/)
    expect(() => parseDecomposition(JSON.stringify({ tasks: [{ title: 'x', kind: 'execute', subtasks: 'nope' }] }))).toThrowError(/subtasks must be an array/)
    expect(() => parseDecomposition(JSON.stringify({ tasks: [{ title: 'x', kind: 'execute', subtasks: [{ kind: 'execute' }] }] }))).toThrowError(/needs a title/)
  })
})

describe('loadDecomposition', () => {
  it('returns undefined when the file is missing (not decomposed)', () => {
    expect(loadDecomposition(join(dir, 'tasks.json'))).toBeUndefined()
  })

  it('returns undefined for a non-decomposed file', () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ decomposed: false, tasks: [] }), 'utf8')
    expect(loadDecomposition(join(dir, 'tasks.json'))).toBeUndefined()
  })

  it('loads a decomposed file from disk', () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify(NESTED), 'utf8')
    expect(loadDecomposition(join(dir, 'tasks.json'))?.tasks).toHaveLength(3)
  })
})
