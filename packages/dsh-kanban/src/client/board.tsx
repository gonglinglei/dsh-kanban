/**
 * The kanban board view: six columns, project cards with phase actions
 * (confirm / reject with feedback / re-design / delete), the new-project
 * modal, and a live session-open affordance. Reads the BoardStore through
 * useSyncExternalStore; every mutation goes through store.apply.
 */
import { useSyncExternalStore, useState } from 'react'
import type { Project, ProjectStatus, TaskKind, TaskNode } from '../protocol.ts'
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

/** Chinese labels for the four task kinds. */
const KIND_LABELS: Record<TaskKind, string> = {
  clarify: '澄清',
  research: '调研',
  design: '设计',
  execute: '执行',
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

  return (
    <div className="dk-board">
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
                />
              ))}
              {tasks.map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  projectTitle={snapshot.projects.find(project => project.id === task.projectId)?.title ?? ''}
                  onAction={action => { void store.apply(action) }}
                  onOpenSession={openSession}
                />
              ))}
            </section>
          )
        })}
      </div>
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
}

function ProjectCard({ project, taskCount, rejecting, onToggleReject, onAction, onOpenSession }: ProjectCardProps): JSX.Element {
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
  onAction(action: Parameters<BoardStore['apply']>[0]): void
  onOpenSession(sessionId: string): void
}

/** One decomposed task leaf: level-indented title, kind badge, and kind-specific actions. */
function TaskCard({ task, projectTitle, onAction, onOpenSession }: TaskCardProps): JSX.Element {
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
