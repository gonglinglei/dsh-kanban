import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '../src/protocol.ts'
import {
  decompositionPathFor,
  designPrompt,
  executePrompt,
  executeTaskPrompt,
  KanbanSessionRunner,
  planPathFor,
  projectDir,
  resumePrompt,
  SessionLaunchError,
  taskAdditionsPathFor,
  TASK_ADDITIONS_FILE,
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
    expect(api.sessions.prompted[0]?.text).toContain(planPathFor(project))
    expect(api.sessions.prompted[0]?.text).toContain(decompositionPathFor(project))
    // The launch pre-creates the per-project artifact directory.
    expect(existsSync(projectDir(project))).toBe(true)
  })

  it('launchDesign clears only this project\'s stale artifacts, never a parallel project\'s', async () => {
    const api = new FakeApi()
    const runner = new KanbanSessionRunner(api)
    const projectA = sampleProject({ id: 'pa' })
    const projectB = sampleProject({ id: 'pb', title: 'other' })
    // Stale artifacts from project A's previous design round.
    mkdirSync(join(projectDir(projectA), 'artifacts'), { recursive: true })
    writeFileSync(planPathFor(projectA), '旧方案', 'utf8')
    writeFileSync(decompositionPathFor(projectA), '{"tasks":[]}', 'utf8')
    writeFileSync(join(projectDir(projectA), 'artifacts', 'old.md'), 'x', 'utf8')
    // Project B shares the same workspaceDir and is mid-flight: its plan,
    // decomposition and task artifacts must survive A's fresh design round.
    mkdirSync(join(projectDir(projectB), 'artifacts'), { recursive: true })
    writeFileSync(planPathFor(projectB), 'B 的方案', 'utf8')
    writeFileSync(decompositionPathFor(projectB), '{"decomposed":true,"tasks":[]}', 'utf8')
    writeFileSync(join(projectDir(projectB), 'artifacts', 'b.md'), 'B 的产物', 'utf8')
    // Legacy root-level files are left alone too.
    writeFileSync(join(dir, 'plan.md'), '根目录方案', 'utf8')

    await runner.launchDesign(projectA)
    expect(existsSync(projectDir(projectA))).toBe(true) // re-created by launch
    expect(existsSync(planPathFor(projectA))).toBe(false)
    expect(existsSync(join(projectDir(projectA), 'artifacts', 'old.md'))).toBe(false)
    expect(readFileSync(planPathFor(projectB), 'utf8')).toBe('B 的方案')
    expect(readFileSync(decompositionPathFor(projectB), 'utf8')).toBe('{"decomposed":true,"tasks":[]}')
    expect(readFileSync(join(projectDir(projectB), 'artifacts', 'b.md'), 'utf8')).toBe('B 的产物')
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe('根目录方案')
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
    const project = sampleProject()
    expect(runner.planExists(project)).toBe(false)
    mkdirSync(projectDir(project), { recursive: true })
    writeFileSync(planPathFor(project), '# 方案', 'utf8')
    expect(runner.planExists(project)).toBe(true)
  })

  it('planExists prefers a persisted planPath (legacy root-level plan, resume compat)', () => {
    const runner = new KanbanSessionRunner(new FakeApi())
    const project = sampleProject({ planPath: join(dir, 'plan.md') })
    expect(runner.planExists(project)).toBe(false)
    writeFileSync(join(dir, 'plan.md'), '# 旧方案', 'utf8')
    expect(runner.planExists(project)).toBe(true)
  })

  it('builds prompts with the project facts', () => {
    const project = sampleProject({ feedback: '改一下' })
    expect(designPrompt(project)).toContain('build a thing')
    expect(executePrompt(project)).toContain(planPathFor(project))
    expect(resumePrompt(project)).toContain('改一下')
    expect(resumePrompt(project)).toContain(planPathFor(project))
  })

  it('injects the parent long-running project context into execute prompts', () => {
    const project = sampleProject({ status: 'executing', parentId: 'p-parent' })
    const parent = { title: '主线建设', goal: '持续演进' }
    expect(executePrompt(project, parent)).toContain('本项目隶属于长期项目：主线建设 — 持续演进')
    expect(executeTaskPrompt(
      { id: 't1', projectId: project.id, titlePath: '实现功能', kind: 'execute', status: 'executing', dependencies: [], version: 0, createdAt: 0, updatedAt: 0, lastActivityAt: 0, history: [] },
      project,
      [],
      parent,
    )).toContain('本项目隶属于长期项目：主线建设 — 持续演进')
    // Without a parent the line is absent.
    expect(executePrompt(project)).not.toContain('隶属于长期项目')
    expect(executeTaskPrompt(
      { id: 't1', projectId: project.id, titlePath: '实现功能', kind: 'execute', status: 'executing', dependencies: [], version: 0, createdAt: 0, updatedAt: 0, lastActivityAt: 0, history: [] },
      project,
      [],
    )).not.toContain('隶属于长期项目')
  })

  it('execute prompts carry the mid-run split instructions and the additions path', () => {
    const project = sampleProject({ status: 'executing' })
    const expectedPath = taskAdditionsPathFor(project)
    expect(expectedPath).toBe(join(projectDir(project), TASK_ADDITIONS_FILE))
    // Project-level execute prompt (undecomposed projects).
    const projectPrompt = executePrompt(project)
    expect(projectPrompt).toContain(expectedPath)
    expect(projectPrompt).toContain('不要重复拆分你正在执行的任务本身')
    // Leaf-level execute prompt (decomposed projects).
    const leafPrompt = executeTaskPrompt(
      { id: 't1', projectId: project.id, titlePath: '实现功能', kind: 'execute', status: 'executing', dependencies: [], version: 0, createdAt: 0, updatedAt: 0, lastActivityAt: 0, history: [] },
      project,
      [],
    )
    expect(leafPrompt).toContain(expectedPath)
    expect(leafPrompt).toContain('不要重复拆分你正在执行的任务本身')
  })

  it('cancelSession sends the cancel RPC and swallows every failure (best-effort)', async () => {
    const api = new FakeApi()
    const runner = new KanbanSessionRunner(api)
    await runner.cancelSession('sess-1')
    expect(api.sessions.cancelled).toEqual(['sess-1'])

    // A rejecting cancel RPC must not propagate: the session may already
    // be gone and the board operation commits regardless.
    const failing = new FakeApi()
    failing.sessions.cancel = async () => { throw new Error('cancel boom') }
    const failingRunner = new KanbanSessionRunner(failing)
    await expect(failingRunner.cancelSession('sess-gone')).resolves.toBeUndefined()
  })
})
