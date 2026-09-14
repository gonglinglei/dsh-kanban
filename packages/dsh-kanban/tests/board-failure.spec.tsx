// @vitest-environment jsdom
/**
 * Failure observability and the human recovery entry (capability-gated): a
 * blocked leaf's card shows the failure chip and keeps「打开会话」reachable;
 * the recovery buttons («恢复» / «重新排队») exist only when the host declares
 * task-recovery, the requeue path asks for confirmation first, and a leaf
 * already awaiting a verdict shows「恢复判定中」instead of buttons.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FailureDiagnostic, Project, TaskNode } from '../src/protocol.ts'
import { CAPABILITY_TASK_RECOVERY } from '../src/protocol.ts'
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

/** The accident-shaped diagnostic: AUTH / HTTP 403 with turn + seq evidence. */
function failure(overrides: Partial<FailureDiagnostic> = {}): FailureDiagnostic {
  return {
    at: 1789026487696,
    cause: 'turn-end',
    message: "You've reached your 5-hour usage limit",
    reason: 'error',
    code: 'AUTH',
    status: 403,
    turn: 1,
    seq: 201,
    sessionId: 'session-task',
    recoverable: true,
    ...overrides,
  }
}

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
    status: 'blocked',
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

async function renderBoard(tasks: TaskNode[], capabilities: string[], projects: Project[] = [project()]): Promise<{ transport: FakeTransport; unmount(): void }> {
  const transport = new FakeTransport()
  transport.stateValue = { revision: 1, capabilities, projects, tasks }
  const store = new BoardStore(transport)
  await store.refresh()
  const root = createRoot(container)
  await act(async () => {
    root.render(<Board store={store} openSession={vi.fn()} getDefaultWorkspaceDir={() => ''} />)
  })
  return { transport, unmount: () => { act(() => { root.unmount() }) } }
}

/** The task leaf's card (the project card shares button labels like「详情」, so scope by the leaf title). */
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

/** Open the leaf's task detail from its card and confirm the switch happened. */
async function openTaskDetail(): Promise<void> {
  await act(async () => { cardButton(taskCard(), '详情')!.click() })
  expect(container.textContent, 'the task detail must render').toContain('标题路径')
}

/** The「最近失败」detail section (undefined when it was not rendered). */
function failureSection(): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('.dk-detail-section')]
    .find(section => section.querySelector('.dk-detail-heading')?.textContent === '最近失败')
}

describe('failure chip and the human recovery entry', () => {
  it('a blocked leaf with a session shows 恢复 and 打开会话, and 恢复 sends reinspect', async () => {
    const { transport, unmount } = await renderBoard([task()], [CAPABILITY_TASK_RECOVERY])
    const card = taskCard()
    expect(cardButton(card, '恢复')).toBeDefined()
    expect(cardButton(card, '打开会话'), 'the widened card entry must stay reachable').toBeDefined()
    expect(cardButton(card, '重新排队')).toBeUndefined()

    await act(async () => { cardButton(card, '恢复')!.click() })
    expect(transport.actions).toEqual([{ kind: 'recover-task', projectId: 'p1', taskId: 't1', strategy: 'reinspect' }])
    unmount()
  })

  it('an old host (no capability) gets neither 恢复 nor 重新排队, but keeps the read-only failure chip', async () => {
    const { transport, unmount } = await renderBoard([task({ lastFailure: failure() })], [])
    expect(cardButton(taskCard(), '恢复')).toBeUndefined()
    expect(cardButton(taskCard(), '重新排队')).toBeUndefined()
    // The chip and the session entry are read-side fields: they never gate on the capability.
    expect(taskCard().querySelector('.dk-card-failure')?.textContent).toContain('AUTH')
    expect(cardButton(taskCard(), '打开会话')).toBeDefined()
    expect(transport.actions).toEqual([])
    unmount()
  })

  it('a blocked leaf without a session shows 重新排队, gated by confirm', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const { transport, unmount } = await renderBoard([task({ sessionId: undefined })], [CAPABILITY_TASK_RECOVERY])
    expect(cardButton(taskCard(), '恢复')).toBeUndefined()
    const requeue = cardButton(taskCard(), '重新排队')
    expect(requeue).toBeDefined()

    confirm.mockReturnValue(false)
    await act(async () => { requeue!.click() })
    expect(confirm).toHaveBeenCalledOnce()
    expect(transport.actions, 'a cancelled confirm sends nothing').toEqual([])

    confirm.mockReturnValue(true)
    await act(async () => { requeue!.click() })
    expect(transport.actions).toEqual([{ kind: 'recover-task', projectId: 'p1', taskId: 't1', strategy: 'requeue' }])
    unmount()
  })

  it('renders the failure chip on the card and the full diagnostic in the detail 最近失败 section', async () => {
    const { unmount } = await renderBoard([task({ lastFailure: failure() })], [CAPABILITY_TASK_RECOVERY])
    const chip = taskCard().querySelector('.dk-card-failure')
    expect(chip?.textContent).toBe("⚠ AUTH (HTTP 403) · You've reached your 5-hour usage limit · [turn 1, seq 201]")
    expect(chip?.getAttribute('title')).toBe(chip?.textContent)

    await openTaskDetail()
    const section = failureSection()
    expect(section, 'the 最近失败 section must render').toBeDefined()
    expect(section!.textContent).toContain("You've reached your 5-hour usage limit")
    expect(section!.textContent).toContain('AUTH')
    expect(section!.textContent).toContain('403')
    expect(section!.textContent).toContain('201')
    expect(section!.textContent).toContain('session-task')
    expect(section!.textContent).toContain('该失败可能可恢复')
    unmount()
  })

  it('a message-only diagnostic renders no stray separators', async () => {
    const { unmount } = await renderBoard([task({ lastFailure: failure({ message: 'boom', code: undefined, status: undefined, turn: undefined, seq: undefined, sessionId: undefined, reason: undefined }) })], [])
    expect(taskCard().querySelector('.dk-card-failure')?.textContent).toBe('⚠ boom')
    unmount()
  })

  it('a leaf awaiting a recovery verdict shows 恢复判定中 and no recovery buttons', async () => {
    const { transport, unmount } = await renderBoard(
      [task({ recovery: { at: 2000, strategy: 'reinspect', sessionId: 'session-task' } })],
      [CAPABILITY_TASK_RECOVERY],
    )
    expect(taskCard().querySelector('.dk-card-recovering')?.textContent).toContain('恢复判定中')
    expect(cardButton(taskCard(), '恢复')).toBeUndefined()
    expect(cardButton(taskCard(), '重新排队')).toBeUndefined()

    await openTaskDetail()
    expect(container.textContent).toContain('恢复判定中')
    expect(button('重新判定并恢复')).toBeUndefined()
    expect(button('重新排队执行')).toBeUndefined()
    expect(transport.actions).toEqual([])
    unmount()
  })

  it('the detail view offers both strategies and requires confirm for requeue', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const { transport, unmount } = await renderBoard([task()], [CAPABILITY_TASK_RECOVERY])
    await openTaskDetail()
    expect(button('重新判定并恢复')).toBeDefined()
    const requeue = button('重新排队执行')
    expect(requeue).toBeDefined()

    await act(async () => { button('重新判定并恢复')!.click() })
    expect(transport.actions).toEqual([{ kind: 'recover-task', projectId: 'p1', taskId: 't1', strategy: 'reinspect' }])

    await act(async () => { requeue!.click() })
    expect(confirm).toHaveBeenCalledOnce()
    expect(transport.actions, 'a cancelled confirm sends nothing').toHaveLength(1)

    confirm.mockReturnValue(true)
    await act(async () => { requeue!.click() })
    expect(transport.actions).toHaveLength(2)
    expect(transport.actions[1]).toEqual({ kind: 'recover-task', projectId: 'p1', taskId: 't1', strategy: 'requeue' })
    unmount()
  })

  it('a blocked project carries the read-only chip and 最近失败 line, and no recovery buttons', async () => {
    const { transport, unmount } = await renderBoard(
      [],
      [CAPABILITY_TASK_RECOVERY],
      [project({ status: 'blocked', lastFailure: failure({ sessionId: undefined }) })],
    )
    const card = [...container.querySelectorAll<HTMLElement>('article.dk-card')]
      .find(candidate => candidate.querySelector('.dk-card-title')?.textContent === '看板重构')
    expect(card?.querySelector('.dk-card-failure')?.textContent).toContain('AUTH')
    expect(cardButton(card!, '恢复')).toBeUndefined()
    expect(cardButton(card!, '重新排队')).toBeUndefined()
    expect(transport.actions).toEqual([])
    unmount()
  })
})
