import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanHostService } from '../src/host-service.ts'
import { TransitionError } from '../src/state-machine.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-kanban-service-'))
  vi.useFakeTimers()
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

describe('KanbanHostService', () => {
  it('creates a project and auto-starts design', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    expect(project.status).toBe('designing')
    expect(project.version).toBe(2)
    expect(project.history.map(entry => [entry.from, entry.to, entry.actor])).toEqual([
      ['backlog', 'backlog', 'system'],
      ['backlog', 'designing', 'system'],
    ])
    expect(service.snapshot().revision).toBe(2)
  })

  it('fires the onEnterDesigning hook on create and on rejection', () => {
    const service = makeService()
    const designHits: string[] = []
    service.setSpawnHooks({
      onEnterDesigning: project => { designHits.push(project.id) },
      onEnterExecuting: () => {},
    })
    const project = service.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    service.reportDesignDone(project.id, '/w/plan.md', 'agent')
    service.rejectPlan(project.id, 'too vague')
    expect(designHits).toEqual([project.id, project.id])
  })

  it('walks the full relay: design done → confirm → execute done', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    service.reportDesignDone(project.id, '/w/plan.md', 'agent')
    expect(service.getProject(project.id)?.status).toBe('awaiting-review')
    expect(service.getProject(project.id)?.planPath).toBe('/w/plan.md')
    service.confirmPlan(project.id)
    expect(service.getProject(project.id)?.status).toBe('executing')
    service.reportExecuteDone(project.id, 'agent')
    expect(service.getProject(project.id)?.status).toBe('done')
  })

  it('records rejection feedback and keeps it on the project', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    service.reportDesignDone(project.id, '/w/plan.md', 'agent')
    service.rejectPlan(project.id, 'needs a budget section')
    const rejected = service.getProject(project.id)
    expect(rejected?.status).toBe('designing')
    expect(rejected?.feedback).toBe('needs a budget section')
    expect(rejected?.history.at(-1)?.note).toContain('needs a budget section')
  })

  it('refuses an agent reporting a phase it does not own', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    expect(() => service.reportExecuteDone(project.id, 'agent')).toThrowError(TransitionError)
  })

  it('lets the human override any state', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    service.transition(project.id, 'done', 'skip the review')
    expect(service.getProject(project.id)?.status).toBe('done')
  })

  it('deletes a project and bumps the revision', () => {
    const service = makeService()
    const project = service.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    const revision = service.snapshot().revision
    service.deleteProject(project.id)
    expect(service.getProject(project.id)).toBeUndefined()
    expect(service.snapshot().revision).toBeGreaterThan(revision)
  })

  it('persists across service instances (disk is the ledger)', () => {
    const file = join(dir, 'projects.json')
    const first = new KanbanHostService(file)
    first.start()
    const project = first.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    first.dispose()

    const second = new KanbanHostService(file)
    second.start()
    expect(second.getProject(project.id)?.status).toBe('designing')
  })

  it('broadcasts every mutation to /events subscribers', () => {
    const service = makeService()
    const payloads: number[] = []
    service.subscribe(payload => { payloads.push(payload.revision) })
    const project = service.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    service.reportDesignDone(project.id, '/w/plan.md', 'agent')
    expect(payloads).toEqual([1, 2, 3, 4])
  })

  it('parks stale designing projects into blocked when maxStaleMinutes elapses', () => {
    const service = makeService()
    service.setMaxStaleMinutes(1)
    const project = service.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    // 90 seconds later the stale check must park the project.
    vi.advanceTimersByTime(90_000)
    expect(service.getProject(project.id)?.status).toBe('blocked')
    expect(service.getProject(project.id)?.history.at(-1)?.actor).toBe('system')
  })

  it('never parks fresh projects and never parks done projects', () => {
    const service = makeService()
    service.setMaxStaleMinutes(1)
    const running = service.createProject({ title: 't', workspaceDir: '/w', goal: 'g' })
    const done = service.createProject({ title: 'd', workspaceDir: '/w', goal: 'g' })
    service.transition(done.id, 'done')
    // Fresh activity inside the window keeps the project alive.
    vi.advanceTimersByTime(30_000)
    service.transition(running.id, 'awaiting-review')
    service.transition(running.id, 'designing') // back into a stale-eligible state, but freshly active
    vi.advanceTimersByTime(30_000)
    expect(service.getProject(running.id)?.status).toBe('designing')
    expect(service.getProject(done.id)?.status).toBe('done')
  })
})
