/**
 * Task-level terminate/delete (human-only): terminate soft-stops a leaf into
 * blocked with a session cancel; delete hard-removes the leaf, releases
 * dependent siblings, cleans the artifact, and re-derives the project's
 * completion. deleteProject cancels every attached session on the way out
 * (the session-leak fix).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { decompositionPathFor, projectArtifactsDir, projectDir, taskArtifactPath } from '../src/session-runner.ts'
import { TransitionError } from '../src/state-machine.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-terminate-delete-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeService(): { service: KanbanHostService; cancelled: string[] } {
  const service = new KanbanHostService(join(dir, 'projects.json'))
  service.start()
  const cancelled: string[] = []
  service.setSessionCanceller(sessionId => { cancelled.push(sessionId) })
  return { service, cancelled }
}

function decomposeProject(service: KanbanHostService, tasks: unknown[] = [
  { title: '架构设计', kind: 'design' },
  { title: '编码实现', kind: 'execute', dependsOn: ['架构设计'] },
]): string {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks }), 'utf8')
  service.confirmPlan(project.id)
  return project.id
}

describe('KanbanHostService terminateTask', () => {
  it('moves a designing leaf to blocked with the default audit note and cancels its session', () => {
    const { service, cancelled } = makeService()
    const projectId = decomposeProject(service)
    const design = service.projectTasks(projectId).find(task => task.titlePath === '架构设计')!
    service.attachTaskSession(design.id, 'sess-design', 'design')

    const updated = service.terminateTask(projectId, design.id)
    expect(updated.status).toBe('blocked')
    expect(updated.history.at(-1)).toMatchObject({ actor: 'human', from: 'designing', to: 'blocked', note: '人工终止' })
    expect(cancelled).toEqual(['sess-design'])
  })

  it('moves an executing leaf to blocked and honors a custom note', () => {
    const { service, cancelled } = makeService()
    const projectId = decomposeProject(service, [{ title: '干活', kind: 'execute' }])
    const execute = service.projectTasks(projectId)[0]!
    service.attachTaskSession(execute.id, 'sess-exec', 'execute')

    const updated = service.terminateTask(projectId, execute.id, '方向变了')
    expect(updated.status).toBe('blocked')
    expect(updated.history.at(-1)?.note).toBe('方向变了')
    expect(cancelled).toEqual(['sess-exec'])
  })

  it('allows terminating a done leaf (the human is always in charge)', () => {
    const { service } = makeService()
    const projectId = decomposeProject(service, [{ title: '调研', kind: 'research' }])
    const research = service.projectTasks(projectId)[0]!
    service.reportTaskArtifactDone(research.id, undefined, 'system')
    service.verifyTaskDone(research.id, 'verified')
    expect(service.getTask(research.id)?.status).toBe('done')

    expect(service.terminateTask(projectId, research.id).status).toBe('blocked')
  })

  it('throws for an unknown task or a task of another project; a leaf without a session cancels nothing', () => {
    const { service, cancelled } = makeService()
    const projectId = decomposeProject(service)
    const design = service.projectTasks(projectId)[0]!
    expect(() => service.terminateTask(projectId, 'nope')).toThrowError(TransitionError)
    expect(() => service.terminateTask('nope', design.id)).toThrowError(TransitionError)
    service.terminateTask(projectId, design.id)
    expect(cancelled).toEqual([])
  })
})

describe('KanbanHostService deleteTask', () => {
  it('removes the leaf, strips its id from dependent siblings (with an audit entry), and cancels its session', () => {
    const { service, cancelled } = makeService()
    const projectId = decomposeProject(service)
    const design = service.projectTasks(projectId).find(task => task.titlePath === '架构设计')!
    const execute = service.projectTasks(projectId).find(task => task.titlePath === '编码实现')!
    service.attachTaskSession(design.id, 'sess-design', 'design')
    expect(execute.dependencies).toEqual([design.id])

    service.deleteTask(projectId, design.id)
    expect(service.getTask(design.id)).toBeUndefined()
    expect(service.projectTasks(projectId).map(task => task.titlePath)).toEqual(['编码实现'])
    const released = service.getTask(execute.id)!
    expect(released.dependencies).toEqual([])
    expect(released.history.at(-1)).toMatchObject({ actor: 'system', note: '依赖任务已删除，依赖解除' })
    expect(cancelled).toEqual(['sess-design'])
  })

  it('removes the leaf artifact file (missing files are fine)', () => {
    const { service } = makeService()
    const projectId = decomposeProject(service, [{ title: '调研', kind: 'research' }])
    const research = service.projectTasks(projectId)[0]!
    const project = service.getProject(projectId)!
    const artifactPath = taskArtifactPath(project, research.id)
    mkdirSync(projectArtifactsDir(project), { recursive: true })
    writeFileSync(artifactPath, '# 调研结论', 'utf8')
    service.reportTaskArtifactDone(research.id, artifactPath, 'system')
    expect(existsSync(artifactPath)).toBe(true)

    service.deleteTask(projectId, research.id)
    expect(existsSync(artifactPath)).toBe(false)
    // Deleting a leaf that never recorded an artifactPath also cleans the conventional path.
    const projectId2 = decomposeProject(service, [{ title: '无产物任务', kind: 'execute' }])
    const orphan = service.projectTasks(projectId2)[0]!
    expect(() => service.deleteTask(projectId2, orphan.id)).not.toThrow()
  })

  it('deleting the last unfinished leaf derives the project completion', () => {
    const { service } = makeService()
    const projectId = decomposeProject(service, [
      { title: '已完成任务', kind: 'execute' },
      { title: '多余任务', kind: 'execute' },
    ])
    const [first, second] = service.projectTasks(projectId)
    service.reportTaskExecuteDone(first!.id, 'system')
    expect(service.getProject(projectId)?.status).toBe('executing')

    service.deleteTask(projectId, second!.id)
    expect(service.getProject(projectId)?.status).toBe('done')
    expect(service.getProject(projectId)?.history.at(-1)?.note).toBe('all task leaves done')
  })

  it('allows deleting a done leaf and throws for an unknown task', () => {
    const { service } = makeService()
    const projectId = decomposeProject(service, [
      { title: '已完成任务', kind: 'execute' },
      { title: '另一个任务', kind: 'execute' },
    ])
    const [first] = service.projectTasks(projectId)
    service.reportTaskExecuteDone(first!.id, 'system')
    expect(() => service.deleteTask(projectId, first!.id)).not.toThrow()
    expect(service.getTask(first!.id)).toBeUndefined()
    expect(() => service.deleteTask(projectId, 'nope')).toThrowError(TransitionError)
  })
})

describe('KanbanHostService deleteProject session cascade', () => {
  it('cancels the project session and every task leaf session before removal', () => {
    const { service, cancelled } = makeService()
    const projectId = decomposeProject(service)
    service.attachSession(projectId, 'sess-project', 'execute')
    const design = service.projectTasks(projectId).find(task => task.titlePath === '架构设计')!
    const execute = service.projectTasks(projectId).find(task => task.titlePath === '编码实现')!
    service.attachTaskSession(design.id, 'sess-design', 'design')
    service.attachTaskSession(execute.id, 'sess-execute', 'execute')

    service.deleteProject(projectId)
    expect(cancelled.sort()).toEqual(['sess-design', 'sess-execute', 'sess-project'])
    expect(service.getProject(projectId)).toBeUndefined()
    expect(service.projectTasks(projectId)).toHaveLength(0)
  })
})
