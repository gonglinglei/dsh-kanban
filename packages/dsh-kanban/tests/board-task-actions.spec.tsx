// @vitest-environment jsdom
/**
 * Task-level terminate/delete buttons (capability-gated): the task card and
 * the task detail show「终止」(only while a session may be live) and「删除」
 * (with a confirm dialog) only when the host declares
 * task-terminate-delete; a cancelled confirm sends nothing; a confirmed
 * delete from the detail view falls back to the board.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, TaskNode } from '../src/protocol.ts'
import { CAPABILITY_TASK_TERMINATE_DELETE } from '../src/protocol.ts'
import { Board } from '../src/client/board.tsx'
import { BoardStore } from '../src/client/store.ts'
import { isBoardOpen, toggleBoard } from '../src/client/view-state.ts'
import { FakeTransport } from './fake-transport.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
    title: '看板重构',
    workspaceDir: '/tmp/w',
    goal: 'g',
    status: 'executing',
    version: 0,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    history: [],
    ...overrides,
  }
}

function task(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 't1',
    projectId: 'p1',
    titlePath: '看板重构 > 编码实现',
    kind: 'execute',
    status: 'executing',
    dependencies: [],
    version: 0,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    sessionId: 'session-task',
    history: [],
    ...overrides,
  }
}

async function renderBoard(tasks: TaskNode[], capabilities: string[]): Promise<{ transport: FakeTransport; unmount(): void }> {
  const transport = new FakeTransport()
  transport.stateValue = { revision: 1, capabilities, projects: [project()], tasks }
  const store = new BoardStore(transport)
  await store.refresh()
  const root = createRoot(container)
  await act(async () => {
    root.render(<Board store={store} openSession={vi.fn()} getDefaultWorkspaceDir={() => ''} />)
  })
  return { transport, unmount: () => { act(() => { root.unmount() }) } }
}

/** The task leaf's card (the project card shares button labels like「删除」, so scope by the leaf title). */
function taskCard(): HTMLElement {
  const card = [...container.querySelectorAll<HTMLElement>('article.dk-card')]
    .find(candidate => candidate.querySelector('.dk-card-title')?.textContent === '编码实现')
  expect(card, 'the task card must render').toBeDefined()
  return card!
}

function cardButton(card: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...card.querySelectorAll('button')].find(candidate => candidate.textContent === label)
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
}

describe('task terminate/delete buttons', () => {
  it('an executing task card shows 终止 and 删除 when the host declares the capability', async () => {
    const { transport, unmount } = await renderBoard([task()], [CAPABILITY_TASK_TERMINATE_DELETE])
    await act(async () => { cardButton(taskCard(), '终止')!.click() })
    expect(transport.actions).toEqual([{ kind: 'terminate-task', projectId: 'p1', taskId: 't1' }])
    expect(cardButton(taskCard(), '删除')).toBeDefined()
    unmount()
  })

  it('a done task card shows 删除 but no 终止 (no live session to stop)', async () => {
    const { unmount } = await renderBoard([task({ status: 'done' })], [CAPABILITY_TASK_TERMINATE_DELETE])
    expect(cardButton(taskCard(), '删除')).toBeDefined()
    expect(cardButton(taskCard(), '终止')).toBeUndefined()
    unmount()
  })

  it('an old host (no capability) gets neither button on the task card', async () => {
    const { unmount } = await renderBoard([task()], [])
    expect(cardButton(taskCard(), '终止')).toBeUndefined()
    expect(cardButton(taskCard(), '删除')).toBeUndefined()
    unmount()
  })

  it('a cancelled confirm sends nothing; a confirmed delete sends the delete-task envelope', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const { transport, unmount } = await renderBoard([task()], [CAPABILITY_TASK_TERMINATE_DELETE])
    await act(async () => { cardButton(taskCard(), '删除')!.click() })
    expect(confirm).toHaveBeenCalledOnce()
    expect(transport.actions).toEqual([])

    confirm.mockReturnValue(true)
    await act(async () => { cardButton(taskCard(), '删除')!.click() })
    expect(transport.actions).toEqual([{ kind: 'delete-task', projectId: 'p1', taskId: 't1' }])
    unmount()
  })

  it('the task detail offers both buttons; a confirmed delete falls back to the board', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const { transport, unmount } = await renderBoard([task()], [CAPABILITY_TASK_TERMINATE_DELETE])
    // Open the task detail from the task card (not the project card).
    await act(async () => { cardButton(taskCard(), '详情')!.click() })
    expect(container.textContent).toContain('标题路径') // task-detail-only field
    expect(button('终止')).toBeDefined()
    expect(button('删除')).toBeDefined()

    await act(async () => { button('删除')!.click() })
    expect(transport.actions).toEqual([{ kind: 'delete-task', projectId: 'p1', taskId: 't1' }])
    expect(container.textContent, 'the detail view closed after the delete').not.toContain('标题路径')
    unmount()
  })
})
