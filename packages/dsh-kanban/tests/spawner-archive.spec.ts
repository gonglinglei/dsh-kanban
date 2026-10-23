/**
 * The archive/GAP-A contract on the SPAWNER side.
 *
 * Publishing a pending request is an observation of the filesystem, so it must
 * read the RAW ledger: an archived project has to stay able to advertise a
 * request that arrived after it was archived. If the publish phase used the
 * filtered snapshot instead, the request would be materializable but forever
 * invisible — the badge could never be published, because the badge is what
 * makes the project visible again (the self-lock the design calls G1+G2).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { projectDir, taskAdditionsPathFor } from '../src/session-runner.ts'
import { KanbanSpawner } from '../src/spawner.ts'
import { FakeApi } from './fake-api.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-spawner-archive-'))
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000_000_000)
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

async function flush(ms = 5_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('archive × pending requests (GAP-A)', () => {
  it('a request written after the archive re-surfaces the project on the next poll', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    const stopSpawner = spawner.start()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    await flush(1)
    service.transition(project.id, 'done')
    service.archiveProject(project.id)
    expect(service.snapshot().projects).toEqual([])
    expect(service.snapshot().archivedCounts).toEqual({ projects: 1, tasks: 0 })

    // The request lands AFTER the archive: I4 cannot have seen it.
    mkdirSync(projectDir(service.getProject(project.id)!), { recursive: true })
    writeFileSync(
      taskAdditionsPathFor(service.getProject(project.id)!),
      JSON.stringify({ decomposed: true, tasks: [{ title: '后续任务', kind: 'execute' }] }),
      'utf8',
    )
    await flush()

    // Visible again, with its badge — while the ledger marker is untouched.
    expect(service.snapshot().projects.map(entry => entry.id)).toEqual([project.id])
    expect(service.snapshot().pendingAdditions?.map(entry => entry.projectId)).toEqual([project.id])
    expect(service.getProject(project.id)?.archivedAt).toBeDefined()
    expect(service.snapshot().archivedCounts).toEqual({ projects: 1, tasks: 0 })

    // …and the human click still works: materializing re-opens the project and
    // the archive marker falls away through the status chokepoint (no explicit
    // unarchive call anywhere on this path).
    const result = service.materializePendingAdditions(project.id)
    expect(result.created).toHaveLength(1)
    const reopened = service.getProject(project.id)!
    expect(reopened.status).toBe('executing')
    expect(reopened.archivedAt).toBeUndefined()
    expect(service.snapshot().archivedCounts).toEqual({ projects: 0, tasks: 0 })
    stopSpawner()
  })

  it('an archived project with nothing pending stays hidden across ticks', async () => {
    const service = makeService()
    const api = new FakeApi()
    const spawner = new KanbanSpawner(service, api)
    const stopSpawner = spawner.start()
    const project = service.createProject({ title: 't', workspaceDir: dir, goal: 'g' })
    await flush(1)
    service.transition(project.id, 'done')
    const revision = service.snapshot().revision
    service.archiveProject(project.id)

    await flush(15_000)
    // The publish phase walks the raw ledger, but a project with no request
    // produces no entry and therefore no view change.
    expect(service.snapshot().projects).toEqual([])
    expect(service.snapshot().pendingAdditions).toEqual([])
    expect(service.getProject(project.id)?.archivedAt).toBeDefined()
    expect(service.snapshot().revision).toBe(revision + 1)
    stopSpawner()
  })
})
