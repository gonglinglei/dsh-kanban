// @vitest-environment jsdom
/**
 * The board's「废弃该请求」entry and the mixed healthy/broken request state.
 *
 * Two contracts:
 *  - the exit is strictly capability-gated (`additions-discard` is a LATER
 *    token than `late-task-additions`, so a host may show the badge and still
 *    not understand the discard action) — on such a host the malformed chip
 *    stays a disabled explanation instead of a dead button;
 *  - a broken batch is visible NEXT TO the healthy ones, so a human never
 *    discards the good request believing it was the broken one.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingAddition, Project, TaskNode } from '../src/protocol.ts'
import { CAPABILITY_ADDITIONS_DISCARD, CAPABILITY_LATE_TASK_ADDITIONS } from '../src/protocol.ts'
import { Board } from '../src/client/board.tsx'
import { BoardStore } from '../src/client/store.ts'
import { isBoardOpen, toggleBoard } from '../src/client/view-state.ts'
import { FakeTransport } from './fake-transport.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BOTH_CAPABILITIES = [CAPABILITY_LATE_TASK_ADDITIONS, CAPABILITY_ADDITIONS_DISCARD]

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
    count: 1,
    items: [{ titlePath: '补充测试', kind: 'execute' }],
    ...overrides,
  }
}

async function renderBoard(options: {
  capabilities?: string[]
  pendingAdditions?: PendingAddition[]
  tasks?: TaskNode[]
} = {}): Promise<{ transport: FakeTransport; unmount(): void }> {
  const transport = new FakeTransport()
  transport.stateValue = {
    revision: 1,
    projects: [project()],
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

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
}

async function openDetail(): Promise<void> {
  await act(async () => { button('详情')!.click() })
  expect(container.textContent).toContain('待处理的新增任务请求')
}

describe('board discard entry (capability gated)', () => {
  it('offers 废弃该请求 next to 物化到看板 when the host declares the discard capability', async () => {
    const { unmount } = await renderBoard({ capabilities: BOTH_CAPABILITIES, pendingAdditions: [pending()] })
    expect(button('物化到看板')).toBeDefined()
    expect(button('废弃该请求')).toBeDefined()
    unmount()
  })

  it('hides the discard entry on a host that only declares late-task-additions', async () => {
    const { unmount } = await renderBoard({ capabilities: [CAPABILITY_LATE_TASK_ADDITIONS], pendingAdditions: [pending()] })
    expect(button('物化到看板')).toBeDefined()
    expect(button('废弃该请求')).toBeUndefined()
    unmount()
  })

  it('sends discard-additions after a confirmation that spells out the rename', async () => {
    const dismiss = vi.fn((_text: string) => true)
    vi.stubGlobal('confirm', dismiss)
    const { transport, unmount } = await renderBoard({ capabilities: BOTH_CAPABILITIES, pendingAdditions: [pending()] })

    await act(async () => { button('废弃该请求')!.click() })
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(String(dismiss.mock.calls[0]![0])).toContain('废弃「代码开源审查」的 1 项新增任务（1 个请求文件）')
    expect(String(dismiss.mock.calls[0]![0])).toContain('*.discarded.json')
    expect(String(dismiss.mock.calls[0]![0])).toContain('不会再物化到看板')
    expect(transport.actions).toEqual([{ kind: 'discard-additions', projectId: 'p1' }])
    unmount()
  })

  it('sends nothing when the human cancels', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const { transport, unmount } = await renderBoard({ capabilities: BOTH_CAPABILITIES, pendingAdditions: [pending()] })
    await act(async () => { button('废弃该请求')!.click() })
    expect(transport.actions).toEqual([])
    unmount()
  })
})

describe('board malformed request entries', () => {
  it('replaces the dead disabled chip with the discard exit when the capability is there', async () => {
    const { unmount } = await renderBoard({
      capabilities: BOTH_CAPABILITIES,
      pendingAdditions: [pending({ state: 'malformed', count: 0, items: undefined, error: 'Unexpected token' })],
    })
    expect(container.querySelector('.dk-card-pending-error')?.textContent).toBe('⚠ 待处理的新增任务请求无法解析')
    expect(button('废弃该请求')).toBeDefined()
    expect(button('无法物化（请求格式错误）')).toBeUndefined()
    expect(button('物化到看板')).toBeUndefined()
    unmount()
  })

  it('keeps the disabled explanation on an older host (no dead button)', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [pending({ state: 'malformed', count: 0, items: undefined, error: 'Unexpected token' })],
    })
    expect(button('废弃该请求')).toBeUndefined()
    expect(button('无法物化（请求格式错误）')?.disabled).toBe(true)
    unmount()
  })

  it('discards a malformed request from the card (count in the prompt counts files, not leaves)', async () => {
    const dismiss = vi.fn((_text: string) => true)
    vi.stubGlobal('confirm', dismiss)
    const { transport, unmount } = await renderBoard({
      capabilities: BOTH_CAPABILITIES,
      pendingAdditions: [pending({ state: 'malformed', count: 0, items: undefined, error: 'Unexpected token', batches: 2 })],
    })

    await act(async () => { button('废弃该请求')!.click() })
    expect(String(dismiss.mock.calls[0]![0])).toContain('2 个请求文件')
    expect(transport.actions).toEqual([{ kind: 'discard-additions', projectId: 'p1' }])
    unmount()
  })

  it('shows the broken batch NEXT TO the healthy one instead of hiding either', async () => {
    const { unmount } = await renderBoard({
      capabilities: BOTH_CAPABILITIES,
      pendingAdditions: [pending({
        count: 1,
        batches: 2,
        malformed: [{ file: 'tasks-additions.json', at: 1789038259000, error: 'Unexpected token <' }],
      })],
    })
    const chip = container.querySelector('.dk-card-pending')
    expect(chip?.textContent).toBe('⏳ 待处理的新增任务请求（1 项）（2 个批次）')
    const problem = container.querySelector('.dk-card-pending-error')
    expect(problem?.textContent).toBe('⚠ 1 个请求无法解析（tasks-additions.json）')
    expect(problem?.getAttribute('title')).toContain('tasks-additions.json：Unexpected token <')
    // Both entries stay reachable: materialize the healthy batch, discard the rest.
    expect(button('物化到看板')).toBeDefined()
    expect(button('废弃该请求')).toBeDefined()
    unmount()
  })
})

describe('project detail pending section details', () => {
  it('lists every broken file with its own reason and the discard exit', async () => {
    const { unmount } = await renderBoard({
      capabilities: BOTH_CAPABILITIES,
      pendingAdditions: [pending({
        count: 1,
        batches: 2,
        malformed: [{ file: 'tasks-additions.json', at: 1789038259000, error: 'Unexpected token <' }],
      })],
    })
    await openDetail()
    expect(container.textContent).toContain('共 1 项')
    expect(container.textContent).toContain('tasks-additions.json 无法解析：Unexpected token <')
    expect(container.textContent).toContain('无法解析的请求不会被物化')
    expect(button('物化到看板')).toBeDefined()
    expect(button('废弃该请求')).toBeDefined()
    unmount()
  })

  it('tells the human where the exit is when the host cannot discard', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_LATE_TASK_ADDITIONS],
      pendingAdditions: [pending({ state: 'malformed', count: 0, items: undefined, error: 'Unexpected token' })],
    })
    await openDetail()
    expect(container.textContent).toContain('当前 host 不支持在看板上废弃，只能人工改文件')
    expect(button('无法物化（请求格式错误）')?.disabled).toBe(true)
    unmount()
  })
})
