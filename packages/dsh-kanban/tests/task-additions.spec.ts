import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DecompositionError } from '../src/decomposition.ts'
import { KanbanHostService } from '../src/host-service.ts'
import type { KanbanSnapshot, Project } from '../src/protocol.ts'
import { decompositionPathFor, projectDir, taskAdditionsPathFor } from '../src/session-runner.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-additions-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeService(): KanbanHostService {
  const service = new KanbanHostService(join(dir, 'projects.json'))
  service.start()
  return service
}

/** A project in the classic executing phase (no decomposition, no leaves). */
function executingProject(service: KanbanHostService): Project {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  service.confirmPlan(project.id)
  return service.getProject(project.id)!
}

/** A decomposed project whose leaves come from the given tasks.json body. */
function decomposedProject(service: KanbanHostService, tasks: unknown[]): Project {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks }), 'utf8')
  service.confirmPlan(project.id)
  return service.getProject(project.id)!
}

function writeAdditions(project: Project, body: unknown): void {
  writeFileSync(
    taskAdditionsPathFor(project),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8',
  )
}

function consumedFiles(project: Project): string[] {
  return readdirSync(projectDir(project)).filter(name => /^tasks-additions\.\d+\.consumed\.json$/.test(name))
}

describe('KanbanHostService applyTaskAdditions', () => {
  it('returns undefined when no request file exists (the normal path)', () => {
    const service = makeService()
    const project = executingProject(service)
    expect(service.applyTaskAdditions(project.id)).toBeUndefined()
    expect(service.projectTasks(project.id)).toHaveLength(0)
  })

  it('materializes the requested leaves with per-kind statuses and phase hooks', () => {
    const service = makeService()
    const designing: string[] = []
    const executing: string[] = []
    service.setSpawnHooks({
      onEnterDesigning: () => {},
      onEnterExecuting: () => {},
      onEnterTaskDesigning: task => { designing.push(task.kind) },
      onEnterTaskExecuting: task => { executing.push(task.kind) },
    })
    const project = executingProject(service)
    writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: '需要确认的口径', kind: 'clarify', question: '口径是？' },
        { title: '补充调研', kind: 'research' },
        { title: '追加的修复', kind: 'execute' },
      ],
    })
    const created = service.applyTaskAdditions(project.id)!
    expect(created).toHaveLength(3)
    const byKind = new Map(created.map(task => [task.kind, task]))
    expect(byKind.get('clarify')?.status).toBe('awaiting-clarification')
    expect(byKind.get('clarify')?.question).toBe('口径是？')
    expect(byKind.get('research')?.status).toBe('designing')
    expect(byKind.get('execute')?.status).toBe('executing')
    // Phase hooks fired for working leaves (the clarify leaf has none).
    expect(designing).toEqual(['research'])
    expect(executing).toEqual(['execute'])
    // The project itself stays executing (leaf-derived completion now).
    expect(service.getProject(project.id)?.status).toBe('executing')
  })

  it('resolves dependsOn against an existing DONE leaf (immediately schedulable)', () => {
    const service = makeService()
    // The pending clarify leaf keeps the project executing while the
    // execute leaf is already done.
    const project = decomposedProject(service, [
      { title: '口径确认', kind: 'clarify', question: '口径是？' },
      { title: '实现功能', kind: 'execute' },
    ])
    const done = service.projectTasks(project.id).find(task => task.titlePath === '实现功能')!
    service.reportTaskExecuteDone(done.id, 'system')
    expect(service.getTask(done.id)?.status).toBe('done')
    expect(service.getProject(project.id)?.status).toBe('executing')

    writeAdditions(project, {
      decomposed: true,
      tasks: [{ title: '回归验证', kind: 'execute', dependsOn: ['实现功能'] }],
    })
    const created = service.applyTaskAdditions(project.id)!
    expect(created).toHaveLength(1)
    expect(created[0]?.dependencies).toEqual([done.id])
  })

  it('resolves dependsOn against an existing IN-FLIGHT leaf (waits for it)', () => {
    const service = makeService()
    const project = decomposedProject(service, [
      { title: '口径确认', kind: 'clarify', question: '口径是？' },
      { title: '实现功能', kind: 'execute' },
    ])
    const inflight = service.projectTasks(project.id).find(task => task.titlePath === '实现功能')!
    expect(inflight.status).toBe('executing')

    writeAdditions(project, {
      decomposed: true,
      tasks: [{ title: '回归验证', kind: 'execute', dependsOn: ['实现功能'] }],
    })
    const created = service.applyTaskAdditions(project.id)!
    expect(created[0]?.dependencies).toEqual([inflight.id])
  })

  it('resolves dependsOn within the same additions batch', () => {
    const service = makeService()
    const project = executingProject(service)
    writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: '补充设计', kind: 'execute' },
        { title: '按补充设计实现', kind: 'execute', dependsOn: ['补充设计'] },
      ],
    })
    const created = service.applyTaskAdditions(project.id)!
    const first = created.find(task => task.titlePath === '补充设计')!
    const second = created.find(task => task.titlePath === '按补充设计实现')!
    expect(second.dependencies).toEqual([first.id])
  })

  it('rejects a titlePath that collides with an existing leaf; nothing is half-created, the file is kept', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: '无关的新任务', kind: 'execute' },
        { title: '实现功能', kind: 'execute' },
      ],
    })
    expect(() => service.applyTaskAdditions(project.id)).toThrowError(DecompositionError)
    expect(() => service.applyTaskAdditions(project.id)).toThrowError(/duplicate task title path/)
    // The whole batch was rejected: only the original leaf exists.
    expect(service.projectTasks(project.id).map(task => task.titlePath)).toEqual(['实现功能'])
    // A failed consumption never renames the request file.
    expect(existsSync(taskAdditionsPathFor(project))).toBe(true)
    expect(consumedFiles(project)).toHaveLength(0)
  })

  it('rejects an unknown dependency reference; nothing is half-created', () => {
    const service = makeService()
    const project = executingProject(service)
    writeAdditions(project, {
      decomposed: true,
      tasks: [{ title: '追加的修复', kind: 'execute', dependsOn: ['不存在的任务'] }],
    })
    expect(() => service.applyTaskAdditions(project.id)).toThrowError(/depends on unknown task/)
    expect(service.projectTasks(project.id)).toHaveLength(0)
    expect(existsSync(taskAdditionsPathFor(project))).toBe(true)
  })

  it('rejects a dependency cycle inside the new batch', () => {
    const service = makeService()
    const project = executingProject(service)
    writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: 'A', kind: 'execute', dependsOn: ['B'] },
        { title: 'B', kind: 'execute', dependsOn: ['A'] },
      ],
    })
    expect(() => service.applyTaskAdditions(project.id)).toThrowError(/dependency cycle/)
    expect(service.projectTasks(project.id)).toHaveLength(0)
  })

  it('rejects malformed JSON loudly (DecompositionError)', () => {
    const service = makeService()
    const project = executingProject(service)
    writeAdditions(project, '{ not json')
    expect(() => service.applyTaskAdditions(project.id)).toThrowError(DecompositionError)
    expect(service.projectTasks(project.id)).toHaveLength(0)
  })

  it('consumes the request file on success (rename) and never consumes it twice', () => {
    const service = makeService()
    const project = executingProject(service)
    writeAdditions(project, {
      decomposed: true,
      tasks: [{ title: '追加的修复', kind: 'execute' }],
    })
    const created = service.applyTaskAdditions(project.id)!
    expect(created).toHaveLength(1)
    // Original gone, exactly one *.consumed.json audit file remains.
    expect(existsSync(taskAdditionsPathFor(project))).toBe(false)
    expect(consumedFiles(project)).toHaveLength(1)
    // A second call is a no-op: no duplicate materialization.
    expect(service.applyTaskAdditions(project.id)).toBeUndefined()
    expect(service.projectTasks(project.id)).toHaveLength(1)
  })

  it('the SSE snapshot broadcast carries the newly materialized leaves (no client change needed)', () => {
    const service = makeService()
    const project = executingProject(service)
    let last: KanbanSnapshot | undefined
    service.subscribe(payload => { last = payload })
    writeAdditions(project, {
      decomposed: true,
      tasks: [{ title: '追加的修复', kind: 'execute' }],
    })
    service.applyTaskAdditions(project.id)
    expect(last?.tasks.filter(task => task.projectId === project.id).map(task => task.titlePath))
      .toContain('追加的修复')
  })

  it('the project completes only when every leaf — additions included — is done', () => {
    const service = makeService()
    const project = executingProject(service)
    writeAdditions(project, {
      decomposed: true,
      tasks: [{ title: '收尾工作', kind: 'execute' }],
    })
    const created = service.applyTaskAdditions(project.id)!
    expect(service.getProject(project.id)?.status).toBe('executing')
    service.reportTaskExecuteDone(created[0]!.id, 'system')
    expect(service.getProject(project.id)?.status).toBe('done')
    expect(service.getProject(project.id)?.history.at(-1)?.note).toBe('all task leaves done')
  })
})

describe('KanbanHostService noteExecutionSplit', () => {
  it('detaches the settled session and keeps the project executing', () => {
    const service = makeService()
    const project = executingProject(service)
    service.attachSession(project.id, 'sess-1', 'execute')
    const updated = service.noteExecutionSplit(project.id)
    expect(updated.sessionId).toBeUndefined()
    expect(updated.sessionRole).toBeUndefined()
    expect(updated.status).toBe('executing')
    expect(updated.history.at(-1)?.note).toBe('execution split into new task leaves')
  })

  it('is a no-op when no session is attached', () => {
    const service = makeService()
    const project = executingProject(service)
    const historyLength = service.getProject(project.id)!.history.length
    service.noteExecutionSplit(project.id)
    expect(service.getProject(project.id)!.history).toHaveLength(historyLength)
  })
})
