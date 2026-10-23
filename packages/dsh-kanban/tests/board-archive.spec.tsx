// @vitest-environment jsdom
/**
 * The board's archive surface: the capability-gated「归档 (N)」header entry,
 * the archive view (list + restore + delete), the archived-project page, and
 * the compensation read that keeps an active project's archived cluster
 * visible in its detail view.
 *
 * Two contracts this file exists to pin, because both fail silently in
 * production rather than loudly in a unit test:
 *
 *  - **the capability gate is structural**: on a host without
 *    `task-archive`, no entry renders AND the transport is never even asked
 *    (an empty `archiveCalls` is the proof — "rendered but disabled" would
 *    still be a request on an old host).
 *  - **a detail entry always points at something real**: an archived leaf is
 *    not in the snapshot, so a「详情」button on a leaf row would bounce the
 *    user back to the board. The leaf row therefore has none.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchiveEntry, PendingAddition, Project, TaskNode } from '../src/protocol.ts'
import { CAPABILITY_LATE_TASK_ADDITIONS, CAPABILITY_TASK_ARCHIVE } from '../src/protocol.ts'
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
    goal: '审查开源前必须做的事',
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
    titlePath: '代码开源审查 > 补齐文档',
    kind: 'execute',
    status: 'done',
    dependencies: [],
    version: 0,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    history: [],
    ...overrides,
  }
}

function archivedProjectEntry(overrides: Partial<Extract<ArchiveEntry, { kind: 'project' }>> = {}): ArchiveEntry {
  return {
    kind: 'project',
    id: 'p-archived',
    title: '已归档的一次性项目',
    projectId: 'p-archived',
    archivedAt: 1_789_000_000_000,
    archivedBy: 'system',
    archiveNote: 'auto: done for 7d',
    status: 'done',
    taskCount: 3,
    ...overrides,
  }
}

function archivedTaskEntry(overrides: Partial<Extract<ArchiveEntry, { kind: 'task' }>> = {}): ArchiveEntry {
  return {
    kind: 'task',
    id: 't-archived',
    title: '代码开源审查 > 补齐文档',
    projectId: 'p1',
    archivedAt: 1_789_100_000_000,
    archivedBy: 'human',
    archiveNote: 'manual',
    titlePath: '代码开源审查 > 补齐文档',
    taskKind: 'execute',
    status: 'done',
    projectTitle: '代码开源审查',
    ...overrides,
  }
}

function pending(overrides: Partial<PendingAddition> = {}): PendingAddition {
  return {
    projectId: 'p-archived',
    file: 'tasks-additions.1789038258000.pending.json',
    at: 1_789_038_258_000,
    state: 'ready',
    batches: 1,
    count: 2,
    items: [
      { titlePath: '补 CONTRIBUTING', kind: 'execute' },
      { titlePath: '补 CI', kind: 'execute' },
    ],
    ...overrides,
  }
}

async function renderBoard(options: {
  capabilities?: string[]
  archivedCounts?: { projects: number; tasks: number }
  projects?: Project[]
  tasks?: TaskNode[]
  archive?: ArchiveEntry[]
  /** Entries served for a `readArchive(projectId)` (compensation) call. */
  archiveByProject?: Record<string, ArchiveEntry[]>
  pendingAdditions?: PendingAddition[]
} = {}): Promise<{ transport: FakeTransport; store: BoardStore; unmount(): void }> {
  const transport = new FakeTransport()
  transport.stateValue = {
    revision: 1,
    projects: options.projects ?? [project({ status: 'done' })],
    tasks: options.tasks ?? [],
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.archivedCounts === undefined ? {} : { archivedCounts: options.archivedCounts }),
    ...(options.pendingAdditions === undefined ? {} : { pendingAdditions: options.pendingAdditions }),
  }
  transport.archiveValues.set(undefined, options.archive ?? [])
  for (const [projectId, entries] of Object.entries(options.archiveByProject ?? {})) {
    transport.archiveValues.set(projectId, entries)
  }
  const store = new BoardStore(transport)
  await store.refresh()
  const root = createRoot(container)
  await act(async () => {
    root.render(<Board store={store} openSession={vi.fn()} getDefaultWorkspaceDir={() => ''} />)
  })
  return { transport, store, unmount: () => { act(() => { root.unmount() }) } }
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
}

function buttons(label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter(candidate => candidate.textContent === label)
}

/** The button with `label` INSIDE the archive row whose text contains `rowText`. */
function rowButton(rowText: string, label: string): HTMLButtonElement | undefined {
  const row = [...container.querySelectorAll<HTMLElement>('.dk-archive-row')]
    .find(candidate => candidate.textContent?.includes(rowText))
  if (row === undefined) return undefined
  return [...row.querySelectorAll('button')].find(candidate => candidate.textContent === label)
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.dk-archive-row')]
}

/** The header's archive toggle — label is「归档 (N)」on the board,「归档」inside the view. */
function archiveToggle(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')]
    .find(candidate => candidate.textContent === '归档' || (candidate.textContent ?? '').startsWith('归档 ('))
}

/** Open the archive view through its header entry (assumes the capability is declared). */
async function openArchive(): Promise<void> {
  await act(async () => { archiveToggle()!.click() })
}

describe('archive entry capability gate', () => {
  it('A-GATE-1: renders「归档 (N)」with N from archivedCounts when the host declares the capability', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archivedCounts: { projects: 4, tasks: 1 },
    })
    // 4 + 1: the button counts every archive-view entry, which is exactly the
    // sum the host's own detail read returns.
    expect(button('归档 (5)')).toBeDefined()
    unmount()
  })

  it('A-GATE-2: renders「归档 (0)」and does not throw when archivedCounts is absent', async () => {
    const { unmount } = await renderBoard({ capabilities: [CAPABILITY_TASK_ARCHIVE] })
    expect(button('归档 (0)')).toBeDefined()
    expect(container.textContent).not.toContain('undefined')
    unmount()
  })

  it('A-GATE-3: a host without the capability gets no entry AND is never asked for the archive', async () => {
    const { transport, unmount } = await renderBoard({
      capabilities: ['task-recovery'],
      archivedCounts: { projects: 4, tasks: 1 },
      archive: [archivedProjectEntry()],
    })
    // Not "rendered but disabled", and not "rendered but hidden": the whole
    // block is absent and nothing was requested.
    expect(button('归档 (5)')).toBeUndefined()
    expect([...container.querySelectorAll('button')].some(node => node.textContent?.startsWith('归档'))).toBe(false)
    expect(transport.archiveCalls).toEqual([])
    unmount()
  })

  it('A-GATE-3b: a pre-handshake host (capabilities undefined) is treated the same way', async () => {
    const { transport, unmount } = await renderBoard({ archive: [archivedProjectEntry()] })
    expect([...container.querySelectorAll('button')].some(node => node.textContent?.startsWith('归档'))).toBe(false)
    expect(transport.archiveCalls).toEqual([])
    unmount()
  })
})

describe('archive view', () => {
  it('A-VIEW-1: renders project and leaf entries with their archive metadata', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archivedCounts: { projects: 1, tasks: 1 },
      archive: [archivedProjectEntry(), archivedTaskEntry()],
    })
    await openArchive()

    expect(container.textContent).toContain('归档只是从看板移出')
    expect(rows()).toHaveLength(2)
    // Project row: title, 含子任务 count, archiving actor, time and reason.
    expect(container.textContent).toContain('已归档的一次性项目')
    expect(container.textContent).toContain('含子任务 3')
    expect(container.textContent).toContain('系统归档')
    expect(container.textContent).toContain(new Date(1_789_000_000_000).toLocaleString())
    expect(container.textContent).toContain('auto: done for 7d')
    // Leaf row: kind badges, its title path and the still-visible owner.
    expect(container.textContent).toContain('子任务')
    expect(container.textContent).toContain('属于 代码开源审查')
    expect(container.textContent).toContain('人工归档')
    unmount()
  })

  it('A-VIEW-2: shows the empty state for an empty archive', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [],
    })
    await openArchive()
    expect(container.textContent).toContain('暂无归档记录')
    expect(rows()).toHaveLength(0)
    unmount()
  })

  it('A-VIEW-3: a failed read renders an error and keeps「返回」usable', async () => {
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [archivedProjectEntry()],
    })
    transport.failArchive = true
    await openArchive()

    expect(container.textContent).toContain('归档读取失败：archive boom')
    expect(button('返回')).toBeDefined()
    // The board itself is not white-screened: the view header is still there.
    expect(container.textContent).toContain('归档只是从看板移出')
    unmount()
  })

  it('A-VIEW-4: does not draw a leaf whose owning project is itself archived (P2 view-side mirror)', async () => {
    // Dirty data on purpose: a leaf whose owner is itself archived went into
    // the archive WITH that project and carries no marker of its own, so
    // drawing it as an individually restorable row would offer a restore with
    // no visible effect.
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [
        archivedProjectEntry({ id: 'p-archived', title: '不该出现的叶子' }),
        archivedTaskEntry({ id: 't-dirty', projectId: 'p-archived', titlePath: '不该出现的叶子' }),
      ],
    })
    await openArchive()

    // Only the project row survives — the leaf went in with it.
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain('项目')
    expect(rows()[0]!.querySelector('.dk-detail-task-path')?.textContent).toBe('不该出现的叶子')
    unmount()
  })

  it('A-VIEW-5: still draws a leaf whose owning project is NOT archived', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [
        archivedProjectEntry({ id: 'p-archived' }),
        archivedTaskEntry({ id: 't-clean', projectId: 'p1', titlePath: '该出现的叶子' }),
      ],
    })
    await openArchive()

    expect(rows()).toHaveLength(2)
    expect(container.textContent).toContain('该出现的叶子')
    unmount()
  })
})

describe('archive actions', () => {
  it('A-ACT-1: 恢复 sends unarchive-project for a project row and unarchive-task for a leaf row', async () => {
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [
        archivedProjectEntry({ id: 'p-archived' }),
        archivedTaskEntry({ id: 't-archived', projectId: 'p1' }),
      ],
    })
    await openArchive()

    await act(async () => { rowButton('已归档的一次性项目', '恢复')!.click() })
    expect(transport.actions.at(-1)).toEqual({ kind: 'unarchive-project', projectId: 'p-archived' })

    await act(async () => { rowButton('属于 代码开源审查', '恢复')!.click() })
    expect(transport.actions.at(-1)).toEqual({ kind: 'unarchive-task', projectId: 'p1', taskId: 't-archived' })
    unmount()
  })

  it('A-ACT-2: 删除 is offered in the archive view, behind a confirm', async () => {
    const confirm = vi.fn((_text: string) => true)
    vi.stubGlobal('confirm', confirm)
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [archivedProjectEntry({ id: 'p-archived' })],
    })
    await openArchive()

    await act(async () => { rowButton('已归档的一次性项目', '删除')!.click() })
    expect(String(confirm.mock.calls[0]![0])).toContain('删除项目「已归档的一次性项目」')
    expect(transport.actions.at(-1)).toEqual({ kind: 'delete-project', projectId: 'p-archived' })
    unmount()
  })

  it('A-ACT-3: cancelling the delete confirm sends nothing', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [archivedProjectEntry({ id: 'p-archived' })],
    })
    await openArchive()

    await act(async () => { rowButton('已归档的一次性项目', '删除')!.click() })
    expect(transport.actions).toEqual([])
    unmount()
  })

  it('A-ACT-4: 恢复 does NOT ask for confirmation (a lossless inverse needs no dialog)', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [archivedProjectEntry({ id: 'p-archived' })],
    })
    await openArchive()

    await act(async () => { rowButton('已归档的一次性项目', '恢复')!.click() })
    expect(confirm).not.toHaveBeenCalled()
    unmount()
  })
})

describe('archive refresh timing', () => {
  it('A-ACT-5: re-reads the archive when the snapshot revision changes', async () => {
    const { transport, store, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [archivedProjectEntry()],
    })
    await openArchive()
    expect(transport.archiveCalls).toEqual([undefined])

    // A ledger mutation elsewhere (here: a restore) bumps the revision; the
    // archive may have moved, so it must be re-read.
    transport.stateValue = { ...transport.stateValue, revision: 2 }
    await act(async () => { await store.refresh() })
    expect(transport.archiveCalls).toEqual([undefined, undefined])
    unmount()
  })

  it('A-ACT-6: an SSE payload with an UNCHANGED revision does not re-read the archive', async () => {
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [archivedProjectEntry()],
    })
    await openArchive()
    const before = transport.archiveCalls.length

    // The spawner's pending-additions push carries the same revision on
    // purpose ("push only — never persist"), so it must not trigger a re-read.
    await act(async () => { transport.emit({ revision: 1, projects: [], tasks: [] }) })
    await act(async () => { await Promise.resolve() })
    expect(transport.archiveCalls.length).toBe(before)
    unmount()
  })

  it('A-ACT-7: closing and reopening the view re-reads the archive', async () => {
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [archivedProjectEntry()],
    })
    await openArchive()
    expect(transport.archiveCalls).toEqual([undefined])

    // Toggle off, then back on: `enabled` flips, so the effect re-runs even
    // though the revision never moved — the documented "switch away and back"
    // recovery path for a failed read.
    await act(async () => { archiveToggle()!.click() })
    await act(async () => { archiveToggle()!.click() })
    expect(transport.archiveCalls).toEqual([undefined, undefined])
    unmount()
  })
})

describe('archived project detail page', () => {
  it('A-DET-1: 详情 opens the archive page with its archive banner and restore entry', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [archivedProjectEntry({ id: 'p-archived' })],
    })
    await openArchive()

    await act(async () => { rowButton('已归档的一次性项目', '详情')!.click() })

    expect(container.textContent).toContain('该项目已归档')
    expect(container.textContent).toContain('恢复后会回到看板的「已完成」列')
    expect(container.textContent).toContain('归档原因')
    expect(container.textContent).toContain('auto: done for 7d')
    expect(container.textContent).toContain('子任务数')
    expect(button('恢复')).toBeDefined()
    // The projection carries no history, so the page must not pretend it has
    // one: there is no timeline list, and the sections that need the full
    // record (basic info, plan preview) are absent — only the hint says so.
    expect(container.querySelector('.dk-detail-history')).toBeNull()
    const headings = [...container.querySelectorAll('.dk-detail-heading')].map(node => node.textContent)
    expect(headings).toEqual(['归档信息', '操作'])
    unmount()
  })

  it('A-DET-2: 返回归档 goes back to the archive list', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archive: [archivedProjectEntry({ id: 'p-archived' })],
    })
    await openArchive()
    await act(async () => { rowButton('已归档的一次性项目', '详情')!.click() })
    expect(container.textContent).toContain('归档原因')

    await act(async () => { button('返回归档')!.click() })
    expect(container.textContent).toContain('归档只是从看板移出')
    expect(rows()).toHaveLength(1)
    unmount()
  })
})

describe('archived leaves have no dead detail entry', () => {
  it('A-DET-3: a leaf row offers 恢复 but no 详情 (its task is not in the snapshot)', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      // The archived leaf is NOT in snapshot.tasks — that is the whole point.
      tasks: [],
      archive: [archivedTaskEntry({ id: 't-archived', projectId: 'p1' })],
    })
    await openArchive()

    const row = rows()[0]!
    expect(row.textContent).toContain('属于 代码开源审查')
    expect([...row.querySelectorAll('button')].map(node => node.textContent)).toEqual(['恢复'])
    unmount()
  })
})

describe('pending additions on an archived project (P4)', () => {
  it('A-PEND-1a: a published request keeps its badge and 物化到看板 entry', async () => {
    const confirm = vi.fn((_text: string) => true)
    vi.stubGlobal('confirm', confirm)
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE, CAPABILITY_LATE_TASK_ADDITIONS],
      archive: [archivedProjectEntry({ id: 'p-archived' })],
      pendingAdditions: [pending()],
    })
    await openArchive()

    const row = rows()[0]!
    expect(row.textContent).toContain('待处理的新增任务请求（2 项）')
    await act(async () => { rowButton('已归档的一次性项目', '物化到看板')!.click() })
    expect(transport.actions.at(-1)).toEqual({ kind: 'materialize-additions', projectId: 'p-archived' })
    unmount()
  })

  it('A-PEND-1b: no published request means no entry at all (not a disabled one)', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE, CAPABILITY_LATE_TASK_ADDITIONS],
      archive: [archivedProjectEntry({ id: 'p-archived' })],
      pendingAdditions: [],
    })
    await openArchive()

    expect(rowButton('已归档的一次性项目', '物化到看板')).toBeUndefined()
    expect(container.textContent).not.toContain('待处理的新增任务请求')
    unmount()
  })
})

describe('board card archive entry', () => {
  it('A-CARD-1: a finished one-shot project is offered 归档', async () => {
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      projects: [project({ id: 'p1', status: 'done' })],
    })
    await act(async () => { button('归档')!.click() })
    expect(transport.actions).toEqual([{ kind: 'archive-project', projectId: 'p1' }])
    unmount()
  })

  it('A-CARD-2: 归档 is not offered while the project is unfinished', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      projects: [project({ id: 'p1', status: 'executing' })],
    })
    expect(button('归档')).toBeUndefined()
    unmount()
  })

  it('A-CARD-3: 归档 is not offered for a long-running container (I2)', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      projects: [project({ id: 'p1', status: 'done', lifecycle: 'long-running' })],
    })
    expect(button('归档')).toBeUndefined()
    unmount()
  })

  it('A-CARD-4: 归档 is not offered while an unfinished leaf remains (I3)', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      projects: [project({ id: 'p1', status: 'done' })],
      tasks: [task({ id: 't1', projectId: 'p1', status: 'executing' })],
    })
    expect(button('归档')).toBeUndefined()
    unmount()
  })

  it('A-CARD-5: no 归档 entry on a host without the capability', async () => {
    const { unmount } = await renderBoard({
      capabilities: ['task-recovery'],
      projects: [project({ id: 'p1', status: 'done' })],
    })
    expect(button('归档')).toBeUndefined()
    unmount()
  })
})

describe('leaf-level archive from the project detail', () => {
  it('A-LEAF-1: a done leaf of a visible project gets an 归档 action in its row', async () => {
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      projects: [project({ id: 'p1', status: 'executing' })],
      tasks: [
        task({ id: 't-done', projectId: 'p1', status: 'done', titlePath: '代码开源审查 > 已完成叶子' }),
        task({ id: 't-open', projectId: 'p1', status: 'executing', titlePath: '代码开源审查 > 进行中叶子' }),
      ],
    })
    await act(async () => { button('详情')!.click() })

    const doneRow = [...container.querySelectorAll<HTMLElement>('.dk-detail-task')]
      .find(row => row.textContent?.includes('已完成叶子'))!
    const openRow = [...container.querySelectorAll<HTMLElement>('.dk-detail-task')]
      .find(row => row.textContent?.includes('进行中叶子'))!

    const doneArchive = [...doneRow.querySelectorAll('button')].find(node => node.textContent === '归档')
    expect(doneArchive).toBeDefined()
    // A leaf that is not finished has nothing to archive.
    expect([...openRow.querySelectorAll('button')].some(node => node.textContent === '归档')).toBe(false)

    await act(async () => { doneArchive!.click() })
    expect(transport.actions.at(-1)).toEqual({ kind: 'archive-task', projectId: 'p1', taskId: 't-done' })
    unmount()
  })

  it('A-LEAF-2: a done project offers 归档 on the project itself, not on each of its leaves', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      projects: [project({ id: 'p1', status: 'done' })],
      tasks: [task({ id: 't-done', projectId: 'p1', status: 'done' })],
    })
    await act(async () => { button('详情')!.click() })

    const leafRow = [...container.querySelectorAll<HTMLElement>('.dk-detail-task')]
      .find(row => row.textContent?.includes('补齐文档'))!
    // I3's mirror: the leaf hides WITH the project, so a per-leaf marker would
    // be invisible. Only the project-level entry is offered.
    expect([...leafRow.querySelectorAll('button')].some(node => node.textContent === '归档')).toBe(false)
    unmount()
  })
})

describe('project detail compensation read', () => {
  it('A-COMP-1: a long-running container pulls back its archived children', async () => {
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      projects: [project({ id: 'container', status: 'executing', lifecycle: 'long-running', title: '长期容器' })],
      archiveByProject: {
        container: [archivedProjectEntry({ id: 'child-done', title: '已完成子项目', parentTitle: '长期容器' })],
      },
    })
    await act(async () => { button('详情')!.click() })

    // The compensation read used the project cluster form, not the global one.
    expect(transport.archiveCalls).toEqual(['container'])
    expect(container.textContent).toContain('名下子项目(1)')
    expect(container.textContent).toContain('已完成子项目')
    expect(container.textContent).toContain('已归档')
    unmount()
  })

  it('A-COMP-2: archived leaves are merged into the 子任务 list and count', async () => {
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      projects: [project({ id: 'p1', status: 'executing' })],
      tasks: [task({ id: 't-open', projectId: 'p1', status: 'executing', titlePath: '代码开源审查 > 进行中叶子' })],
      archiveByProject: {
        p1: [archivedTaskEntry({ id: 't-archived', projectId: 'p1', titlePath: '代码开源审查 > 归档叶子' })],
      },
    })
    await act(async () => { button('详情')!.click() })

    expect(container.textContent).toContain('子任务(2)')
    expect(container.textContent).toContain('进行中叶子')
    expect(container.textContent).toContain('归档叶子')
    unmount()
  })

  it('A-COMP-3: a failed compensation read degrades to the active set without breaking the page', async () => {
    const { transport, unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      projects: [project({ id: 'p1', status: 'executing' })],
      tasks: [task({ id: 't-open', projectId: 'p1', status: 'executing' })],
    })
    transport.failArchive = true
    await act(async () => { button('详情')!.click() })

    expect(container.textContent).toContain('归档条目读取失败，当前仅显示活跃项')
    // The page still renders its live content.
    expect(container.textContent).toContain('子任务(1)')
    expect(container.textContent).toContain('基本信息')
    unmount()
  })

  it('A-COMP-4: no compensation read is attempted on a host without the capability', async () => {
    const { transport, unmount } = await renderBoard({
      capabilities: ['task-recovery'],
      projects: [project({ id: 'p1', status: 'executing' })],
    })
    await act(async () => { button('详情')!.click() })
    expect(transport.archiveCalls).toEqual([])
    unmount()
  })

  it('A-COMP-5: DG-1 the graph draws the edge to an archived provider instead of dropping it', async () => {
    // The archived leaf is a `done` dependency PROVIDER. Without the synthetic
    // node the layout treats the id as dangling and silently omits the edge —
    // no error, just a structure that quietly lost a node.
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      projects: [project({ id: 'p1', status: 'executing' })],
      tasks: [task({
        id: 't-dependent',
        projectId: 'p1',
        status: 'executing',
        titlePath: '代码开源审查 > 依赖归档叶子的活跃叶子',
        dependencies: ['t-archived'],
      })],
      archiveByProject: {
        p1: [archivedTaskEntry({
          id: 't-archived',
          projectId: 'p1',
          titlePath: '代码开源审查 > 归档的提供方',
          status: 'done',
        })],
      },
    })
    await act(async () => { button('详情')!.click() })
    await act(async () => { button('依赖图')!.click() })

    const nodeTitles = [...container.querySelectorAll('.dk-graph-node-title')].map(node => node.textContent)
    expect(nodeTitles).toContain('归档的提供方')
    expect(nodeTitles).toContain('依赖归档叶子的活跃叶子')
    // The archived provider is visually marked as off-board: it is in the graph
    // for the edge, not as current work.
    const archivedNode = [...container.querySelectorAll('.dk-graph-node')]
      .find(node => node.textContent?.includes('归档的提供方'))!
    expect(archivedNode.className).toContain('dk-graph-node-archived')
    const activeNode = [...container.querySelectorAll('.dk-graph-node')]
      .find(node => node.textContent?.includes('依赖归档叶子的活跃叶子'))!
    expect(activeNode.className).not.toContain('dk-graph-node-archived')
    // The edge exists AND is rendered as "already satisfied" (weakened color),
    // which is exactly the semantics of an archived `done` provider.
    const edges = [...container.querySelectorAll('.dk-graph-edge')]
    expect(edges).toHaveLength(1)
    expect(edges[0]!.getAttribute('class')).toContain('dk-graph-edge-done')
    unmount()
  })
})

describe('backward compatibility (new host + old client semantics)', () => {
  it('A-COMPAT-1: a snapshot with archivedCounts and fewer records renders the columns unchanged', async () => {
    // The "old client" in this repo is simply render logic that does not know
    // the field exists: it must ignore it and keep working. Here the snapshot
    // has the aggregate and no archived records at all (the shape a pre-archive
    // client would receive).
    const { unmount } = await renderBoard({
      capabilities: [CAPABILITY_TASK_ARCHIVE],
      archivedCounts: { projects: 7, tasks: 3 },
      projects: [project({ id: 'p1', status: 'done' })],
    })
    expect(container.textContent).toContain('已完成')
    expect(container.textContent).toContain('代码开源审查')
    unmount()
  })
})
