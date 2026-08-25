import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { KanbanSpawner } from '../src/spawner.ts'
import {
  decompositionPathFor,
  projectArtifactsDir,
  projectDir,
  taskArtifactPath,
  type KanbanHistoryEvent,
} from '../src/session-runner.ts'
import { FakeApi } from './fake-api.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-task-spawner-'))
  vi.useFakeTimers()
  vi.setSystemTime(new Date(1_000_000_000_000))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function makeService(): KanbanHostService {
  const service = new KanbanHostService(join(dir, 'projects.json'))
  service.start()
  return service
}

function turnEnd(time: number): KanbanHistoryEvent {
  return { event: { type: 'turn/end', seq: 1, time, data: {} } }
}

async function flush(ms = 5_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

const DECOMPOSITION = {
  decomposed: true,
  tasks: [
    { title: '明确预算', kind: 'clarify', question: '预算上限？' },
    { title: '技术选型调研', kind: 'research' },
    { title: '架构设计', kind: 'design' },
    { title: '实现功能', kind: 'execute' },
  ],
}

function decomposeProject(service: KanbanHostService): string {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify(DECOMPOSITION), 'utf8')
  service.confirmPlan(project.id)
  return project.id
}

describe('KanbanSpawner task leaves', () => {
  it('spawns one session per working leaf by kind; clarify waits and execute defers', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const projectId = decomposeProject(service)
    await flush(1)

    // 1 project design session + research + design leaves; the execute leaf
    // defers until the clarify leaf is confirmed.
    expect(api.sessions.created).toHaveLength(3)
    const tasks = service.projectTasks(projectId)
    const research = tasks.find(task => task.kind === 'research')!
    const design = tasks.find(task => task.kind === 'design')!
    const execute = tasks.find(task => task.kind === 'execute')!
    expect(research.sessionRole).toBe('research')
    expect(design.sessionRole).toBe('design')
    expect(execute.sessionId).toBeUndefined()
    const clarify = tasks.find(task => task.kind === 'clarify')!
    expect(clarify.sessionId).toBeUndefined()

    // Confirming the clarify leaf releases the deferred execute spawn on
    // the next poll tick.
    service.answerClarification(projectId, clarify.id, '一百万以内')
    service.confirmTask(projectId, clarify.id)
    await flush()
    expect(api.sessions.created).toHaveLength(4)
    expect(service.getTask(execute.id)?.sessionRole).toBe('execute')
  })

  it('research leaf: turn end + artifact on disk → verified done (no human gate)', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const projectId = decomposeProject(service)
    await flush(1)
    const research = service.projectTasks(projectId).find(task => task.kind === 'research')!
    const sessionId = research.sessionId!

    const project = service.getProject(projectId)!
    const artifactPath = taskArtifactPath(project, research.id)
    mkdirSync(projectArtifactsDir(project), { recursive: true })
    writeFileSync(artifactPath, '# 调研结论', 'utf8')
    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [turnEnd(Date.now() + 1)])
    await flush()
    expect(service.getTask(research.id)?.status).toBe('done')
    expect(service.getTask(research.id)?.artifactPath).toBe(artifactPath)
  })

  it('research leaf without its artifact is blocked, not completed', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const projectId = decomposeProject(service)
    await flush(1)
    const research = service.projectTasks(projectId).find(task => task.kind === 'research')!
    const sessionId = research.sessionId!

    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [turnEnd(Date.now() + 1)])
    await flush()
    expect(service.getTask(research.id)?.status).toBe('blocked')
    expect(service.getTask(research.id)?.history.at(-1)?.note).toContain('is missing')
  })

  it('design leaf: turn end + artifact → awaiting-review, waits for the human gate', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const projectId = decomposeProject(service)
    await flush(1)
    const design = service.projectTasks(projectId).find(task => task.kind === 'design')!
    const sessionId = design.sessionId!

    const project = service.getProject(projectId)!
    mkdirSync(projectArtifactsDir(project), { recursive: true })
    writeFileSync(taskArtifactPath(project, design.id), '# 设计', 'utf8')
    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [turnEnd(Date.now() + 1)])
    await flush()
    expect(service.getTask(design.id)?.status).toBe('awaiting-review')
  })

  it('execute leaf: spawns after clarifications confirm, prompt carries them, turn end → done', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const projectId = decomposeProject(service)
    await flush(1)
    const clarify = service.projectTasks(projectId).find(task => task.kind === 'clarify')!
    service.answerClarification(projectId, clarify.id, '一百万以内')
    service.confirmTask(projectId, clarify.id)
    await flush()

    const execute = service.projectTasks(projectId).find(task => task.kind === 'execute')!
    expect(execute.sessionId).toBeDefined()
    const prompted = api.sessions.prompted.find(entry => entry.sessionId === execute.sessionId)
    expect(prompted?.text).toContain('一百万以内')

    const sessionId = execute.sessionId!
    api.sessions.summaries.set(sessionId, { sessionId, running: false })
    api.sessions.histories.set(sessionId, [turnEnd(Date.now() + 1)])
    await flush()
    expect(service.getTask(execute.id)?.status).toBe('done')
  })

  it('a leaf with dependencies does not spawn until they are done', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    mkdirSync(projectDir(project), { recursive: true })
    writeFileSync(decompositionPathFor(project), JSON.stringify({
      decomposed: true,
      tasks: [
        { title: '架构设计', kind: 'design' },
        { title: '编码实现', kind: 'execute', dependsOn: ['架构设计'] },
        { title: '测试验证', kind: 'execute', dependsOn: ['编码实现'] },
      ],
    }), 'utf8')
    service.confirmPlan(project.id)
    await flush(1)

    const design = service.projectTasks(project.id).find(task => task.titlePath === '架构设计')!
    const code = service.projectTasks(project.id).find(task => task.titlePath === '编码实现')!
    const test = service.projectTasks(project.id).find(task => task.titlePath === '测试验证')!
    // Only the design leaf spawned: code and test wait on dependencies.
    expect(design.sessionId).toBeDefined()
    expect(code.sessionId).toBeUndefined()
    expect(test.sessionId).toBeUndefined()

    // Design completes -> code spawns; test still waits.
    mkdirSync(projectArtifactsDir(project), { recursive: true })
    writeFileSync(taskArtifactPath(project, design.id), '# 设计', 'utf8')
    api.sessions.summaries.set(design.sessionId!, { sessionId: design.sessionId!, running: false })
    api.sessions.histories.set(design.sessionId!, [turnEnd(Date.now() + 1)])
    await flush()
    service.confirmTask(project.id, design.id)
    await flush()
    expect(service.getTask(code.id)?.sessionId).toBeDefined()
    expect(service.getTask(test.id)?.sessionId).toBeUndefined()

    // Code completes -> test spawns.
    api.sessions.summaries.set(code.sessionId!, { sessionId: code.sessionId!, running: false })
    api.sessions.histories.set(code.sessionId!, [turnEnd(Date.now() + 1)])
    await flush()
    expect(service.getTask(test.id)?.sessionId).toBeDefined()
  })

  it('the project completes when its last leaf settles', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const projectId = decomposeProject(service)
    await flush(1)

    // Clarify: answer + confirm, which also releases the deferred execute.
    const clarify = service.projectTasks(projectId).find(task => task.kind === 'clarify')!
    service.answerClarification(projectId, clarify.id, '一百万以内')
    service.confirmTask(projectId, clarify.id)
    await flush()

    // Research/design/execute: finish their sessions with artifacts.
    const project = service.getProject(projectId)!
    mkdirSync(projectArtifactsDir(project), { recursive: true })
    for (const kind of ['research', 'design', 'execute'] as const) {
      const task = service.projectTasks(projectId).find(task => task.kind === kind)!
      writeFileSync(taskArtifactPath(project, task.id), '# 产出', 'utf8')
      api.sessions.summaries.set(task.sessionId!, { sessionId: task.sessionId!, running: false })
      api.sessions.histories.set(task.sessionId!, [turnEnd(Date.now() + 1)])
    }
    await flush()
    // Research self-completes; design waits for the human gate.
    expect(service.getTask(service.projectTasks(projectId).find(t => t.kind === 'research')!.id)?.status).toBe('done')
    const design = service.projectTasks(projectId).find(task => task.kind === 'design')!
    service.confirmTask(projectId, design.id)
    expect(service.getProject(projectId)?.status).toBe('done')
  })

  it('an affiliated child project\'s execute-leaf prompt carries the parent long-running project context', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    spawner.start()
    const parent = service.createProject({ title: '主线建设', workspaceDir: dir, goal: '持续演进', lifecycle: 'long-running' })
    const project = service.createProject({ title: '子项', workspaceDir: dir, goal: 'g', parentId: parent.id })
    mkdirSync(projectDir(project), { recursive: true })
    writeFileSync(decompositionPathFor(project), JSON.stringify({
      decomposed: true,
      tasks: [{ title: '实现功能', kind: 'execute' }],
    }), 'utf8')
    service.confirmPlan(project.id)
    await flush()

    const execute = service.projectTasks(project.id).find(task => task.kind === 'execute')!
    const prompted = api.sessions.prompted.find(entry => entry.sessionId === execute.sessionId)
    expect(prompted?.text).toContain('本项目隶属于长期项目：主线建设 — 持续演进')
  })
})
