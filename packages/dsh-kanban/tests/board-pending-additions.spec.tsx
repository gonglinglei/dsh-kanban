// @vitest-environment jsdom
/**
 * The board's「⏳ 待处理的新增任务请求」badge and「物化到看板」entry.
 *
 * The entry is strictly double-gated (capability AND a non-empty assembly
 * field): an old host would 400 `materialize-additions`, and a pre-handshake
 * host must not even be asked. A malformed request is visible but not
 * clickable, and the detail view lists what would be materialized.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingAddition, Project, TaskNode } from '../src/protocol.ts'
import { CAPABILITY_LATE_TASK_ADDITIONS } from '../src/protocol.ts'
import { Board } from '../src/client/board.tsx'
import { BoardStore } from '../src/client/store.ts'
import { isBoardOpen, toggleBoard } from '../src/client/view-state.ts'
import { FakeTransport } from './fake-transport.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  if (isBoardOpen()) toggleBoard()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: '代码开源审查',
    workspaceDir: '/tmp/w',
    goal: '审查当前项目如果要开源还有哪些必要的工作',
    status: 'done',
    version: 0,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    history: [],
    ...overrides,
  }
}

function pending(overrides: Partial<PendingAddition> = {}): PendingAddition {
  return {
    projectId: 'p1',
    file: 'tasks-additions.1789038258000.pending.json',
    at: 1789038258000,
    state: 'ready',
    batches: 1,
    count: 4,
    items: [
      { titlePath: '补齐 CONTRIBUTING 等社区文档', kind: 'execute' },
      { titlePath: '加 GH Actions CI 与模板', kind: 'execute' },
      { titlePath: 'repro 测试脱敏改名', kind: 'execute' },
      { titlePath: '提供英文 README', kind: 'execute' },
    ],
    ...overrides,
  }
}

async function renderBoard(options: {
  capabilities?: string[]
  pendingAdditions?: PendingAddition[]
  project?: Partial<Project>
  tasks?: TaskNode[]
} = {}): Promise<{ transport: FakeTransport; unmount(): void }> {
  const transport = new FakeTransport()
  transport.stateValue = {
    revision: 1,
    projects: [project(options.project)],
    tasks: options.tasks ?? [],
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.pendingAdditions === undefined ? {} : { pendingAdditions: options.pendingAdditions }),
  }
  const store = new BoardStore(transport)
  await store.refresh()
  const root = createRoot(container)
  await act(async () => {
    root.render(<Board store={store} openSession={vi.fn()} getDefaultWorkspaceDir={() => ''} />)
  })
  return { transport, unmount: () => { act(() => { root.unmount() }) } }
}

function badge(): HTMLElement | undefined {
  return container.querySelector<HTMLElement>('.dk-card-pending, .dk-card-pending-error') ?? undefined
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
}

async function openDetail(): Promise<void> {
  await act(async () => { button('详情')!.click() })
  expect(container.textContent).toContain('待处理的新增任务请求')
}

describe('board pending task-additions badge', () => {
  it('renders the badge and the materialize entry when the host declares the capability', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [pending()],
    })
    expect(badge()?.textContent).toBe('⏳ 待处理的新增任务请求（4 项）')
    expect(badge()?.className).toBe('dk-card-pending')
    expect(button('物化到看板')).toBeDefined()
    unmount()
  })

  it('spells out the batch count when several requests are waiting', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [pending({ batches: 2, count: 6 })],
    })
    expect(badge()?.textContent).toBe('⏳ 待处理的新增任务请求（6 项）（2 个批次）')
    unmount()
  })

  it('renders nothing on an old host (capability missing) even if the field is present', async () => {
    const { unmount } = await renderBoard({
      capabilities: ['task-recovery'],
      pendingAdditions: [pending()],
    })
    expect(badge()).toBeUndefined()
    expect(button('物化到看板')).toBeUndefined()
    unmount()
  })

  it('renders nothing on a pre-handshake host (capabilities undefined)', async () => {
    const { unmount } = await renderBoard({ pendingAdditions: [pending()] })
    expect(badge()).toBeUndefined()
    expect(button('物化到看板')).toBeUndefined()
    unmount()
  })

  it('renders nothing when the assembly field exists but is empty', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [],
    })
    expect(badge()).toBeUndefined()
    expect(button('物化到看板')).toBeUndefined()
    unmount()
  })

  it('shows a malformed request as an error chip with a disabled entry', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [pending({ state: 'malformed', count: 0, items: undefined, error: 'Unexpected token' })],
    })
    expect(badge()?.textContent).toBe('⚠ 待处理的新增任务请求无法解析')
    expect(badge()?.className).toBe('dk-card-pending-error')
    const disabled = button('无法物化（请求格式错误）')
    expect(disabled).toBeDefined()
    expect(disabled!.disabled).toBe(true)
    expect(button('物化到看板')).toBeUndefined()
    unmount()
  })
})

describe('board pending task-additions entry', () => {
  it('asks for confirmation, then sends the action', async () => {
    const dismiss = vi.fn((_text: string) => true)
    vi.stubGlobal('confirm', dismiss)
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [pending()],
    })

    await act(async () => { button('物化到看板')!.click() })
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(String(dismiss.mock.calls[0]![0])).toContain('物化「代码开源审查」的 4 项新增任务到看板')
    expect(String(dismiss.mock.calls[0]![0])).toContain('立即为其中 4 个执行叶子拉起会话')
    expect(transport.actions).toEqual([{ kind: 'materialize-additions', projectId: 'p1' }])
    unmount()
  })

  it('sends nothing when the human cancels the confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [pending()],
    })

    await act(async () => { button('物化到看板')!.click() })
    expect(transport.actions).toEqual([])
    unmount()
  })
})

describe('project detail pending section', () => {
  it('lists the requested leaves with their kind labels and the source file', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [pending()],
    })
    await openDetail()
    expect(container.textContent).toContain('来源 tasks-additions.1789038258000.pending.json')
    expect(container.textContent).toContain('共 4 项')
    expect(container.textContent).toContain('补齐 CONTRIBUTING 等社区文档')
    expect(container.textContent).toContain('提供英文 README')
    // The kind badge is rendered from the shared label table.
    expect([...container.querySelectorAll('.dk-kind-badge')].some(node => node.textContent === '执行')).toBe(true)
    unmount()
  })

  it('collapses the preview past its bound and says how many are hidden', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [pending({
        count: 5,
        items: [
          { titlePath: '甲', kind: 'execute' },
          { titlePath: '乙', kind: 'execute' },
          { titlePath: '丙', kind: 'execute' },
        ],
      })],
    })
    await openDetail()
    expect(container.textContent).toContain('共 5 项')
    expect(container.textContent).toContain('…另有 2 项未展开')
    unmount()
  })

  it('explains a malformed request instead of offering the entry', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [pending({ state: 'malformed', count: 0, items: undefined, error: 'Unexpected token <' })],
    })
    await openDetail()
    expect(container.textContent).toContain('⚠ 无法解析：Unexpected token <')
    expect(button('无法物化（请求格式错误）')?.disabled).toBe(true)
    unmount()
  })
})
