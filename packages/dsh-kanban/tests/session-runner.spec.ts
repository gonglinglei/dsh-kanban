import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '../src/protocol.ts'
import {
  designPrompt,
  executePrompt,
  KanbanSessionRunner,
  resumePrompt,
  SessionLaunchError,
  type KanbanApi,
  type KanbanHistoryEvent,
  type KanbanSessionSummary,
} from '../src/session-runner.ts'
import { FakeApi } from './fake-api.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-runner-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function sampleProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: 'demo',
    workspaceDir: dir,
    goal: 'build a thing',
    status: 'designing',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    history: [],
    ...overrides,
  }
}

function turnEnd(time: number, error = false): KanbanHistoryEvent {
  return {
    event: {
      type: 'turn/end',
      seq: 1,
      time,
      data: error ? { reason: { kind: 'error', message: 'boom' } } : {},
    },
  }
}

describe('KanbanSessionRunner', () => {
  it('launches a design session: create with cwd, rename, prompt with the goal', async () => {
    const api = new FakeApi()
    const runner = new KanbanSessionRunner(api)
    const project = sampleProject()
    const sessionId = await runner.launchDesign(project)
    expect(api.sessions.created).toEqual([{ cwd: dir }])
    expect(api.sessions.renamed).toEqual([{ sessionId, title: 'demo·设计' }])
    expect(api.sessions.prompted[0]?.sessionId).toBe(sessionId)
    expect(api.sessions.prompted[0]?.text).toContain('build a thing')
    expect(api.sessions.prompted[0]?.text).toContain(join(dir, 'plan.md'))
  })

  it('launchDesign clears stale artifacts so an old plan/tasks.json cannot leak into the new phase', async () => {
    const api = new FakeApi()
    const runner = new KanbanSessionRunner(api)
    const project = sampleProject()
    // Stale artifacts from a previous design round.
    writeFileSync(join(dir, 'plan.md'), '旧方案', 'utf8')
    writeFileSync(join(dir, 'tasks.json'), '{"tasks":[]}', 'utf8')
    mkdirSync(join(dir, '.kanban', 'artifacts'), { recursive: true })
    writeFileSync(join(dir, '.kanban', 'artifacts', 'old.md'), 'x', 'utf8')

    await runner.launchDesign(project)
    expect(existsSync(join(dir, 'plan.md'))).toBe(false)
    expect(existsSync(join(dir, 'tasks.json'))).toBe(false)
    expect(existsSync(join(dir, '.kanban'))).toBe(false)
  })

  it('launches an execution session with the confirmed plan path', async () => {
    const api = new FakeApi()
    const runner = new KanbanSessionRunner(api)
    const project = sampleProject({ status: 'executing', planPath: join(dir, 'plan.md') })
    const sessionId = await runner.launchExecute(project)
    expect(api.sessions.renamed).toEqual([{ sessionId, title: 'demo·执行' }])
    expect(api.sessions.prompted[0]?.text).toContain('plan.md')
  })

  it('resumes the attached design session with the feedback', async () => {
    const api = new FakeApi()
    const runner = new KanbanSessionRunner(api)
    const project = sampleProject({ sessionId: 'sess-9', sessionRole: 'design', feedback: '太模糊了' })
    const sessionId = await runner.resumeDesign(project)
    expect(sessionId).toBe('sess-9')
    expect(api.sessions.prompted).toHaveLength(1)
    expect(api.sessions.prompted[0]?.text).toContain('太模糊了')
  })

  it('refuses to resume a project without an attached session', async () => {
    const runner = new KanbanSessionRunner(new FakeApi())
    await expect(runner.resumeDesign(sampleProject())).rejects.toThrow(/no session is attached/)
  })

  it('wraps launch failures after session creation in SessionLaunchError', async () => {
    const api = new FakeApi()
    api.sessions.prompt = async () => ({ result: { ok: false as const, error: { code: 'x', message: 'nope' } } })
    const runner = new KanbanSessionRunner(api)
    await expect(runner.launchDesign(sampleProject())).rejects.toBeInstanceOf(SessionLaunchError)
  })

  it('inspects: running → pending, missing → cancelled', async () => {
    const api = new FakeApi()
    const runner = new KanbanSessionRunner(api)
    expect(await runner.inspect('ghost', 0)).toEqual({ outcome: 'cancelled', error: 'execution session no longer exists' })
    api.sessions.summaries.set('sess-1', { sessionId: 'sess-1', running: true })
    expect(await runner.inspect('sess-1', 0)).toEqual({ outcome: 'pending' })
  })

  it('inspects: a turn/end after launch is success, before launch is ignored', async () => {
    const api = new FakeApi()
    api.sessions.summaries.set('sess-1', { sessionId: 'sess-1', running: false })
    api.sessions.histories.set('sess-1', [turnEnd(50), turnEnd(150)])
    const runner = new KanbanSessionRunner(api)
    expect(await runner.inspect('sess-1', 100)).toEqual({ outcome: 'succeeded' })
    expect(await runner.inspect('sess-1', 200)).toEqual({ outcome: 'pending' })
  })

  it('inspects: an error turn/end is a failure', async () => {
    const api = new FakeApi()
    api.sessions.summaries.set('sess-1', { sessionId: 'sess-1', running: false })
    api.sessions.histories.set('sess-1', [turnEnd(50, true)])
    const runner = new KanbanSessionRunner(api)
    expect(await runner.inspect('sess-1', 0)).toEqual({ outcome: 'failed', error: 'agent turn ended with an error' })
  })

  it('planExists reflects the on-disk artifact', () => {
    const runner = new KanbanSessionRunner(new FakeApi())
    expect(runner.planExists(sampleProject())).toBe(false)
    writeFileSync(join(dir, 'plan.md'), '# 方案', 'utf8')
    expect(runner.planExists(sampleProject())).toBe(true)
  })

  it('builds prompts with the project facts', () => {
    const project = sampleProject({ feedback: '改一下' })
    expect(designPrompt(project)).toContain('build a thing')
    expect(executePrompt(project)).toContain(join(dir, 'plan.md'))
    expect(resumePrompt(project)).toContain('改一下')
  })
})
