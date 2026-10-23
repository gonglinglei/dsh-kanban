/**
 * The human gate of the late task-additions fix: `materializePendingAdditions`
 * (the board's「物化到看板」button).
 *
 * Contracts pinned here:
 *  - order is plan (pure) → claim (filesystem receipt) → re-open → one ledger
 *    batch → audit rename → audit note, so a double click and a malformed body
 *    both stay explainable instead of destructive;
 *  - a done/blocked project goes back to `executing` through the existing
 *    human any→any edge (no new system edge, state-machine.ts untouched);
 *  - `reportExecuteDone` must never assert completion while a leaf is open.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { TransitionError } from '../src/state-machine.ts'
import type { Project } from '../src/protocol.ts'
import { decompositionPathFor, projectDir, taskAdditionsPathFor } from '../src/session-runner.ts'

const FOUR_REQUESTS = [
  { title: '补齐 CONTRIBUTING 等社区文档', kind: 'execute' },
  { title: '加 GH Actions CI 与模板', kind: 'execute' },
  { title: 'repro 测试脱敏改名', kind: 'execute' },
  { title: '提供英文 README', kind: 'execute' },
]

let dir: string
let ledger: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-materialize-'))
  ledger = join(dir, 'projects.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeService(): KanbanHostService {
  const service = new KanbanHostService(ledger)
  service.start()
  return service
}

/** A decomposed project whose leaves come from the given tasks.json body. */
function decomposedProject(service: KanbanHostService, tasks: unknown[]): Project {
  const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify({ decomposed: true, tasks }), 'utf8')
  service.confirmPlan(project.id)
  return service.getProject(project.id)!
}

function writeAdditions(project: Project, body: unknown): string {
  const path = taskAdditionsPathFor(project)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return path
}

/** Back-date a file so the probe's half-write guard (>= 1500 ms of quiet) accepts it. */
function backdate(path: string, ms = 5_000): void {
  const at = new Date(Date.now() - ms)
  utimesSync(path, at, at)
}

/** A decomposed project whose leaves are all done (the project is therefore done). */
function completedDecomposedProject(service: KanbanHostService, tasks: unknown[]): Project {
  const project = decomposedProject(service, tasks)
  for (const task of service.projectTasks(project.id)) {
    if (task.kind === 'clarify') {
      service.answerClarification(project.id, task.id, '按既有口径')
      service.confirmTask(project.id, task.id)
    } else {
      service.reportTaskExecuteDone(task.id, 'system')
    }
  }
  expect(service.getProject(project.id)?.status).toBe('done')
  return service.getProject(project.id)!
}

function consumedFiles(project: Project): string[] {
  return readdirSync(projectDir(project)).filter(name => name.endsWith('.consumed.json')).sort()
}

describe('KanbanHostService materializePendingAdditions', () => {
  it('materializes a late request on a DONE project: leaves added, project re-opened, audit note written', () => {
    const service = makeService()
    const project = completedDecomposedProject(service, [
      { title: '明确开源范围', kind: 'clarify', question: '范围？' },
      { title: '全量开源就绪审查并输出报告', kind: 'execute' },
    ])
    expect(service.projectTasks(project.id)).toHaveLength(2)

    const path = writeAdditions(project, { decomposed: true, tasks: FOUR_REQUESTS })
    backdate(path)

    const result = service.materializePendingAdditions(project.id, '按澄清结论补齐')
    expect(result.created).toHaveLength(4)
    expect(result.skipped).toEqual([])
    expect(result.reopened).toBe(true)
    expect(result.consumed).toHaveLength(1)
    expect(result.consumed[0]).toMatch(/^tasks-additions\.\d+\.consumed\.json$/)

    const after = service.getProject(project.id)!
    expect(after.status).toBe('executing')
    expect(service.projectTasks(project.id)).toHaveLength(6)
    // The new execute leaves inherit the classic status, not a parked one.
    for (const leaf of service.projectTasks(project.id).filter(task => task.titlePath !== '全量开源就绪审查并输出报告' && task.titlePath !== '明确开源范围')) {
      expect(leaf.status).toBe('executing')
    }
    // A3: an auditable, readable history note (who / what / how many / reopen).
    const note = after.history.at(-1)!
    expect(note.actor).toBe('human')
    expect(note.note).toContain('人工物化新增任务请求：新建 4 项')
    expect(note.note).toContain('项目重开 done → executing')
    expect(note.note).toContain('备注：按澄清结论补齐')

    // The badge disappears with the click, not a tick later.
    expect(service.snapshot().pendingAdditions).toEqual([])
    // The request is gone from the live slot and kept for audit exactly once.
    expect(existsSync(path)).toBe(false)
    expect(consumedFiles(after)).toHaveLength(1)
  })

  it('keeps the ledger untouched when there is nothing to materialize', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const revision = service.snapshot().revision
    expect(() => service.materializePendingAdditions(project.id)).toThrowError(/no pending task-additions request/)
    expect(() => service.materializePendingAdditions('unknown-project')).toThrowError(TransitionError)
    expect(service.snapshot().revision).toBe(revision)
    expect(service.projectTasks(project.id)).toHaveLength(1)
  })

  it('refuses an unparsable request, keeps the file, and changes nothing', () => {
    const service = makeService()
    const project = completedDecomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, '{ not json')
    backdate(path)
    service.refreshPendingAdditions(project.id)

    const revision = service.snapshot().revision
    expect(() => service.materializePendingAdditions(project.id)).toThrowError(/malformed/)
    expect(service.getProject(project.id)?.status).toBe('done')
    expect(service.projectTasks(project.id)).toHaveLength(1)
    expect(service.snapshot().revision).toBe(revision)
    expect(existsSync(path)).toBe(true)
    expect(consumedFiles(project)).toHaveLength(0)
    // The badge is still there, now explaining the failure.
    expect(service.snapshot().pendingAdditions![0]!.state).toBe('malformed')
  })

  it('explains a second click instead of materializing twice', () => {
    const service = makeService()
    const project = completedDecomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '补充测试', kind: 'execute' }] })
    backdate(path)

    expect(service.materializePendingAdditions(project.id).created).toHaveLength(1)
    const revision = service.snapshot().revision
    expect(() => service.materializePendingAdditions(project.id)).toThrowError(/no pending task-additions request/)
    expect(service.snapshot().revision).toBe(revision)
    expect(service.projectTasks(project.id)).toHaveLength(2)
  })

  it('refuses a project still inside a phase (nothing to re-open yet) with zero side effects', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    mkdirSync(projectDir(project), { recursive: true })
    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '后续工作', kind: 'execute' }] })
    backdate(path)

    const revision = service.snapshot().revision
    expect(() => service.materializePendingAdditions(project.id)).toThrowError(/请先完成或放弃当前相位/)
    expect(service.getProject(project.id)?.status).toBe('designing')
    expect(service.projectTasks(project.id)).toHaveLength(0)
    expect(service.snapshot().revision).toBe(revision)
    expect(existsSync(path)).toBe(true)
  })

  it('re-opens a BLOCKED project through the existing human edge', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    service.transition(project.id, 'blocked', '人工暂停')
    const path = writeAdditions(service.getProject(project.id)!, { decomposed: true, tasks: [{ title: '恢复后的收尾', kind: 'execute' }] })
    backdate(path)

    const result = service.materializePendingAdditions(project.id)
    expect(result.reopened).toBe(true)
    const after = service.getProject(project.id)!
    expect(after.status).toBe('executing')
    expect(after.history.at(-1)!.actor).toBe('human')
    expect(after.history.at(-1)!.note).toContain('项目重开 blocked → executing')
    expect(service.projectTasks(project.id)).toHaveLength(2)
  })

  it('does not re-open an EXECUTING project (reopened=false, no reopen wording)', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '补充测试', kind: 'execute' }] })
    backdate(path)

    const result = service.materializePendingAdditions(project.id)
    expect(result.reopened).toBe(false)
    const note = service.getProject(project.id)!.history.at(-1)!
    expect(note.note).toContain('人工物化新增任务请求：新建 1 项')
    expect(note.note).not.toContain('项目重开')
  })

  it('skips an already-existing titlePath on the human path and says so in the audit note', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, {
      decomposed: true,
      tasks: [
        { title: '实现功能', kind: 'execute' },
        { title: '补充测试', kind: 'execute' },
      ],
    })
    backdate(path)

    const result = service.materializePendingAdditions(project.id)
    expect(result.created.map(task => task.titlePath)).toEqual(['补充测试'])
    expect(result.skipped).toEqual(['实现功能'])
    const note = service.getProject(project.id)!.history.at(-1)!.note
    expect(note).toContain('新建 1 项')
    expect(note).toContain('跳过 1 项（已存在：实现功能）')
    expect(service.projectTasks(project.id)).toHaveLength(2)
  })
})

describe('KanbanHostService reportExecuteDone ordering (risk C)', () => {
  it('never asserts completion while a leaf is still open', () => {
    const service = makeService()
    const project = decomposedProject(service, [
      { title: '甲任务', kind: 'execute' },
      { title: '乙任务', kind: 'execute' },
    ])
    service.reportTaskExecuteDone(service.projectTasks(project.id)[0]!.id, 'system')

    const after = service.reportExecuteDone(project.id, 'system')
    expect(after.status).toBe('executing')
    expect(after.history.at(-1)!.note).not.toBe('execution done')
  })

  it('derives completion once every leaf is done', () => {
    const service = makeService()
    const project = decomposedProject(service, [{ title: '唯一叶子', kind: 'execute' }])
    service.reportTaskExecuteDone(service.projectTasks(project.id)[0]!.id, 'system')
    expect(service.getProject(project.id)?.status).toBe('done')
    expect(service.getProject(project.id)?.history.at(-1)?.note).toBe('all task leaves done')
  })

  it('keeps the classic non-decomposed behaviour (zero leaves → done)', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    service.reportDesignDone(project.id, '/w/plan.md', 'agent')
    service.confirmPlan(project.id)
    expect(service.reportExecuteDone(project.id, 'agent').status).toBe('done')
  })

  it('never writes the assembly field to disk, even after a materialization', () => {
    const service = makeService()
    const project = completedDecomposedProject(service, [{ title: '实现功能', kind: 'execute' }])
    const path = writeAdditions(project, { decomposed: true, tasks: [{ title: '补充测试', kind: 'execute' }] })
    backdate(path)
    service.refreshPendingAdditions(project.id)
    service.materializePendingAdditions(project.id)
    expect(readFileSync(ledger, 'utf8')).not.toContain('pendingAdditions')
  })
})
