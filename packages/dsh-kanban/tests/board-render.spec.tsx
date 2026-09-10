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
import { CAPABILITY_LONG_RUNNING_PROJECTS, CAPABILITY_PARENT_WORKSPACE_INHERITANCE } from '../src/protocol.ts'
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
  localStorage.clear()
})

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
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

/** Pick a <select> option the way React sees it: through the native value setter. */
function selectOption(element: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Open the new-project modal (the header「+ 新建项目」button). */
async function openModal(): Promise<void> {
  const createButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('新建项目'))
  expect(createButton, 'the「+ 新建项目」button must exist').toBeDefined()
  await act(async () => { createButton!.click() })
}

describe('Long-running projects and affiliation', () => {
  it('the new-project modal defaults to one-shot and offers only long-running projects as parents', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      capabilities: [CAPABILITY_LONG_RUNNING_PROJECTS],
      projects: [
        project({ id: 'lp1', title: '长期主线', status: 'executing', lifecycle: 'long-running', sessionId: undefined }),
        project({ id: 'os1', title: '普通项目', status: 'executing' }),
      ],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    // A capable host shows no version-mismatch banner.
    expect(container.querySelector('.dk-banner')).toBeNull()
    await openModal()

    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="dk-lifecycle"]')]
    expect(radios).toHaveLength(2)
    expect(radios[0].checked, 'one-shot is the default').toBe(true)
    expect(container.textContent).toContain('一次性项目')
    expect(container.textContent).toContain('长期执行中的项目')

    // The parent select lists only long-running projects, never one-shot ones.
    const select = container.querySelector<HTMLSelectElement>('#dk-parent')
    expect(select, 'the parent select is visible for a one-shot project').not.toBeNull()
    const optionTexts = [...select!.querySelectorAll('option')].map(option => option.textContent)
    expect(optionTexts).toEqual(['不关联', '长期主线'])
    // One-shot keeps the design-relay submit label.
    expect([...container.querySelectorAll('button')].some(button => button.textContent === '创建并开始设计')).toBe(true)
    unmount()
  })

  it('choosing a parent forwards parentId with the create-project action', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      capabilities: [CAPABILITY_LONG_RUNNING_PROJECTS],
      projects: [project({ id: 'lp1', title: '长期主线', status: 'executing', lifecycle: 'long-running', sessionId: undefined })],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)
    await openModal()
    await act(async () => {
      typeInto(container.querySelector<HTMLInputElement>('#dk-title')!, '子项目')
      typeInto(container.querySelector<HTMLInputElement>('#dk-workspace')!, '/path/child')
      typeInto(container.querySelector<HTMLInputElement>('#dk-goal')!, '具体一件事')
      selectOption(container.querySelector<HTMLSelectElement>('#dk-parent')!, 'lp1')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '创建并开始设计')
    await act(async () => { submit!.click() })
    expect(transport.actions).toEqual([{
      kind: 'create-project',
      title: '子项目',
      workspaceDir: '/path/child',
      goal: '具体一件事',
      parentId: 'lp1',
    }])
  })

  it('selecting the long-running type hides the parent select and submits lifecycle: long-running', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      capabilities: [CAPABILITY_LONG_RUNNING_PROJECTS],
      projects: [project({ id: 'lp1', title: '长期主线', status: 'executing', lifecycle: 'long-running', sessionId: undefined })],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)
    await openModal()

    // Switch to the long-running type (the second radio).
    const longRunningRadio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="dk-lifecycle"]')][1]
    await act(async () => { longRunningRadio.click() })
    expect(longRunningRadio.checked).toBe(true)
    // Affiliation is one-shot-only: the select disappears (no nesting).
    expect(container.querySelector('#dk-parent')).toBeNull()
    expect([...container.querySelectorAll('button')].some(button => button.textContent === '创建长期项目')).toBe(true)

    await act(async () => {
      typeInto(container.querySelector<HTMLInputElement>('#dk-title')!, '新主线')
      typeInto(container.querySelector<HTMLInputElement>('#dk-workspace')!, '/path/main')
      typeInto(container.querySelector<HTMLInputElement>('#dk-goal')!, '持续演进')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '创建长期项目')
    await act(async () => { submit!.click() })
    // No parentId key even though a long-running project exists on the board.
    expect(transport.actions).toEqual([{
      kind: 'create-project',
      title: '新主线',
      workspaceDir: '/path/main',
      goal: '持续演进',
      lifecycle: 'long-running',
    }])
  })

  it('cards show the 长期 badge on long-running projects and a 隶属于 line on affiliated children', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      capabilities: [CAPABILITY_LONG_RUNNING_PROJECTS],
      projects: [
        project({ id: 'lp1', title: '长期主线', status: 'executing', lifecycle: 'long-running', sessionId: undefined }),
        project({ id: 'c1', title: '子项目甲', status: 'executing', parentId: 'lp1', sessionId: undefined }),
        project({ id: 'c2', title: '孤儿项目', status: 'executing', parentId: 'gone', sessionId: undefined }),
        project({ id: 'os1', title: '普通项目', status: 'executing' }),
      ],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    const cards = [...container.querySelectorAll<HTMLElement>('.dk-card')]
    const longCard = cards.find(card => card.textContent?.includes('长期主线'))
    expect(longCard?.querySelector('.dk-card-title .dk-kind-badge')?.textContent).toBe('长期')

    const childCard = cards.find(card => card.textContent?.includes('子项目甲'))
    expect(childCard?.querySelector('.dk-card-parent')?.textContent).toBe('隶属于 长期主线')

    const orphanCard = cards.find(card => card.textContent?.includes('孤儿项目'))
    expect(orphanCard?.querySelector('.dk-card-parent')?.textContent).toBe('隶属于 （父项目已删除）')

    const plainCard = cards.find(card => card.textContent?.includes('普通项目'))
    expect(plainCard?.querySelector('.dk-card-title .dk-kind-badge')).toBeNull()
    expect(plainCard?.querySelector('.dk-card-parent')).toBeNull()
    unmount()
  })

  it('a snapshot without capabilities (old host) hides the long-running UI and shows the restart banner', async () => {
    const transport = new FakeTransport()
    // No `capabilities` key at all: exactly what a pre-handshake host serves.
    transport.stateValue = {
      revision: 1,
      projects: [project({ id: 'lp1', title: '长期主线', status: 'executing', lifecycle: 'long-running', sessionId: undefined })],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    // The board-top banner explains why the long-running entry is gone.
    expect(container.querySelector('.dk-banner')?.textContent)
      .toContain('看板 host 版本过旧，不支持长期项目；请重启 DSH 后刷新页面')

    await openModal()
    // No「项目类型」radio row — the modal can only submit a one-shot create.
    expect(container.querySelectorAll('input[type="radio"][name="dk-lifecycle"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('长期执行中的项目')
    // The affiliation select is hidden too (old hosts never learned parentId either).
    expect(container.querySelector('#dk-parent')).toBeNull()
    expect([...container.querySelectorAll('button')].some(button => button.textContent === '创建长期项目')).toBe(false)

    // The forced one-shot path still submits cleanly, byte-identical to a
    // pre-feature create (no lifecycle / parentId keys).
    await act(async () => {
      typeInto(container.querySelector<HTMLInputElement>('#dk-title')!, '普通项目')
      typeInto(container.querySelector<HTMLInputElement>('#dk-workspace')!, '/path/os')
      typeInto(container.querySelector<HTMLInputElement>('#dk-goal')!, '一件事')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '创建并开始设计')
    expect(submit, 'the one-shot submit stays available on an old host').toBeDefined()
    await act(async () => { submit!.click() })
    expect(transport.actions).toEqual([{
      kind: 'create-project',
      title: '普通项目',
      workspaceDir: '/path/os',
      goal: '一件事',
    }])
    unmount()
  })
})

describe('Parent workspace inheritance', () => {
  const CAPABLE = [CAPABILITY_LONG_RUNNING_PROJECTS, CAPABILITY_PARENT_WORKSPACE_INHERITANCE]

  it('selecting a parent hides the dir input, shows the inheritance hint, and submits without workspaceDir', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      capabilities: CAPABLE,
      projects: [project({ id: 'lp1', title: '长期主线', status: 'executing', lifecycle: 'long-running', workspaceDir: '/parent/dir', sessionId: undefined })],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)
    await openModal()

    // Before affiliation the editable input is there and required.
    expect(container.querySelector<HTMLInputElement>('#dk-workspace')).not.toBeNull()
    await act(async () => {
      selectOption(container.querySelector<HTMLSelectElement>('#dk-parent')!, 'lp1')
    })
    // The input is replaced by the read-only inheritance hint.
    expect(container.querySelector('#dk-workspace')).toBeNull()
    expect(container.textContent).toContain('将使用父项目的目录')
    expect(container.textContent).toContain('/parent/dir')

    await act(async () => {
      typeInto(container.querySelector<HTMLInputElement>('#dk-title')!, '子项目')
      typeInto(container.querySelector<HTMLInputElement>('#dk-goal')!, '具体一件事')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '创建并开始设计')
    await act(async () => { submit!.click() })
    // No workspaceDir key at all: the host inherits it from the parent.
    expect(transport.actions).toEqual([{
      kind: 'create-project',
      title: '子项目',
      goal: '具体一件事',
      parentId: 'lp1',
    }])
    // The inherited value must not clobber the hand-picked-dir memory.
    expect(localStorage.getItem('dsh-kanban:last-workspace-dir')).toBeNull()
  })

  it('deselecting the parent brings the required dir input back', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      capabilities: CAPABLE,
      projects: [project({ id: 'lp1', title: '长期主线', status: 'executing', lifecycle: 'long-running', workspaceDir: '/parent/dir', sessionId: undefined })],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)
    await openModal()
    await act(async () => {
      selectOption(container.querySelector<HTMLSelectElement>('#dk-parent')!, 'lp1')
    })
    expect(container.querySelector('#dk-workspace')).toBeNull()
    await act(async () => {
      selectOption(container.querySelector<HTMLSelectElement>('#dk-parent')!, '')
    })
    expect(container.querySelector<HTMLInputElement>('#dk-workspace')).not.toBeNull()

    // The standalone submit still requires the dir and keeps remembering it.
    await act(async () => {
      typeInto(container.querySelector<HTMLInputElement>('#dk-title')!, '独立项目')
      typeInto(container.querySelector<HTMLInputElement>('#dk-workspace')!, '/path/os')
      typeInto(container.querySelector<HTMLInputElement>('#dk-goal')!, '一件事')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '创建并开始设计')
    await act(async () => { submit!.click() })
    expect(transport.actions).toEqual([{
      kind: 'create-project',
      title: '独立项目',
      workspaceDir: '/path/os',
      goal: '一件事',
    }])
    expect(localStorage.getItem('dsh-kanban:last-workspace-dir')).toBe('/path/os')
  })

  it('an inheritance-incapable host falls back to pre-filling the (editable) parent dir', async () => {
    const transport = new FakeTransport()
    // Long-running-capable but pre-inheritance: the intermediate host build.
    transport.stateValue = {
      revision: 1,
      capabilities: [CAPABILITY_LONG_RUNNING_PROJECTS],
      projects: [project({ id: 'lp1', title: '长期主线', status: 'executing', lifecycle: 'long-running', workspaceDir: '/parent/dir', sessionId: undefined })],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)
    await openModal()

    await act(async () => {
      selectOption(container.querySelector<HTMLSelectElement>('#dk-parent')!, 'lp1')
    })
    // The input stays visible and is pre-filled with the parent's directory.
    const dirInput = container.querySelector<HTMLInputElement>('#dk-workspace')
    expect(dirInput).not.toBeNull()
    expect(dirInput!.value).toBe('/parent/dir')
    expect(container.textContent).not.toContain('将使用父项目的目录')

    await act(async () => {
      typeInto(container.querySelector<HTMLInputElement>('#dk-title')!, '子项目')
      typeInto(container.querySelector<HTMLInputElement>('#dk-goal')!, '具体一件事')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '创建并开始设计')
    await act(async () => { submit!.click() })
    // Old-protocol submit: the dir rides along explicitly, nothing breaks.
    expect(transport.actions).toEqual([{
      kind: 'create-project',
      title: '子项目',
      workspaceDir: '/parent/dir',
      goal: '具体一件事',
      parentId: 'lp1',
    }])
  })
})

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

  it('remembers the submitted workspace dir in localStorage after a successful create', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)

    const createButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('新建项目'))
    await act(async () => { createButton!.click() })
    await act(async () => {
      typeInto(container.querySelector<HTMLInputElement>('#dk-title')!, '新项目')
      typeInto(container.querySelector<HTMLInputElement>('#dk-workspace')!, '/path/a')
      typeInto(container.querySelector<HTMLInputElement>('#dk-goal')!, '做点事')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '创建并开始设计')
    await act(async () => { submit!.click() })

    expect(store.getError()).toBeNull()
    expect(localStorage.getItem('dsh-kanban:last-workspace-dir')).toBe('/path/a')
  })

  it('does not remember the workspace dir when the host rejects the create', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [], tasks: [] }
    transport.failAction = true
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)

    const createButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('新建项目'))
    await act(async () => { createButton!.click() })
    await act(async () => {
      typeInto(container.querySelector<HTMLInputElement>('#dk-title')!, '新项目')
      typeInto(container.querySelector<HTMLInputElement>('#dk-workspace')!, '/path/bad')
      typeInto(container.querySelector<HTMLInputElement>('#dk-goal')!, '做点事')
    })
    const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '创建并开始设计')
    await act(async () => { submit!.click() })

    expect(store.getError()).not.toBeNull()
    expect(localStorage.getItem('dsh-kanban:last-workspace-dir')).toBeNull()
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

  it('a task-card session open calls through and closes the board, same as the project card', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      // The project carries no session of its own, so the only 打开会话
      // button in the column is the task card's.
      projects: [project({ id: 'p1', status: 'executing', sessionId: undefined })],
      tasks: [task({ id: 't1', titlePath: '后端 > API 实现', kind: 'execute', status: 'executing', sessionId: 'session-task' })],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const openSession = vi.fn()
    await renderBoard(store, openSession)
    await act(async () => { toggleBoard() })
    expect(isBoardOpen()).toBe(true)

    const openButton = [...container.querySelectorAll('button')].find(button => button.textContent === '打开会话')
    expect(openButton).toBeDefined()
    await act(async () => { openButton!.click() })
    expect(openSession).toHaveBeenCalledWith('session-task')
    // The regression: the task card used to leave the board covering the
    // freshly opened session, reading as a dead click.
    expect(isBoardOpen()).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-kanban-active')).toBe(false)
  })

  it('a failing task-card session open shows the error and keeps the board open', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [project({ id: 'p1', status: 'executing', sessionId: undefined })],
      tasks: [task({ id: 't1', titlePath: '后端 > API 实现', kind: 'execute', status: 'executing', sessionId: 'session-task' })],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const openSession = vi.fn(() => { throw new Error('sessions.select: unknown session session-task') })
    await renderBoard(store, openSession)
    await act(async () => { toggleBoard() })
    expect(isBoardOpen()).toBe(true)

    const openButton = [...container.querySelectorAll('button')].find(button => button.textContent === '打开会话')
    await act(async () => { openButton!.click() })

    expect(container.textContent).toContain('无法打开会话')
    expect(container.textContent).toContain('unknown session')
    // The error must stay visible on the board, so the board must stay open.
    expect(isBoardOpen()).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-kanban-active')).toBe(true)
  })

  it('a project-detail session open calls through and closes the board, same as the cards', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project({ id: 'a', status: 'executing' })], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    const openSession = vi.fn()
    await renderBoard(store, openSession)
    await act(async () => { toggleBoard() })
    expect(isBoardOpen()).toBe(true)

    const detailButton = [...container.querySelectorAll('button')].find(button => button.textContent === '详情')
    await act(async () => { detailButton!.click() })
    const openButton = [...container.querySelectorAll('button')].find(button => button.textContent === '打开会话')
    expect(openButton).toBeDefined()
    await act(async () => { openButton!.click() })

    expect(openSession).toHaveBeenCalledWith('session-abc')
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
