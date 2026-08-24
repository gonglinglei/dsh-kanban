// @vitest-environment jsdom
/**
 * The user-visible seam: the board must actually render in a DOM — six
 * columns, project cards with phase actions, and the new-project modal.
 * This is the regression guard for the white-screen defect (the store's
 * React-facing methods are extracted function references).
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, TaskNode } from '../src/protocol.ts'
import { Board } from '../src/client/board.tsx'
import { BoardStore } from '../src/client/store.ts'
import { isBoardOpen, toggleBoard } from '../src/client/view-state.ts'
import { FakeTransport } from './fake-transport.ts'

// Opt into React's act environment: every render/click in this suite is
// already wrapped in act; the flag turns the act(...) misuse warnings off.
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

function task(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 't1',
    projectId: 'p1',
    titlePath: '明确需求 > 确认数据来源',
    kind: 'clarify',
    status: 'awaiting-clarification',
    question: '数据源是什么？',
    dependencies: [],
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    history: [],
    ...overrides,
  }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: '看板重构',
    workspaceDir: '/tmp/w',
    goal: '把看板后端迁移到 SQLite',
    status: 'awaiting-review',
    version: 3,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    sessionId: 'session-abc',
    sessionRole: 'design',
    planPath: '/tmp/w/plan.md',
    history: [],
    ...overrides,
  }
}

/** Type a controlled input the way React sees it: through the native value setter (direct assignment bypasses React's value tracker). */
function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderBoard(store: BoardStore, openSession = vi.fn(), getDefaultWorkspaceDir = (): string => ''): Promise<() => void> {
  const root = createRoot(container)
  await act(async () => {
    root.render(<Board store={store} openSession={openSession} getDefaultWorkspaceDir={getDefaultWorkspaceDir} />)
  })
  return () => { act(() => { root.unmount() }) }
}

describe('Board rendering', () => {
  it('renders all six columns with project cards in their columns', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [
        project({ id: 'a', status: 'awaiting-review' }),
        project({ id: 'b', status: 'done', title: '已完成的项目' }),
        project({ id: 'c', status: 'executing', title: '执行中的项目' }),
      ],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    const text = container.textContent ?? ''
    for (const label of ['待开始', '设计中', '待确认', '执行中', '阻塞', '已完成']) {
      expect(text, `column ${label}`).toContain(label)
    }
    expect(text).toContain('看板重构')
    expect(text).toContain('已完成的项目')
    expect(text).toContain('执行中的项目')
    unmount()
  })

  it('shows confirm/reject actions on awaiting-review cards and a session chip elsewhere', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [
        project({ id: 'a', status: 'awaiting-review' }),
        project({ id: 'b', status: 'done' }),
      ],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    const text = container.textContent ?? ''
    expect(text).toContain('确认方案')
    expect(text).toContain('驳回')
    expect(text).toContain('打开会话')
    unmount()
  })

  it('confirm-click forwards the confirm-plan action to the store', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project({ id: 'a' })], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)

    const confirmButton = [...container.querySelectorAll('button')].find(button => button.textContent === '确认方案')
    expect(confirmButton).toBeDefined()
    await act(async () => { confirmButton!.click() })
    expect(transport.actions).toEqual([{ kind: 'confirm-plan', projectId: 'a' }])
  })

  it('opens the new-project modal and submits create-project with the form values', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store, vi.fn(), () => '/default/dir')

    const createButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('新建项目'))
    expect(createButton).toBeDefined()
    await act(async () => { createButton!.click() })

    const titleInput = container.querySelector<HTMLInputElement>('#dk-title')
    const dirInput = container.querySelector<HTMLInputElement>('#dk-workspace')
    const goalInput = container.querySelector<HTMLInputElement>('#dk-goal')
    expect(titleInput).toBeDefined()
    // The default workspace dir pre-fills from the wiring.
    expect(dirInput?.value).toBe('/default/dir')

    await act(async () => {
      typeInto(titleInput!, '新项目')
      typeInto(goalInput!, '做点事')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '创建并开始设计')
    expect(submit).toBeDefined()
    await act(async () => { submit!.click() })
    expect(transport.actions).toEqual([{
      kind: 'create-project',
      title: '新项目',
      workspaceDir: '/default/dir',
      goal: '做点事',
    }])
  })

  it('submitting an incomplete form shows visible validation feedback and forwards nothing', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    // The workspace default is empty: exactly the real-GUI case where the
    // workspaces list had not loaded yet when the modal opened.
    await renderBoard(store, vi.fn(), () => '')

    const createButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('新建项目'))
    await act(async () => { createButton!.click() })

    // The user fills only the title — the workspace dir stays empty.
    const titleInput = container.querySelector<HTMLInputElement>('#dk-title')
    await act(async () => {
      typeInto(titleInput!, '新项目')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '创建并开始设计')
    expect(submit, 'the submit must stay clickable').toBeDefined()
    await act(async () => { submit!.click() })

    // A disabled-look button would have swallowed the click silently; the
    // regression contract is: the click always lands and explains itself.
    expect(container.textContent).toContain('请填写项目名称、工作目录和目标')
    expect(transport.actions).toEqual([])
  })

  it('a failing session open shows a visible error on the card instead of staying silent', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project({ id: 'a', status: 'done' })], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    // The real runtime throws when the session is not in the current
    // workspace's list (sessions.select: unknown session); that must not be
    // a silent no-op on the board.
    const openSession = vi.fn(() => { throw new Error('sessions.select: unknown session session-x') })
    await renderBoard(store, openSession)

    const openButton = [...container.querySelectorAll('button')].find(button => button.textContent === '打开会话')
    expect(openButton).toBeDefined()
    await act(async () => { openButton!.click() })

    expect(container.textContent).toContain('无法打开会话')
    expect(container.textContent).toContain('unknown session')
  })

  it('a successful session open calls through and closes the board (the opened session must become visible)', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project({ id: 'a', status: 'done' })], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    const openSession = vi.fn()
    await renderBoard(store, openSession)
    await act(async () => { toggleBoard() })
    expect(isBoardOpen()).toBe(true)

    const openButton = [...container.querySelectorAll('button')].find(button => button.textContent === '打开会话')
    await act(async () => { openButton!.click() })
    expect(openSession).toHaveBeenCalledWith('session-abc')
    // Without this, the session opens behind the hidden conversation and the
    // click reads as dead — the reported defect.
    expect(isBoardOpen()).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-kanban-active')).toBe(false)
  })

  it('renders task leaves in their columns with kind badges and paths', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [project({ id: 'p1', status: 'executing' })],
      tasks: [
        task({ id: 't1', titlePath: '明确需求 > 确认数据来源', kind: 'clarify', status: 'awaiting-clarification', question: '数据源是什么？' }),
        task({ id: 't2', titlePath: '后端 > API 实现', kind: 'execute', status: 'executing', sessionId: 'session-x' }),
      ],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    const text = container.textContent ?? ''
    expect(text).toContain('待澄清')
    expect(text).toContain('确认数据来源')
    expect(text).toContain('明确需求')
    expect(text).toContain('数据源是什么？')
    expect(text).toContain('API 实现')
    expect(text).toContain('澄清')
    expect(text).toContain('执行')
    unmount()
  })

  it('answering a clarify leaf forwards answer-clarification', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [project({ id: 'p1', status: 'executing' })],
      tasks: [task({ id: 't1', status: 'awaiting-clarification' })],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
    expect(textarea).toBeDefined()
    await act(async () => {
      typeInto(textarea!, '本地 CSV 文件')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '提交回答')
    expect(submit).toBeDefined()
    await act(async () => { submit!.click() })
    expect(transport.actions).toEqual([{ kind: 'answer-clarification', projectId: 'p1', taskId: 't1', answer: '本地 CSV 文件' }])
  })

  it('a confirmed clarify leaf offers to confirm the answer; a confirmed design leaf offers to confirm the design', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [project({ id: 'p1', status: 'executing' })],
      tasks: [
        task({ id: 't1', status: 'awaiting-review', answer: '一百万以内' }),
        task({ id: 't2', titlePath: '架构设计', kind: 'design', status: 'awaiting-review' }),
      ],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)

    const text = container.textContent ?? ''
    expect(text).toContain('一百万以内')

    const confirmAnswer = [...container.querySelectorAll('button')].find(button => button.textContent === '确认回答')
    await act(async () => { confirmAnswer!.click() })
    expect(transport.actions).toEqual([{ kind: 'confirm-task', projectId: 'p1', taskId: 't1' }])

    const confirmDesign = [...container.querySelectorAll('button')].find(button => button.textContent === '确认设计')
    await act(async () => { confirmDesign!.click() })
    expect(transport.actions).toEqual([
      { kind: 'confirm-task', projectId: 'p1', taskId: 't1' },
      { kind: 'confirm-task', projectId: 'p1', taskId: 't2' },
    ])
  })

  it('rejects with feedback through the inline form', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project({ id: 'a' })], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)

    const rejectButton = [...container.querySelectorAll('button')].find(button => button.textContent === '驳回')
    await act(async () => { rejectButton!.click() })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
    expect(textarea).toBeDefined()
    await act(async () => {
      typeInto(textarea!, '方案太模糊')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '提交驳回')
    await act(async () => { submit!.click() })
    expect(transport.actions).toEqual([{ kind: 'reject-plan', projectId: 'a', feedback: '方案太模糊' }])
  })
})
