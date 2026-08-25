// @vitest-environment jsdom
/**
 * The project detail view: the card「详情」entry (visible on every status)
 * switches the board container to a full-screen detail view with five
 * sections — basic info, plan preview (lightweight markdown over the
 * /kanban/file fetch), task leaves, transition history, and the same action
 * set as the card — and「返回看板」switches back.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, Project, TaskNode } from '../src/protocol.ts'
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

function historyEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return { at: 1000, actor: 'system', from: 'backlog', to: 'designing', ...overrides }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: '看板重构',
    workspaceDir: '/tmp/w',
    goal: '把看板后端迁移到 SQLite',
    status: 'awaiting-review',
    version: 3,
    createdAt: 1000,
    updatedAt: 2000,
    lastActivityAt: 3000,
    sessionId: 'session-abc',
    sessionRole: 'design',
    planPath: '/tmp/w/plan.md',
    history: [],
    ...overrides,
  }
}

function task(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 't1',
    projectId: 'p1',
    titlePath: '看板重构 > 后端 > API 实现',
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
  // Task cards also carry a「详情」entry now; scope to the project card,
  // which (unlike a task card) has no kind badge.
  const card = [...container.querySelectorAll<HTMLElement>('.dk-card')]
    .find(candidate => candidate.querySelector('.dk-kind-badge') === null)
  expect(card, 'a project card must exist').toBeDefined()
  const found = [...card!.querySelectorAll('button')].find(candidate => candidate.textContent === '详情')
  expect(found, 'the project card「详情」button must exist').toBeDefined()
  await act(async () => { found!.click() })
}

describe('Project detail view', () => {
  it('shows a 详情 entry on cards of every status and switches into the detail view and back', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [
        project({ id: 'a', status: 'designing', title: '设计中项目' }),
        project({ id: 'b', status: 'awaiting-review', title: '待确认项目' }),
        project({ id: 'c', status: 'executing', title: '执行中项目' }),
        project({ id: 'd', status: 'done', title: '已完成项目' }),
        project({ id: 'e', status: 'blocked', title: '阻塞项目' }),
      ],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    // One 详情 button per card, whatever the status.
    expect([...container.querySelectorAll('button')].filter(candidate => candidate.textContent === '详情')).toHaveLength(5)

    await openDetail()
    expect(container.querySelector('.dk-detail')).not.toBeNull()
    expect(container.querySelector('.dk-columns')).toBeNull()
    for (const heading of ['基本信息', '方案预览', '子任务', '流转历史', '操作']) {
      expect(container.textContent, `section ${heading}`).toContain(heading)
    }

    await act(async () => { button('返回看板').click() })
    expect(container.querySelector('.dk-detail')).toBeNull()
    expect(container.querySelector('.dk-columns')).not.toBeNull()
    unmount()
  })

  it('renders the basic-info section: goal, status, workspaceDir, timestamps, and the session entry', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project()], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await openDetail()

    const text = container.textContent ?? ''
    expect(text).toContain('看板重构')
    expect(text).toContain('把看板后端迁移到 SQLite')
    expect(text).toContain('待确认')
    expect(text).toContain('/tmp/w')
    expect(text).toContain(new Date(1000).toLocaleString())
    expect(text).toContain(new Date(3000).toLocaleString())
    expect(container.textContent).toContain('打开会话')
    unmount()
  })

  it('fetches planPath through the transport and renders the markdown subset', async () => {
    const transport = new FakeTransport()
    transport.fileValues.set('/tmp/w/plan.md', '# 方案标题\n\n- 第一条\n- 第二条\n\n```ts\nconst x = 1\n```\n\n带 **加粗** 和 `code` 的段落')
    transport.stateValue = { revision: 1, projects: [project()], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await openDetail()

    expect(transport.fileCalls).toEqual(['/tmp/w/plan.md'])
    expect(container.querySelector('.dk-md h4')?.textContent).toBe('方案标题')
    expect(container.querySelectorAll('.dk-md li')).toHaveLength(2)
    expect(container.querySelector('.dk-md li')?.textContent).toBe('第一条')
    expect(container.querySelector('.dk-md-code code')?.textContent).toBe('const x = 1')
    expect(container.querySelector('.dk-md p strong')?.textContent).toBe('加粗')
    expect(container.querySelector('.dk-md p code')?.textContent).toBe('code')
    unmount()
  })

  it('shows the placeholder when planPath is absent and never calls file()', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project({ planPath: undefined })], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await openDetail()

    expect(container.textContent).toContain('尚无方案产物')
    expect(transport.fileCalls).toEqual([])
    unmount()
  })

  it('surfaces a plan fetch failure instead of hanging on the loading state', async () => {
    const transport = new FakeTransport()
    transport.failFile = true
    transport.stateValue = { revision: 1, projects: [project()], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await openDetail()

    expect(container.textContent).toContain('方案读取失败')
    expect(container.textContent).toContain('file boom')
    unmount()
  })

  it('lists the project task leaves with kind badges, statuses, and clarify Q&A', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [project({ status: 'executing' })],
      tasks: [
        task({ id: 't1', kind: 'clarify', status: 'awaiting-review', question: '数据源是什么？', answer: '本地 CSV', titlePath: '看板重构 > 明确需求' }),
        task({ id: 't2', kind: 'execute', status: 'executing', titlePath: '看板重构 > 后端 > API 实现' }),
        task({ id: 't3', projectId: 'other', titlePath: '别的项目 > 任务', status: 'executing' }),
      ],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await openDetail()

    const text = container.textContent ?? ''
    expect(text).toContain('子任务(2)')
    expect(text).toContain('看板重构 > 明确需求')
    expect(text).toContain('看板重构 > 后端 > API 实现')
    expect(text).not.toContain('别的项目')
    expect(text).toContain('❓ 数据源是什么？')
    expect(text).toContain('✅ 本地 CSV')
    expect(text).toContain('澄清')
    expect(text).toContain('执行')
    unmount()
  })

  it('renders the transition history as a latest-first timeline with actor, from → to, and note', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [project({
        history: [
          historyEntry({ at: 1000, actor: 'system', from: 'backlog', to: 'designing', note: 'auto-start design' }),
          historyEntry({ at: 2000, actor: 'agent', from: 'designing', to: 'awaiting-review', note: 'design done' }),
          historyEntry({ at: 3000, actor: 'human', from: 'awaiting-review', to: 'designing', note: 'rejected: 太模糊' }),
        ],
      })],
      tasks: [],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await openDetail()

    const items = [...container.querySelectorAll('.dk-detail-history li')]
    expect(items).toHaveLength(3)
    // Latest first.
    expect(items[0].textContent).toContain('人工')
    expect(items[0].textContent).toContain('待确认 → 设计中')
    expect(items[0].textContent).toContain('rejected: 太模糊')
    expect(items[1].textContent).toContain('agent')
    expect(items[1].textContent).toContain('设计中 → 待确认')
    expect(items[2].textContent).toContain('系统')
    expect(items[2].textContent).toContain('待开始 → 设计中')
    unmount()
  })

  it('confirm-plan from the detail action area forwards the same action as the card', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project({ id: 'a' })], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)
    await openDetail()

    await act(async () => { button('确认方案').click() })
    expect(transport.actions).toEqual([{ kind: 'confirm-plan', projectId: 'a' }])
  })

  it('reject with feedback works from the detail view', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project({ id: 'a' })], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)
    await openDetail()

    await act(async () => { button('驳回').click() })
    const textarea = container.querySelector<HTMLTextAreaElement>('.dk-detail textarea')
    expect(textarea).toBeDefined()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea!, '方案太模糊')
      textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button('提交驳回').click() })
    expect(transport.actions).toEqual([{ kind: 'reject-plan', projectId: 'a', feedback: '方案太模糊' }])
  })

  it('re-design from blocked works from the detail view', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project({ id: 'a', status: 'blocked' })], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)
    await openDetail()

    await act(async () => { button('重新设计').click() })
    expect(transport.actions).toEqual([{ kind: 'transition', projectId: 'a', to: 'designing', note: 're-design from blocked' }])
  })

  it('delete from the detail view forwards the action and falls back to the board', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project({ id: 'a' })], tasks: [] }
    const store = new BoardStore(transport)
    await store.refresh()
    await renderBoard(store)
    await openDetail()

    const confirmSpy = vi.fn(() => true)
    globalThis.confirm = confirmSpy
    await act(async () => { button('删除').click() })
    expect(confirmSpy).toHaveBeenCalled()
    expect(transport.actions).toEqual([{ kind: 'delete-project', projectId: 'a' }])
    // The project is gone — the view must return to the board columns.
    expect(container.querySelector('.dk-detail')).toBeNull()
    expect(container.querySelector('.dk-columns')).not.toBeNull()
  })
})
