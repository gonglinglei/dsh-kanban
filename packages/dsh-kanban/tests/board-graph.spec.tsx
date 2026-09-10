// @vitest-environment jsdom
/**
 * The project-detail sub-task dependency-graph view: a「列表 / 依赖图」
 * switch on the「子任务」section heading. The graph defaults on when the
 * project has ≥ 2 task leaves and at least one dependency edge (one HTML
 * node card per task, one SVG bezier per edge, dependents left of their
 * blockers); clicking a node opens that task's detail; switching back to
 * the list restores the pre-existing rendering. Projects with no tasks or
 * no dependency edges default to the list.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, TaskNode } from '../src/protocol.ts'
import { Board } from '../src/client/board.tsx'
import { BoardStore } from '../src/client/store.ts'
import { isBoardOpen, toggleBoard } from '../src/client/view-state.ts'
import { FakeTransport } from './fake-transport.ts'

// ProjectDetail loads the plan artifact in an effect after mount; opt into
// React's act environment so those awaited updates don't warn.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  if (isBoardOpen()) toggleBoard()
})

afterEach(() => {
  document.body.innerHTML = ''
})

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: '看板重构',
    workspaceDir: '/tmp/w',
    goal: '把看板后端迁移到 SQLite',
    status: 'executing',
    version: 3,
    createdAt: 1000,
    updatedAt: 2000,
    lastActivityAt: 3000,
    planPath: undefined,
    history: [],
    ...overrides,
  }
}

function task(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 't1',
    projectId: 'p1',
    titlePath: '看板重构 > 任务甲',
    kind: 'execute',
    status: 'executing',
    dependencies: [],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    history: [],
    ...overrides,
  }
}

/** A diamond-shaped graph: t3 waits on t2 and t4, both of which wait on t1. */
function diamondTasks(): TaskNode[] {
  return [
    task({ id: 't1', titlePath: '看板重构 > 调研选型', kind: 'research', status: 'done' }),
    task({ id: 't2', titlePath: '看板重构 > 后端实现', status: 'executing', dependencies: ['t1'] }),
    task({ id: 't3', titlePath: '看板重构 > 前端集成', status: 'backlog', dependencies: ['t2', 't4'] }),
    task({ id: 't4', titlePath: '看板重构 > 方案设计', kind: 'design', status: 'blocked', dependencies: ['t1'] }),
  ]
}

async function renderBoard(store: BoardStore, openSession = vi.fn()): Promise<() => void> {
  const root = createRoot(container)
  await act(async () => {
    root.render(<Board store={store} openSession={openSession} getDefaultWorkspaceDir={() => ''} />)
  })
  return () => { act(() => { root.unmount() }) }
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === text)
  expect(found, `button「${text}」must exist`).toBeDefined()
  return found!
}

async function openDetail(): Promise<void> {
  const card = [...container.querySelectorAll<HTMLElement>('.dk-card')]
    .find(candidate => candidate.querySelector('.dk-kind-badge') === null)
  expect(card, 'a project card must exist').toBeDefined()
  const found = [...card!.querySelectorAll('button')].find(candidate => candidate.textContent === '详情')
  expect(found, 'the project card「详情」button must exist').toBeDefined()
  await act(async () => { found!.click() })
}

async function mountDetail(tasks: TaskNode[]): Promise<() => void> {
  const transport = new FakeTransport()
  transport.stateValue = { revision: 1, projects: [project()], tasks }
  const store = new BoardStore(transport)
  await store.refresh()
  const unmount = await renderBoard(store)
  await openDetail()
  return unmount
}

describe('Project detail dependency-graph view', () => {
  it('defaults to the graph view (with the view switch) when the project has dependency edges', async () => {
    const unmount = await mountDetail(diamondTasks())

    expect(container.querySelector('.dk-graph')).not.toBeNull()
    // The switch offers both views; the graph is the selected one.
    expect(button('列表').className).not.toContain('dk-btn-primary')
    expect(button('依赖图').className).toContain('dk-btn-primary')
    unmount()
  })

  it('renders one node card per task with its title and badges, and one edge per dependency', async () => {
    const unmount = await mountDetail(diamondTasks())

    const nodes = [...container.querySelectorAll<HTMLElement>('.dk-graph-node')]
    expect(nodes).toHaveLength(4)
    for (const title of ['调研选型', '后端实现', '前端集成', '方案设计']) {
      const node = nodes.find(candidate => candidate.querySelector('.dk-graph-node-title')?.textContent === title)
      expect(node, `a node titled「${title}」must exist`).toBeDefined()
      // Kind + status badges ride the shared labels.
      expect(node!.querySelectorAll('.dk-kind-badge').length).toBe(2)
      // The full titlePath is the hover tooltip.
      expect(node!.getAttribute('title')).toBe(`看板重构 > ${title}`)
    }
    expect(nodes.find(candidate => candidate.textContent?.includes('调研选型'))?.textContent).toContain('调研')
    expect(nodes.find(candidate => candidate.textContent?.includes('调研选型'))?.textContent).toContain('已完成')

    // 4 dependency edges: t2→t1, t3→t2, t3→t4, t4→t1.
    const edges = container.querySelectorAll('path.dk-graph-edge')
    expect(edges).toHaveLength(4)
    // Edges into the done task (t1) are weakened; the rest are not.
    expect(container.querySelectorAll('path.dk-graph-edge-done')).toHaveLength(2)
    // The blocked node carries the blocked modifier; the done node the done modifier.
    expect(container.querySelectorAll('.dk-graph-node-blocked')).toHaveLength(1)
    expect(container.querySelectorAll('.dk-graph-node-done')).toHaveLength(1)
    unmount()
  })

  it('clicking a node opens that task\'s detail and「返回项目」comes back to the graph', async () => {
    const unmount = await mountDetail(diamondTasks())

    const node = [...container.querySelectorAll<HTMLElement>('.dk-graph-node')]
      .find(candidate => candidate.querySelector('.dk-graph-node-title')?.textContent === '后端实现')!
    await act(async () => { node.click() })

    // The task detail view of t2 (title = last titlePath segment).
    expect(container.querySelector('.dk-title')?.textContent).toBe('后端实现')
    expect(container.textContent).toContain('看板重构 > 后端实现')

    await act(async () => { button('返回项目').click() })
    // Back on the project detail, still on the graph view.
    expect(container.querySelector('.dk-title')?.textContent).toBe('看板重构')
    expect(container.querySelector('.dk-graph')).not.toBeNull()
    unmount()
  })

  it('switching to「列表」restores the list rendering, and back', async () => {
    const unmount = await mountDetail(diamondTasks())
    expect(container.querySelector('.dk-graph')).not.toBeNull()

    await act(async () => { button('列表').click() })
    expect(container.querySelector('.dk-graph')).toBeNull()
    const rows = container.querySelectorAll('.dk-detail-task')
    expect(rows).toHaveLength(4)
    expect(container.textContent).toContain('看板重构 > 前端集成')
    expect(button('列表').className).toContain('dk-btn-primary')

    await act(async () => { button('依赖图').click() })
    expect(container.querySelector('.dk-graph')).not.toBeNull()
    expect(container.querySelectorAll('.dk-graph-node')).toHaveLength(4)
    unmount()
  })

  it('defaults to the list when no dependency edge exists, but the graph is still reachable', async () => {
    const unmount = await mountDetail([
      task({ id: 't1', titlePath: '看板重构 > 任务甲' }),
      task({ id: 't2', titlePath: '看板重构 > 任务乙' }),
    ])

    // Default: list (isolated tasks would make a structureless graph).
    expect(container.querySelector('.dk-graph')).toBeNull()
    expect(container.querySelectorAll('.dk-detail-task')).toHaveLength(2)
    expect(button('列表').className).toContain('dk-btn-primary')

    // The switch is still offered and the graph renders every node.
    await act(async () => { button('依赖图').click() })
    expect(container.querySelectorAll('.dk-graph-node')).toHaveLength(2)
    expect(container.querySelectorAll('path.dk-graph-edge')).toHaveLength(0)
    unmount()
  })

  it('shows no switch and no graph for a project without sub-tasks', async () => {
    const unmount = await mountDetail([])

    expect(container.querySelector('.dk-graph')).toBeNull()
    expect(container.textContent).toContain('尚无子任务')
    expect([...container.querySelectorAll('button')].some(candidate => candidate.textContent === '依赖图')).toBe(false)
    unmount()
  })

  it('a single task defaults to the list view', async () => {
    const unmount = await mountDetail([task({ id: 't1' })])

    expect(container.querySelector('.dk-graph')).toBeNull()
    expect(container.querySelectorAll('.dk-detail-task')).toHaveLength(1)
    unmount()
  })
})
