// @vitest-environment jsdom
/**
 * The task detail view: every task card (any kind, any status) has a「详情」
 * entry that switches the board container to a full-screen detail — basic
 * info, the clarify Q&A (visible in every status, including done), the
 * artifact preview (same three-state fetch as the plan preview), pending
 * dependencies, transition history, and the card's status-specific actions.
 *「返回」goes back to whatever opened it (the columns or a project detail);
 * when the task disappears from the snapshot the view falls back instead of
 * going blank.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, Project, TaskNode } from '../src/protocol.ts'
import { Board } from '../src/client/board.tsx'
import { BoardStore } from '../src/client/store.ts'
import { isBoardOpen, toggleBoard } from '../src/client/view-state.ts'
import { FakeTransport } from './fake-transport.ts'

// TaskDetail loads the artifact in an effect after mount; opt into React's
// act environment so those awaited updates don't warn.
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
    status: 'executing',
    version: 3,
    createdAt: 1000,
    updatedAt: 2000,
    lastActivityAt: 3000,
    history: [],
    ...overrides,
  }
}

function task(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 't1',
    projectId: 'p1',
    titlePath: '看板重构 > 明确需求',
    kind: 'clarify',
    status: 'done',
    question: '数据源是什么？',
    answer: '本地 CSV',
    dependencies: [],
    version: 1,
    createdAt: 1000,
    updatedAt: 2000,
    lastActivityAt: 3000,
    sessionId: 'session-task',
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

/** A button scoped to the card/section containing `withinText` (cards and detail rows both carry the leaf title). */
function scopedButton(withinText: string, text: string): HTMLButtonElement {
  const card = [...container.querySelectorAll<HTMLElement>('.dk-card, .dk-detail-task')]
    .find(candidate => candidate.textContent?.includes(withinText))
  expect(card, `card containing「${withinText}」must exist`).toBeDefined()
  const found = [...card!.querySelectorAll('button')].find(candidate => candidate.textContent === text)
  expect(found, `button「${text}」in「${withinText}」must exist`).toBeDefined()
  return found!
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === text)
  expect(found, `button「${text}」must exist`).toBeDefined()
  return found!
}

describe('Task detail view', () => {
  it('shows a 详情 entry on task cards of every status and kind, switches into the detail view and back', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [],
      tasks: [
        task({ id: 't1', status: 'designing', kind: 'design', titlePath: '项目 > 设计任务', question: undefined, answer: undefined }),
        task({ id: 't2', status: 'awaiting-clarification', kind: 'clarify', titlePath: '项目 > 澄清任务', answer: undefined }),
        task({ id: 't3', status: 'awaiting-review', kind: 'clarify', titlePath: '项目 > 待确认任务' }),
        task({ id: 't4', status: 'executing', kind: 'execute', titlePath: '项目 > 执行任务', question: undefined, answer: undefined }),
        task({ id: 't5', status: 'done', kind: 'research', titlePath: '项目 > 调研任务', question: undefined, answer: undefined }),
      ],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    // One 详情 button per task card, whatever the status/kind.
    expect([...container.querySelectorAll('button')].filter(candidate => candidate.textContent === '详情')).toHaveLength(5)

    await act(async () => { scopedButton('调研任务', '详情').click() })
    expect(container.querySelector('.dk-detail')).not.toBeNull()
    expect(container.querySelector('.dk-columns')).toBeNull()
    for (const heading of ['基本信息', '产物预览', '流转历史', '操作']) {
      expect(container.textContent, `section ${heading}`).toContain(heading)
    }
    // A non-clarify task has no Q&A section.
    expect(container.textContent).not.toContain('澄清问答')

    await act(async () => { button('返回看板').click() })
    expect(container.querySelector('.dk-detail')).toBeNull()
    expect(container.querySelector('.dk-columns')).not.toBeNull()
    unmount()
  })

  it('keeps the clarify Q&A visible in the done status (the core regression: cards hide it)', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [], tasks: [task()] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    // The done card shows neither the question nor the answer inline.
    const card = container.querySelector('.dk-card')!
    expect(card.textContent).not.toContain('数据源是什么？')
    expect(card.textContent).not.toContain('本地 CSV')

    await act(async () => { scopedButton('明确需求', '详情').click() })
    expect(container.textContent).toContain('澄清问答')
    expect(container.textContent).toContain('❓ 数据源是什么？')
    expect(container.textContent).toContain('✅ 本地 CSV')
    unmount()
  })

  it('renders long multi-line Q&A in the detail view in full (dk-detail-qa, no truncation class)', async () => {
    const longQuestion = '第一行问题：数据源是什么？'.repeat(5)
    const longAnswer = ['第一行回答：本地 CSV', '第二行回答：增量同步', '第三行回答：每小时一次'].join('\n')
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [],
      tasks: [task({ question: longQuestion, answer: longAnswer })],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })

    const qaSection = [...container.querySelectorAll<HTMLElement>('.dk-detail-section')]
      .find(section => section.textContent?.includes('澄清问答'))!
    expect(qaSection).toBeDefined()

    const qaParagraphs = [...qaSection.querySelectorAll<HTMLElement>('p.dk-detail-qa')]
    expect(qaParagraphs).toHaveLength(2)
    // Full text present — no truncation marker, every line kept.
    expect(qaParagraphs[0].textContent).toBe(`❓ ${longQuestion}`)
    expect(qaParagraphs[1].textContent).toBe(`✅ ${longAnswer}`)
    expect(qaSection.textContent).not.toContain('…')
    // The detail view must not reuse the card's two-line clamp class.
    expect(qaSection.querySelector('.dk-card-goal')).toBeNull()
    unmount()
  })

  it('renders the basic-info section: titlePath, kind/status badges, timestamps, project title, and the session entry', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project()], tasks: [task()] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })

    const text = container.textContent ?? ''
    expect(text).toContain('看板重构 > 明确需求')
    expect(text).toContain('澄清')
    expect(text).toContain('已完成')
    expect(text).toContain('看板重构')
    expect(text).toContain(new Date(1000).toLocaleString())
    expect(text).toContain(new Date(3000).toLocaleString())
    expect(container.textContent).toContain('打开会话')
    unmount()
  })

  it('fetches artifactPath through the transport and renders the markdown subset', async () => {
    const transport = new FakeTransport()
    transport.fileValues.set('/tmp/w/research.md', '# 调研结论\n\n- 要点一\n\n带 **加粗** 和 `code` 的段落')
    transport.stateValue = {
      revision: 1,
      projects: [],
      tasks: [task({ kind: 'research', question: undefined, answer: undefined, artifactPath: '/tmp/w/research.md' })],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })

    expect(transport.fileCalls).toEqual(['/tmp/w/research.md'])
    expect(container.querySelector('.dk-md h4')?.textContent).toBe('调研结论')
    expect(container.querySelector('.dk-md li')?.textContent).toBe('要点一')
    expect(container.querySelector('.dk-md p strong')?.textContent).toBe('加粗')
    expect(container.querySelector('.dk-md p code')?.textContent).toBe('code')
    unmount()
  })

  it('shows the placeholder when artifactPath is absent and never calls file()', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [], tasks: [task()] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })

    expect(container.textContent).toContain('尚无产物')
    expect(transport.fileCalls).toEqual([])
    unmount()
  })

  it('surfaces an artifact fetch failure instead of hanging on the loading state', async () => {
    const transport = new FakeTransport()
    transport.failFile = true
    transport.stateValue = { revision: 1, projects: [], tasks: [task({ artifactPath: '/tmp/w/research.md' })] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })

    expect(container.textContent).toContain('产物读取失败')
    expect(container.textContent).toContain('file boom')
    unmount()
  })

  it('lists only the not-yet-done dependencies and hides the section when none are pending', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [],
      tasks: [
        task({ id: 't1', dependencies: ['t2', 't3'], status: 'executing', kind: 'execute', question: undefined, answer: undefined }),
        task({ id: 't2', titlePath: '项目 > 后端任务', status: 'executing', kind: 'execute', question: undefined, answer: undefined }),
        task({ id: 't3', titlePath: '项目 > 已完成任务', status: 'done', kind: 'execute', question: undefined, answer: undefined }),
      ],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    // The pending dependency shows on the card and in the detail; the done one does not.
    await act(async () => { scopedButton('明确需求', '详情').click() })
    expect(container.textContent).toContain('⏳ 等待依赖完成：后端任务')
    expect(container.textContent).not.toContain('已完成任务')
    unmount()

    // No dependencies → no section.
    transport.stateValue = { revision: 2, projects: [], tasks: [task({ id: 't1' })] }
    await store.refresh()
    const unmount2 = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })
    expect(container.textContent).not.toContain('⏳')
    unmount2()
  })

  it('renders the transition history as a latest-first timeline with actor, from → to, and note', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [],
      tasks: [task({
        history: [
          historyEntry({ at: 1000, actor: 'system', from: 'backlog', to: 'awaiting-clarification', note: 'spawned' }),
          historyEntry({ at: 2000, actor: 'human', from: 'awaiting-clarification', to: 'awaiting-review', note: 'answered' }),
          historyEntry({ at: 3000, actor: 'human', from: 'awaiting-review', to: 'done', note: 'confirmed' }),
        ],
      })],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })

    const items = [...container.querySelectorAll('.dk-detail-history li')]
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain('待确认 → 已完成')
    expect(items[0].textContent).toContain('confirmed')
    expect(items[1].textContent).toContain('人工')
    expect(items[1].textContent).toContain('待澄清 → 待确认')
    expect(items[2].textContent).toContain('系统')
    expect(items[2].textContent).toContain('待开始 → 待澄清')
    unmount()
  })

  it('submits the answer from the detail view (action forwarded, draft cleared)', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [], tasks: [task({ status: 'awaiting-clarification', answer: undefined })] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })

    const textarea = container.querySelector<HTMLTextAreaElement>('.dk-detail textarea')
    expect(textarea).toBeDefined()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea!, '本地 CSV')
      textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button('提交回答').click() })
    expect(transport.actions).toEqual([{ kind: 'answer-clarification', projectId: 'p1', taskId: 't1', answer: '本地 CSV' }])
    expect(container.querySelector<HTMLTextAreaElement>('.dk-detail textarea')?.value).toBe('')
    unmount()
  })

  it('confirms the answer from the detail view with the same action as the card', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [], tasks: [task({ status: 'awaiting-review' })] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })

    await act(async () => { button('确认回答').click() })
    expect(transport.actions).toEqual([{ kind: 'confirm-task', projectId: 'p1', taskId: 't1' }])
    unmount()
  })

  it('confirms a design task from the detail view', async () => {
    const transport = new FakeTransport()
    transport.stateValue = {
      revision: 1,
      projects: [],
      tasks: [task({ kind: 'design', status: 'awaiting-review', question: undefined, answer: undefined })],
    }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })

    await act(async () => { button('确认设计').click() })
    expect(transport.actions).toEqual([{ kind: 'confirm-task', projectId: 'p1', taskId: 't1' }])
    unmount()
  })

  it('is mutually exclusive with the columns and the project detail while open', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project()], tasks: [task()] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })

    expect(container.querySelector('.dk-detail')).not.toBeNull()
    expect(container.querySelector('.dk-columns')).toBeNull()
    expect(container.textContent).not.toContain('方案预览')
    unmount()
  })

  it('navigates from a project detail task row into the task detail and back to the project detail', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project()], tasks: [task()] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    // Open the project detail, then the task row's 详情.
    await act(async () => { scopedButton('把看板后端迁移到 SQLite', '详情').click() })
    expect(container.querySelector('.dk-detail')).not.toBeNull()
    await act(async () => { scopedButton('看板重构 > 明确需求', '详情').click() })
    expect(container.textContent).toContain('澄清问答')

    //「返回」from here lands back on the project detail, not the columns.
    await act(async () => { button('返回项目').click() })
    expect(container.querySelector('.dk-detail')).not.toBeNull()
    expect(container.textContent).toContain('方案预览')
    expect(container.querySelector('.dk-columns')).toBeNull()
    unmount()
  })

  it('falls back to the columns when the task disappears from the snapshot while the detail is open', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project()], tasks: [task()] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)
    await act(async () => { scopedButton('明确需求', '详情').click() })
    expect(container.querySelector('.dk-detail')).not.toBeNull()

    // The project (and its task) is deleted: the detail must not go blank.
    transport.stateValue = { revision: 2, projects: [], tasks: [] }
    await act(async () => { await store.refresh() })
    expect(container.querySelector('.dk-detail')).toBeNull()
    expect(container.querySelector('.dk-columns')).not.toBeNull()
    unmount()
  })

  it('falls back to the project detail when only the task disappears while opened from it', async () => {
    const transport = new FakeTransport()
    transport.stateValue = { revision: 1, projects: [project()], tasks: [task()] }
    const store = new BoardStore(transport)
    await store.refresh()
    const unmount = await renderBoard(store)

    await act(async () => { scopedButton('把看板后端迁移到 SQLite', '详情').click() })
    await act(async () => { scopedButton('看板重构 > 明确需求', '详情').click() })
    expect(container.textContent).toContain('澄清问答')

    transport.stateValue = { revision: 2, projects: [project()], tasks: [] }
    await act(async () => { await store.refresh() })
    expect(container.textContent).toContain('方案预览')
    expect(container.querySelector('.dk-columns')).toBeNull()
    unmount()
  })
})
