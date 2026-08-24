/**
 * The kanban board view: six columns, project cards with phase actions
 * (confirm / reject with feedback / re-design / delete), a full-screen
 * project detail view switched inside the board container, the new-project
 * modal, and a live session-open affordance. Reads the BoardStore through
 * useSyncExternalStore; every mutation goes through store.apply.
 */
import { useEffect, useSyncExternalStore, useState } from 'react'
import type { ReactNode } from 'react'
import type { Actor, Project, ProjectStatus, TaskKind, TaskNode } from '../protocol.ts'
import type { BoardStore } from './store.ts'
import { closeBoard } from './view-state.ts'

const COLUMNS: ReadonlyArray<{ status: ProjectStatus; label: string }> = [
  { status: 'backlog', label: '待开始' },
  { status: 'designing', label: '设计中' },
  { status: 'awaiting-clarification', label: '待澄清' },
  { status: 'awaiting-review', label: '待确认' },
  { status: 'executing', label: '执行中' },
  { status: 'blocked', label: '阻塞' },
  { status: 'done', label: '已完成' },
]

/** Chinese labels for every board status (detail view badges and history timeline). */
const STATUS_LABELS: Record<ProjectStatus, string> = {
  backlog: '待开始',
  designing: '设计中',
  'awaiting-clarification': '待澄清',
  'awaiting-review': '待确认',
  executing: '执行中',
  blocked: '阻塞',
  done: '已完成',
}

/** Chinese labels for history actors. */
const ACTOR_LABELS: Record<Actor, string> = {
  human: '人工',
  agent: 'agent',
  system: '系统',
}

/** Chinese labels for the four task kinds. */
const KIND_LABELS: Record<TaskKind, string> = {
  clarify: '澄清',
  research: '调研',
  design: '设计',
  execute: '执行',
}

/** Epoch millis → locale string (detail view timestamps). */
function formatTime(at: number): string {
  return new Date(at).toLocaleString()
}

export interface BoardProps {
  store: BoardStore
  openSession(sessionId: string): void
  /** Live source of the new-project form's workspace-dir default (read when the modal opens). */
  getDefaultWorkspaceDir(): string
}

/** The board view (MVP). */
export function Board({ store, openSession, getDefaultWorkspaceDir }: BoardProps): JSX.Element {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const error = useSyncExternalStore(store.subscribe, store.getError)
  const [creating, setCreating] = useState(false)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const detailProject = detailId === null ? undefined : snapshot.projects.find(project => project.id === detailId)

  return (
    <div className="dk-board">
      {detailProject === undefined ? (
        <>
          <header className="dk-header">
            <h2 className="dk-title">项目看板</h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="dk-btn dk-btn-primary" onClick={() => { setCreating(true) }}>+ 新建项目</button>
              <button className="dk-btn" onClick={() => { closeBoard() }}>返回</button>
            </div>
          </header>
          {error !== null && <p className="dk-error">host 通信失败：{error}</p>}
          <div className="dk-columns">
            {COLUMNS.map(column => {
              const projects = snapshot.projects.filter(project => project.status === column.status)
              const tasks = snapshot.tasks.filter(task => task.status === column.status)
              return (
                <section className="dk-column" key={column.status}>
                  <div className="dk-column-title">
                    <span>{column.label}</span>
                    <span className="dk-column-count">{projects.length + tasks.length}</span>
                  </div>
                  {projects.length === 0 && tasks.length === 0 && <span className="dk-empty">空</span>}
                  {projects.map(project => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      taskCount={snapshot.tasks.filter(task => task.projectId === project.id).length}
                      rejecting={rejectingId === project.id}
                      onToggleReject={() => { setRejectingId(rejectingId === project.id ? null : project.id) }}
                      onAction={action => { void store.apply(action) }}
                      onOpenSession={openSession}
                      onOpenDetail={() => { setDetailId(project.id) }}
                    />
                  ))}
                  {tasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      projectTitle={snapshot.projects.find(project => project.id === task.projectId)?.title ?? ''}
                      waitingFor={task.dependencies
                        .map(id => snapshot.tasks.find(candidate => candidate.id === id))
                        .filter((candidate): candidate is TaskNode => candidate !== undefined && candidate.status !== 'done')
                        .map(candidate => candidate.titlePath.split(' > ').at(-1) ?? candidate.titlePath)}
                      onAction={action => { void store.apply(action) }}
                      onOpenSession={openSession}
                    />
                  ))}
                </section>
              )
            })}
          </div>
        </>
      ) : (
        <ProjectDetail
          project={detailProject}
          tasks={snapshot.tasks.filter(task => task.projectId === detailProject.id)}
          store={store}
          onBack={() => { setDetailId(null) }}
          onAction={action => {
            void store.apply(action)
            // The project is gone after a delete; fall back to the board.
            if (action.kind === 'delete-project') setDetailId(null)
          }}
          onOpenSession={openSession}
        />
      )}
      {creating && (
        <NewProjectModal
          getDefaultWorkspaceDir={getDefaultWorkspaceDir}
          onCancel={() => { setCreating(false) }}
          onCreate={input => {
            void store.apply({ kind: 'create-project', ...input })
            setCreating(false)
          }}
        />
      )}
    </div>
  )
}

interface ProjectCardProps {
  project: Project
  taskCount: number
  rejecting: boolean
  onToggleReject(): void
  onAction(action: Parameters<BoardStore['apply']>[0]): void
  onOpenSession(sessionId: string): void
  onOpenDetail(): void
}

function ProjectCard({ project, taskCount, rejecting, onToggleReject, onAction, onOpenSession, onOpenDetail }: ProjectCardProps): JSX.Element {
  const [openError, setOpenError] = useState<string | null>(null)
  const handleOpenSession = (): void => {
    setOpenError(null)
    try {
      onOpenSession(project.sessionId!)
      // The opened session renders in the conversation pane, which the open
      // board covers; close the board so the jump is actually visible.
      closeBoard()
    } catch (error) {
      // The runtime throws when the session is not in the current workspace
      // list (e.g. the project's directory is a different workspace); a
      // silent no-op reads as a broken button, so surface the reason.
      setOpenError(error instanceof Error ? error.message : String(error))
    }
  }
  const sessionChip = project.sessionId !== undefined
    ? <button className="dk-btn dk-btn-ghost" onClick={handleOpenSession}>打开会话</button>
    : null

  return (
    <article className="dk-card">
      <h3 className="dk-card-title">{project.title}</h3>
      <p className="dk-card-goal">{project.goal}</p>
      <div className="dk-card-meta">
        {project.sessionId?.slice(0, 13) ?? '无会话'}
        {taskCount > 0 && <> · 子任务 {taskCount}</>}
        {project.feedback !== undefined && <> · 反馈：{project.feedback}</>}
      </div>
      {openError !== null && <p className="dk-card-error">无法打开会话：{openError}</p>}
      <div className="dk-card-actions">
        {project.status === 'awaiting-review' && (
          <>
            <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'confirm-plan', projectId: project.id }) }}>确认方案</button>
            <button className="dk-btn dk-btn-danger" onClick={onToggleReject}>{rejecting ? '取消' : '驳回'}</button>
          </>
        )}
        {project.status === 'blocked' && (
          <button className="dk-btn" onClick={() => { onAction({ kind: 'transition', projectId: project.id, to: 'designing', note: 're-design from blocked' }) }}>重新设计</button>
        )}
        {(project.status === 'designing' || project.status === 'executing' || project.status === 'done') && sessionChip}
        <button className="dk-btn dk-btn-ghost" onClick={onOpenDetail}>详情</button>
        <button
          className="dk-btn dk-btn-ghost"
          onClick={() => { if (globalThis.confirm(`删除项目「${project.title}」？`)) onAction({ kind: 'delete-project', projectId: project.id }) }}
        >删除</button>
      </div>
      {rejecting && (
        <RejectForm
          projectId={project.id}
          onSubmit={feedback => { onAction({ kind: 'reject-plan', projectId: project.id, feedback }) }}
        />
      )}
    </article>
  )
}

interface TaskCardProps {
  task: TaskNode
  projectTitle: string
  /** Titles of not-yet-done dependencies this leaf is waiting on. */
  waitingFor: string[]
  onAction(action: Parameters<BoardStore['apply']>[0]): void
  onOpenSession(sessionId: string): void
}

/** One decomposed task leaf: level-indented title, kind badge, and kind-specific actions. */
function TaskCard({ task, projectTitle, waitingFor, onAction, onOpenSession }: TaskCardProps): JSX.Element {
  const segments = task.titlePath.split(' > ')
  const level = segments.length - 1
  const [answerDraft, setAnswerDraft] = useState('')
  const [openError, setOpenError] = useState<string | null>(null)
  const handleOpenSession = (): void => {
    setOpenError(null)
    try {
      onOpenSession(task.sessionId!)
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <article className="dk-card" style={{ marginLeft: `${Math.min(level, 3) * 14}px` }}>
      <h3 className="dk-card-title">{segments.at(-1)}</h3>
      {segments.length > 1 && <p className="dk-card-path">{segments.slice(0, -1).join(' > ')}</p>}
      <div className="dk-card-meta">
        <span className="dk-kind-badge">{KIND_LABELS[task.kind]}</span>
        {projectTitle !== '' && <> · {projectTitle}</>}
        {task.sessionId !== undefined && <> · {task.sessionId.slice(0, 13)}</>}
      </div>
      {waitingFor.length > 0 && <p className="dk-card-waiting">⏳ 等待依赖完成：{waitingFor.join('、')}</p>}
      {task.kind === 'clarify' && task.status === 'awaiting-clarification' && task.question !== undefined && (
        <div className="dk-reject">
          <p className="dk-card-goal">❓ {task.question}</p>
          <textarea
            placeholder="回答这个问题（会作为后续执行任务的上下文）"
            value={answerDraft}
            onChange={event => { setAnswerDraft(event.target.value) }}
          />
          <div className="dk-card-actions">
            <button
              className="dk-btn dk-btn-primary"
              disabled={answerDraft.trim() === ''}
              onClick={() => {
                onAction({ kind: 'answer-clarification', projectId: task.projectId, taskId: task.id, answer: answerDraft.trim() })
                setAnswerDraft('')
              }}
            >提交回答</button>
          </div>
        </div>
      )}
      {task.kind === 'clarify' && task.status === 'awaiting-review' && task.answer !== undefined && (
        <div className="dk-card-actions">
          <span className="dk-card-goal">✅ {task.answer}</span>
          <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'confirm-task', projectId: task.projectId, taskId: task.id }) }}>确认回答</button>
        </div>
      )}
      {task.kind === 'design' && task.status === 'awaiting-review' && (
        <div className="dk-card-actions">
          <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'confirm-task', projectId: task.projectId, taskId: task.id }) }}>确认设计</button>
        </div>
      )}
      <div className="dk-card-actions">
        {task.sessionId !== undefined && (task.status === 'designing' || task.status === 'executing' || task.status === 'done') && (
          <button className="dk-btn dk-btn-ghost" onClick={handleOpenSession}>打开会话</button>
        )}
      </div>
      {openError !== null && <p className="dk-card-error">无法打开会话：{openError}</p>}
    </article>
  )
}

interface ProjectDetailProps {
  project: Project
  tasks: TaskNode[]
  store: BoardStore
  onBack(): void
  onAction(action: Parameters<BoardStore['apply']>[0]): void
  onOpenSession(sessionId: string): void
}

/**
 * The full-screen project detail view, switched inside the board container
 * (no new route — same pattern as closeBoard). Five sections: basic info,
 * plan preview (fetched on demand through the /kanban/file route), task
 * leaves, transition history, and the same action set as the card.
 */
function ProjectDetail({ project, tasks, store, onBack, onAction, onOpenSession }: ProjectDetailProps): JSX.Element {
  const [rejecting, setRejecting] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [plan, setPlan] = useState<{ state: 'loading' | 'loaded' | 'error'; text?: string; error?: string } | null>(null)
  const planPath = project.planPath

  // Fetch the plan artifact on demand; it deliberately stays out of the
  // snapshot (the file can be large and changes outside the ledger).
  useEffect(() => {
    if (planPath === undefined) {
      setPlan(null)
      return
    }
    let cancelled = false
    setPlan({ state: 'loading' })
    store.readFile(planPath).then(
      text => { if (!cancelled) setPlan({ state: 'loaded', text }) },
      (error: unknown) => { if (!cancelled) setPlan({ state: 'error', error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { cancelled = true }
  }, [planPath, store])

  const handleOpenSession = (): void => {
    setOpenError(null)
    try {
      onOpenSession(project.sessionId!)
      closeBoard()
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="dk-detail">
      <header className="dk-header">
        <h2 className="dk-title">{project.title}</h2>
        <button className="dk-btn" onClick={onBack}>返回看板</button>
      </header>
      <div className="dk-detail-body">
        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">基本信息</h3>
          <dl className="dk-detail-grid">
            <dt>状态</dt><dd><span className="dk-kind-badge">{STATUS_LABELS[project.status]}</span></dd>
            <dt>目标</dt><dd>{project.goal}</dd>
            <dt>工作目录</dt><dd><code>{project.workspaceDir}</code></dd>
            <dt>创建时间</dt><dd>{formatTime(project.createdAt)}</dd>
            <dt>更新时间</dt><dd>{formatTime(project.updatedAt)}</dd>
            <dt>最近活动</dt><dd>{formatTime(project.lastActivityAt)}</dd>
            <dt>会话</dt>
            <dd>
              {project.sessionId !== undefined
                ? <button className="dk-btn dk-btn-ghost" onClick={handleOpenSession}>打开会话</button>
                : '无会话'}
            </dd>
          </dl>
          {openError !== null && <p className="dk-card-error">无法打开会话：{openError}</p>}
          {project.feedback !== undefined && <p className="dk-card-goal">最近反馈:{project.feedback}</p>}
        </section>

        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">方案预览</h3>
          {planPath === undefined ? (
            <p className="dk-empty">尚无方案产物</p>
          ) : plan === null || plan.state === 'loading' ? (
            <p className="dk-empty">加载中…</p>
          ) : plan.state === 'error' ? (
            <p className="dk-card-error">方案读取失败：{plan.error}</p>
          ) : (
            <>
              <p className="dk-card-path">{planPath}</p>
              <Markdown text={plan.text ?? ''} />
            </>
          )}
        </section>

        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">子任务({tasks.length})</h3>
          {tasks.length === 0 ? <p className="dk-empty">尚无子任务</p> : tasks.map(task => (
            <div className="dk-detail-task" key={task.id}>
              <div className="dk-card-meta">
                <span className="dk-kind-badge">{KIND_LABELS[task.kind]}</span>
                {' '}<span className="dk-kind-badge">{STATUS_LABELS[task.status]}</span>
              </div>
              <p className="dk-detail-task-path">{task.titlePath}</p>
              {task.question !== undefined && <p className="dk-card-goal">❓ {task.question}</p>}
              {task.answer !== undefined && <p className="dk-card-goal">✅ {task.answer}</p>}
            </div>
          ))}
        </section>

        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">流转历史</h3>
          {project.history.length === 0 ? <p className="dk-empty">尚无流转记录</p> : (
            <ol className="dk-detail-history">
              {[...project.history].reverse().map((entry, index) => (
                <li key={index}>
                  <span className="dk-detail-history-time">{formatTime(entry.at)}</span>
                  <span className="dk-detail-history-actor">{ACTOR_LABELS[entry.actor]}</span>
                  <span>{STATUS_LABELS[entry.from]} → {STATUS_LABELS[entry.to]}</span>
                  {entry.note !== undefined && <span className="dk-detail-history-note">{entry.note}</span>}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="dk-detail-section">
          <h3 className="dk-detail-heading">操作</h3>
          <div className="dk-card-actions">
            {project.status === 'awaiting-review' && (
              <>
                <button className="dk-btn dk-btn-primary" onClick={() => { onAction({ kind: 'confirm-plan', projectId: project.id }) }}>确认方案</button>
                <button className="dk-btn dk-btn-danger" onClick={() => { setRejecting(!rejecting) }}>{rejecting ? '取消' : '驳回'}</button>
              </>
            )}
            {project.status === 'blocked' && (
              <button className="dk-btn" onClick={() => { onAction({ kind: 'transition', projectId: project.id, to: 'designing', note: 're-design from blocked' }) }}>重新设计</button>
            )}
            <button
              className="dk-btn dk-btn-ghost"
              onClick={() => { if (globalThis.confirm(`删除项目「${project.title}」？`)) onAction({ kind: 'delete-project', projectId: project.id }) }}
            >删除</button>
          </div>
          {rejecting && (
            <RejectForm
              projectId={project.id}
              onSubmit={feedback => { onAction({ kind: 'reject-plan', projectId: project.id, feedback }) }}
            />
          )}
        </section>
      </div>
    </div>
  )
}

/** Heading tag per markdown level; downshifted two steps because the view already has h2/h3 chrome. */
const HEADING_TAGS = ['h4', 'h5', 'h6', 'h6', 'h6', 'h6'] as const

/** Inline subset: `code` and **bold**. Everything else stays literal text. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)/g
  let last = 0
  let key = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('`')) nodes.push(<code key={key++}>{token.slice(1, -1)}</code>)
    else nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/**
 * Zero-dependency markdown subset renderer (confirmed by the creator over a
 * monospace dump): fenced code blocks, headings, unordered/ordered lists,
 * paragraphs, plus the inline subset above. React text nodes do the HTML
 * escaping — no dangerouslySetInnerHTML anywhere.
 */
function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  let key = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') { index++; continue }
    if (line.startsWith('```')) {
      const code: string[] = []
      index++
      while (index < lines.length && !lines[index].startsWith('```')) { code.push(lines[index]); index++ }
      index++ // skip the closing fence (or run off the end)
      blocks.push(<pre key={key++} className="dk-md-code"><code>{code.join('\n')}</code></pre>)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const Tag = HEADING_TAGS[heading[1].length - 1]
      blocks.push(<Tag key={key++}>{renderInline(heading[2])}</Tag>)
      index++
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''))
        index++
      }
      blocks.push(<ul key={key++}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''))
        index++
      }
      blocks.push(<ol key={key++}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ol>)
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() !== '') { paragraph.push(lines[index]); index++ }
    blocks.push(<p key={key++}>{renderInline(paragraph.join(' '))}</p>)
  }
  return <div className="dk-md">{blocks}</div>
}

function RejectForm({ projectId, onSubmit }: { projectId: string; onSubmit(feedback: string): void }): JSX.Element {
  const [feedback, setFeedback] = useState('')
  return (
    <div className="dk-reject">
      <textarea
        placeholder="驳回原因 / 修改要求（会作为反馈发给设计 agent）"
        value={feedback}
        onChange={event => { setFeedback(event.target.value) }}
      />
      <div className="dk-card-actions">
        <button className="dk-btn dk-btn-danger" disabled={feedback.trim() === ''} onClick={() => { onSubmit(feedback.trim()) }}>提交驳回</button>
      </div>
    </div>
  )
}

export interface NewProjectInput {
  title: string
  workspaceDir: string
  goal: string
}

function NewProjectModal({ getDefaultWorkspaceDir, onCancel, onCreate }: {
  getDefaultWorkspaceDir(): string
  onCancel(): void
  onCreate(input: NewProjectInput): void
}): JSX.Element {
  // Evaluated when the modal opens: the workspace list may not have been
  // ready when the board mounted, so the default must be read live.
  const [title, setTitle] = useState('')
  const [workspaceDir, setWorkspaceDir] = useState(() => getDefaultWorkspaceDir())
  const [goal, setGoal] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const valid = title.trim() !== '' && workspaceDir.trim() !== '' && goal.trim() !== ''

  const submit = (): void => {
    if (!valid) {
      // A disabled button looks exactly like an enabled one in this skin;
      // always accept the click and explain why nothing was created.
      setSubmitError('请填写项目名称、工作目录和目标')
      return
    }
    onCreate({ title: title.trim(), workspaceDir: workspaceDir.trim(), goal: goal.trim() })
  }

  return (
    <div className="dk-modal-overlay" onClick={onCancel}>
      <div className="dk-modal" onClick={event => { event.stopPropagation() }}>
        <h3 style={{ margin: 0, fontSize: '15px' }}>新建项目</h3>
        <div className="dk-field">
          <label htmlFor="dk-title">项目名称</label>
          <input id="dk-title" value={title} placeholder="例如：重构看板后端" onChange={event => { setTitle(event.target.value); setSubmitError(null) }} />
        </div>
        <div className="dk-field">
          <label htmlFor="dk-workspace">工作目录（agent 在此执行）</label>
          <input id="dk-workspace" value={workspaceDir} placeholder="/path/to/workspace" onChange={event => { setWorkspaceDir(event.target.value); setSubmitError(null) }} />
        </div>
        <div className="dk-field">
          <label htmlFor="dk-goal">项目目标（一句话）</label>
          <input id="dk-goal" value={goal} placeholder="例如：把任务看板的后端迁移到 SQLite" onChange={event => { setGoal(event.target.value); setSubmitError(null) }} />
        </div>
        {submitError !== null && <p className="dk-modal-error">{submitError}</p>}
        <div className="dk-modal-actions">
          <button className="dk-btn" onClick={onCancel}>取消</button>
          <button className="dk-btn dk-btn-primary" onClick={submit}>创建并开始设计</button>
        </div>
      </div>
    </div>
  )
}
