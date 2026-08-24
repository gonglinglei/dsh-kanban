import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { TransitionError } from '../src/state-machine.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-tasks-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeService(): KanbanHostService {
  const service = new KanbanHostService(join(dir, 'projects.json'))
  service.start()
  return service
}

const DECOMPOSITION = {
  decomposed: true,
  tasks: [
    { title: '明确预算', kind: 'clarify', question: '预算上限是多少？' },
    { title: '技术选型调研', kind: 'research' },
    { title: '架构设计', kind: 'design' },
    { title: '实现功能', kind: 'execute' },
  ],
}

function decomposeProject(service: KanbanHostService): string {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify(DECOMPOSITION), 'utf8')
  service.confirmPlan(project.id)
  return project.id
}

describe('KanbanHostService task decomposition', () => {
  it('confirmPlan materializes leaves with per-kind initial statuses', () => {
    const service = makeService()
    const projectId = decomposeProject(service)
    const tasks = service.projectTasks(projectId)
    expect(tasks).toHaveLength(4)
    expect(tasks.map(task => [task.kind, task.status])).toEqual([
      ['clarify', 'awaiting-clarification'],
      ['research', 'designing'],
      ['design', 'designing'],
      ['execute', 'executing'],
    ])
    expect(tasks.find(task => task.kind === 'clarify')?.question).toBe('预算上限是多少？')
    expect(service.getProject(projectId)?.status).toBe('executing')
  })

  it('a project without decomposition keeps the classic single-session path', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    let executed = false
    service.setSpawnHooks({
      onEnterDesigning: () => {},
      onEnterExecuting: () => { executed = true },
      onEnterTaskDesigning: () => { throw new Error('must not fire without decomposition') },
      onEnterTaskExecuting: () => { throw new Error('must not fire without decomposition') },
    })
    service.confirmPlan(project.id)
    expect(executed).toBe(true)
    expect(service.projectTasks(project.id)).toHaveLength(0)
  })

  it('fires task phase hooks for research/design (designing) and execute (executing) leaves', () => {
    const service = makeService()
    const designing: string[] = []
    const executing: string[] = []
    service.setSpawnHooks({
      onEnterDesigning: () => {},
      onEnterExecuting: () => {},
      onEnterTaskDesigning: task => { designing.push(task.kind) },
      onEnterTaskExecuting: task => { executing.push(task.kind) },
    })
    const projectId = decomposeProject(service)
    void projectId
    expect(designing.sort()).toEqual(['design', 'research'])
    expect(executing).toEqual(['execute'])
  })

  it('answerClarification moves the leaf to awaiting-review with the answer recorded', () => {
    const service = makeService()
    const projectId = decomposeProject(service)
    const clarify = service.projectTasks(projectId).find(task => task.kind === 'clarify')!
    const updated = service.answerClarification(projectId, clarify.id, '一百万以内')
    expect(updated.status).toBe('awaiting-review')
    expect(updated.answer).toBe('一百万以内')
  })

  it('refuses to answer a non-clarify leaf', () => {
    const service = makeService()
    const projectId = decomposeProject(service)
    const execute = service.projectTasks(projectId).find(task => task.kind === 'execute')!
    expect(() => service.answerClarification(projectId, execute.id, 'x')).toThrowError(TransitionError)
  })

  it('confirmTask completes a leaf; the project completes when every leaf is done', () => {
    const service = makeService()
    const projectId = decomposeProject(service)
    const tasks = service.projectTasks(projectId)
    const clarify = tasks.find(task => task.kind === 'clarify')!
    const research = tasks.find(task => task.kind === 'research')!
    const design = tasks.find(task => task.kind === 'design')!
    const execute = tasks.find(task => task.kind === 'execute')!

    service.answerClarification(projectId, clarify.id, '一百万以内')
    service.confirmTask(projectId, clarify.id)
    expect(service.getProject(projectId)?.status).toBe('executing')

    service.reportTaskArtifactDone(research.id, join(dir, '.kanban', 'artifacts', `${research.id}.md`), 'system')
    service.verifyTaskDone(research.id, 'verified')
    service.reportTaskArtifactDone(design.id, join(dir, '.kanban', 'artifacts', `${design.id}.md`), 'system')
    service.confirmTask(projectId, design.id)
    service.reportTaskExecuteDone(execute.id, 'system')
    // The last leaf completing derives the project completion.
    expect(service.getProject(projectId)?.status).toBe('done')
    expect(service.getProject(projectId)?.history.at(-1)?.note).toBe('all task leaves done')
  })

  it('a research leaf can be system-verified only from awaiting-review', () => {
    const service = makeService()
    const projectId = decomposeProject(service)
    const research = service.projectTasks(projectId).find(task => task.kind === 'research')!
    // Not yet reported: verify from designing is illegal.
    expect(() => service.verifyTaskDone(research.id, 'x')).toThrowError(TransitionError)
  })

  it('deleteProject removes the task leaves too', () => {
    const service = makeService()
    const projectId = decomposeProject(service)
    service.deleteProject(projectId)
    expect(service.projectTasks(projectId)).toHaveLength(0)
  })

  it('task leaves survive persistence across service instances', () => {
    const file = join(dir, 'projects.json')
    const first = new KanbanHostService(file)
    first.start()
    const projectId = decomposeProject(first)
    first.dispose()

    const second = new KanbanHostService(file)
    second.start()
    expect(second.projectTasks(projectId)).toHaveLength(4)
  })
})
