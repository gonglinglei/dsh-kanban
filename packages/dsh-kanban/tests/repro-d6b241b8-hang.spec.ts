/**
 * Regression for the production incident behind project
 * d6b241b8-7899-4a63-b131-2c0137c7237e ("设计nasdaq100-daily-rank技能长期优化方案"),
 * which hung on the kanban board in status=executing with zero task leaves.
 *
 * Root cause (see .kanban/projects/8ca8b55c-.../diagnosis.md):
 * the design agent's tasks.json declared a leaf whose dependsOn points at an
 * INTERMEDIATE node title ("反馈指标与阈值体系设计"). flattenDecomposition()
 * only materializes leaves, so materializeTasks() threw
 * DecompositionError "depends on unknown task" — but confirmPlan() had
 * ALREADY committed awaiting-review → executing (persisted). The project was
 * left half-committed: executing, 0 leaves, and the ended DESIGN session
 * still attached. Every 5s poll then settled that session, tried
 * executing → awaiting-review, got rejected by the state machine, and
 * silently swallowed the error — a silent no-op spin that read as "hung".
 *
 * The fix: confirmPlan() runs the pure planning/validation phase of
 * materialization (planTaskNodes) BEFORE committing the status change, so a
 * broken decomposition is rejected without any state change. The tests
 * below pin that contract down: rejection leaves status, history, leaves,
 * and the attached session untouched; the confirmation stays retryable; and
 * the poll no longer spins on a half-committed project.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DecompositionError } from '../src/decomposition.ts'
import { KanbanHostService } from '../src/host-service.ts'
import { KanbanSpawner } from '../src/spawner.ts'
import { decompositionPathFor, planPathFor, projectDir, type KanbanHistoryEvent } from '../src/session-runner.ts'
import type { Project } from '../src/protocol.ts'
import { FakeApi } from './fake-api.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-repro-'))
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

/**
 * Mirrors the offending tasks.json of project d6b241b8 (abridged): the
 * execute leaf depends on "反馈指标与阈值体系设计", which is an inner node
 * with subtasks — never materialized as a leaf, so the reference resolves
 * to nothing.
 */
const OFFENDING_DECOMPOSITION = {
  decomposed: true,
  tasks: [
    {
      title: '反馈指标与阈值体系设计',
      kind: 'design',
      subtasks: [
        { title: '定稿 M1-M8 指标口径与阈值初值', kind: 'design' },
      ],
    },
    {
      title: '实现 scripts/health_check.py 诊断脚本',
      kind: 'execute',
      dependsOn: ['反馈指标与阈值体系设计'],
    },
  ],
}

function writeDecomposition(project: Project): void {
  mkdirSync(projectDir(project), { recursive: true })
  writeFileSync(decompositionPathFor(project), JSON.stringify(OFFENDING_DECOMPOSITION), 'utf8')
}

describe('repro d6b241b8: confirmPlan with a dependsOn pointing at an intermediate node', () => {
  it('rejects the confirmation WITHOUT changing any state', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    writeDecomposition(project)

    expect(() => service.confirmPlan(project.id)).toThrowError(/depends on unknown task/)
    // The desired contract: an invalid decomposition must be rejected
    // BEFORE the commit, leaving the project exactly where it was.
    expect(service.getProject(project.id)?.status).toBe('designing')
    expect(service.projectTasks(project.id)).toHaveLength(0)
  })

  it('rejects WITHOUT any state change: status, history, and leaves untouched; retry stays possible', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    writeDecomposition(project)

    let thrown: unknown
    try {
      service.confirmPlan(project.id)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DecompositionError)
    expect((thrown as Error).message).toMatch(/depends on unknown task "反馈指标与阈值体系设计"/)

    // No half-commit: the project never left designing, no confirmation
    // history entry was written, and no leaf was materialized.
    const unchanged = service.getProject(project.id)!
    expect(unchanged.status).toBe('designing')
    expect(unchanged.history.some(entry => entry.note?.startsWith('plan confirmed'))).toBe(false)
    expect(service.projectTasks(project.id)).toHaveLength(0)

    // The human can RETRY the confirmation — the second attempt fails the
    // same way (never "already in executing"), so fixing tasks.json and
    // re-confirming is a way out.
    expect(() => service.confirmPlan(project.id)).toThrowError(/depends on unknown task/)
    expect(service.getProject(project.id)?.status).toBe('designing')

    // Nothing half-committed was persisted: a fresh service instance
    // reloaded from disk sees the project exactly where it was.
    service.dispose()
    const reloaded = new KanbanHostService(join(dir, 'projects.json'))
    reloaded.start()
    expect(reloaded.getProject(project.id)?.status).toBe('designing')
    expect(reloaded.projectTasks(project.id)).toHaveLength(0)
    reloaded.dispose()
  })

  it('rejection leaves the project in awaiting-review and the 5s poll no longer spins on it', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    const dispose = spawner.start()

    // Walk the real path: design session spawned, artifacts written, design
    // turn ends → awaiting-review (the design session stays attached).
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    await flush(1)
    expect(service.getProject(project.id)?.sessionId).toBe('sess-1')
    expect(service.getProject(project.id)?.sessionRole).toBe('design')

    mkdirSync(projectDir(project), { recursive: true })
    writeFileSync(planPathFor(project), '# 方案', 'utf8')
    writeFileSync(decompositionPathFor(project), JSON.stringify(OFFENDING_DECOMPOSITION), 'utf8')
    api.sessions.summaries.set('sess-1', { sessionId: 'sess-1', running: false })
    api.sessions.histories.set('sess-1', [turnEnd(Date.now() + 1)])
    await flush()
    expect(service.getProject(project.id)?.status).toBe('awaiting-review')

    // Human confirms → validation throws BEFORE the commit; the project
    // stays exactly where it was, with the design session still attached.
    expect(() => service.confirmPlan(project.id)).toThrowError(/depends on unknown task/)
    expect(service.getProject(project.id)?.status).toBe('awaiting-review')
    expect(service.getProject(project.id)?.sessionRole).toBe('design')

    const historyLength = service.getProject(project.id)?.history.length
    const sessionsCreated = api.sessions.created.length

    // Ten poll ticks: the poll only settles sessions of projects in
    // designing/executing, so an awaiting-review project is skipped
    // outright — nothing changes, no silent spin, no new session.
    for (let i = 0; i < 10; i++) await flush()

    const stable = service.getProject(project.id)!
    expect(stable.status).toBe('awaiting-review') // untouched by the poll
    expect(stable.history.length).toBe(historyLength)
    expect(api.sessions.created.length).toBe(sessionsCreated) // no session ever spawns
    expect(service.projectTasks(project.id)).toHaveLength(0)

    dispose()
  })
})
