/**
 * Kanban session runner: drives real dsh sessions through the host Session
 * Controller.
 *
 * Launch = create (with cwd) + rename + prompt(mode:'queue').
 * Completion = inspecting the Session event log for the LAST turn/end inside
 * the observation window (see inspect). A turn/end whose reason is an error is
 * NOT a terminal leaf failure: under the board's recovery policy the leaf
 * keeps observing the same session for a later turn (the production incident
 * behind this: a 403 quota error ended turn 1, a human continued the session
 * 14 minutes later and turn 2 actually finished the work). The poll loop lives
 * in spawner.ts.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionController, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { FailureCause, FailureDiagnostic, Project, TaskNode } from './protocol.ts'

/** One session-list row (the narrow slice the runner inspects). */
export interface KanbanSessionSummary {
  sessionId: string
  running: boolean
  completed?: boolean
  blank?: boolean
  agentPreset?: string
}

/** One history event (the narrow slice the runner inspects). */
export interface KanbanHistoryEvent {
  event: { type: string; seq?: number; time?: number; data: unknown }
}

/** The host Session Controller surface the runner uses. */
export interface KanbanApi {
  create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }> }): Promise<unknown>
  list(request: { cursor?: string }): Promise<{ items: readonly KanbanSessionSummary[] }>
  inspect(sessionId: string): Promise<{ events: readonly KanbanHistoryEvent[] }>
  /** Stop the session's active turn. */
  cancel(request: { sessionId: string }): Promise<unknown>
}

/**
 * The 6-value turn/end vocabulary of `@deepseek-ai/dsh-session`'s
 * TurnEndReasonMap. Kept as a closed union so a new reason kind makes the
 * verdict table below fail to compile (see TURN_END_VERDICT).
 */
export type TurnEndKind = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted'

/** What the board does with a decoded turn/end. */
export type TurnVerdict =
  /** An explicit success terminal: settle (execute → done, research/design → artifact gate). */
  | 'succeeded'
  /** NOT a terminal verdict for the leaf: keep observing this session for a later turn. */
  | 'observing'
  /** The session cannot make progress on its own: converge to blocked with a readable note. */
  | 'stopped'

/** `LlmFailure` facts pulled out verbatim from an error turn/end (indexed access: no dsh-llm dependency). */
type LlmFailureFacts = Extract<TurnEndReason, { kind: 'error' }>['error']

/** The cancellation cause of an aborted turn (user/parent/hook/disposed/legacy). */
type TurnCancelCause = Extract<TurnEndReason, { kind: 'aborted' }>['reason']

/**
 * One turn/end decoded into objective facts. No verdict here — see
 * verdictFor(); keeping decode and judgement apart is what makes the
 * observability fields trustworthy (nothing is folded away).
 */
export interface TurnEndFacts {
  /** The decoded reason kind; 'unknown' means a kind this build does not know. */
  kind: TurnEndKind | 'unknown'
  /** The raw reason.kind when kind === 'unknown' (a newer DSH wrote the log). */
  rawKind?: string
  /** The turn number the event belongs to (data.turn), when present. */
  turn?: number
  /** The event's seq, when present. */
  seq?: number
  /** The event's own time (epoch millis), not the moment it was read. */
  time?: number
  /** kind === 'error': the structured LlmFailure, verbatim. */
  failure?: { message: string; code?: string; status?: number }
  /** kind === 'aborted': the cancellation cause kind. */
  cancelCause?: string
  /** true when the event carried no data.reason at all (see decodeTurnEnd). */
  legacyReason?: true
}

/**
 * One execution's resolved outcome.
 *
 * `pending` carries WHY it is pending: 'running' (the session is alive — the
 * only legitimate wait) versus 'no-evidence' (not running and no judgeable
 * turn/end in the window). A recovery window must be able to converge out of
 * the latter (otherwise a leaf whose prompt never landed becomes a zombie).
 */
export type ExecutionInspection =
  | { outcome: 'pending'; pending: 'running' | 'no-evidence' }
  | { outcome: 'succeeded'; turn: TurnEndFacts }
  | { outcome: 'observing'; turn: TurnEndFacts; note: string }
  | { outcome: 'stopped'; turn: TurnEndFacts; note: string }
  | { outcome: 'cancelled'; error: string }

/**
 * Error codes that mean "this session cannot progress, waiting is pointless".
 * Deliberately narrow: the production incident's code was `AUTH` (a 5-hour
 * quota exhaustion behind an HTTP 403) and the human continued the same
 * session successfully after switching models — so AUTH/QUOTA/RATE_LIMIT/…
 * must stay on the observing side. Guarded by a test.
 */
export const SESSION_CANNOT_PROGRESS_CODES: readonly string[] = [
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_CREDENTIAL',
]

/** Compile-time exhaustiveness guard (a new reason kind must fail the build, never fall through to "success"). */
function assertNever(value: never): never {
  throw new Error(`unhandled turn/end verdict plan: ${String(value)}`)
}

/**
 * reason.kind → disposition. Typed as a total map over TurnEndKind: adding a
 * kind to the union without extending this table is a compile error.
 */
const TURN_END_VERDICT: { readonly [K in TurnEndKind]: TurnVerdict | 'by-cause' | 'by-code' } = {
  completed: 'succeeded',
  // Policy A: one failed turn is not a failed leaf — the session may be
  // continued (by a human, a model switch, or a restart) and finish later.
  error: 'by-code',
  aborted: 'by-cause',
  blocked: 'stopped',
  'max-tokens': 'stopped',
  // A crash-orphaned turn closed by the persistence layer: the real recovery
  // path is the host-restart re-fire + resume, so waiting is correct.
  interrupted: 'observing',
}

/** Turn/end verdict for one decoded turn (pure; the caller applies it). */
export function verdictFor(sessionId: string, turn: TurnEndFacts): { verdict: TurnVerdict; note: string } {
  if (turn.kind === 'unknown') return { verdict: 'stopped', note: describeTurnEnd(sessionId, turn) }
  const plan = TURN_END_VERDICT[turn.kind]
  switch (plan) {
    case 'succeeded':
      return { verdict: 'succeeded', note: describeTurnEnd(sessionId, turn) }
    case 'observing':
      return { verdict: 'observing', note: describeTurnEnd(sessionId, turn) }
    case 'stopped':
      return { verdict: 'stopped', note: describeTurnEnd(sessionId, turn) }
    case 'by-cause': {
      // A disposed host is shutting down, not vetoing the work: the restart
      // recovery flow resumes this session. Every other cancellation (human
      // stop, parent, hook, legacy) means "do not count this as progress".
      const cause = turn.cancelCause ?? 'legacy'
      return {
        verdict: cause === 'disposed' ? 'observing' : 'stopped',
        note: describeTurnEnd(sessionId, turn),
      }
    }
    case 'by-code':
      return { verdict: errorVerdict(turn), note: describeTurnEnd(sessionId, turn) }
  }
  return assertNever(plan)
}

/**
 * Whether an error turn leaves the leaf observing or stops it: only the two
 * "this session cannot progress" codes stop it (see
 * SESSION_CANNOT_PROGRESS_CODES). Everything else — including the incident's
 * AUTH/403 quota error — keeps observing.
 */
function errorVerdict(turn: TurnEndFacts): TurnVerdict {
  const code = turn.failure?.code
  return code !== undefined && SESSION_CANNOT_PROGRESS_CODES.includes(code) ? 'stopped' : 'observing'
}

/**
 * Collapse whitespace/control characters and bound a note (the ledger is
 * whole-file write-through, so every persisted note MUST be bounded). The
 * ellipsis counts against the limit: the result is never longer than `limit`.
 */
function scrub(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/** The `[turn N, seq S, ISO]` evidence bracket; omitted when nothing is known. */
function evidenceBracket(turn: TurnEndFacts): string {
  const parts: string[] = []
  if (turn.turn !== undefined) parts.push(`turn ${turn.turn}`)
  if (turn.seq !== undefined) parts.push(`seq ${turn.seq}`)
  if (turn.time !== undefined && turn.time > 0) parts.push(new Date(turn.time).toISOString())
  return parts.length === 0 ? '' : ` [${parts.join(', ')}]`
}

/**
 * The ONE place a turn/end becomes human-readable text. Every failure note in
 * the ledger goes through here, so the wording can never drift between the
 * poll path, the recovery path and the stale timer.
 *
 * Shape: `session <sid> <verdict>: <detail>[ [turn N, seq S, ISO]]`.
 * The `session <sid> failed:` prefix of the pre-recovery build is preserved
 * so existing greps keep working.
 */
export function describeTurnEnd(sessionId: string, turn: TurnEndFacts): string {
  const bracket = evidenceBracket(turn)
  const prefix = `session ${sessionId}`
  if (turn.legacyReason === true) return scrub(`${prefix} completed: legacy turn/end without a reason${bracket}`, 400)
  switch (turn.kind) {
    case 'completed':
      return scrub(`${prefix} completed${bracket}`, 400)
    case 'error': {
      const failure = turn.failure
      const where = failure?.code === undefined ? '' : failure.code
      const http = failure?.status === undefined ? '' : ` (HTTP ${failure.status})`
      const message = scrub(failure?.message ?? 'unrecognized failure', 200)
      const detail = `${where}${http}`.trim()
      const head = detail === '' ? `failed: ${message}` : `failed: ${detail} ${message}`
      const tail = errorVerdict(turn) === 'stopped'
        ? ' (this session cannot progress; needs a human)'
        : ' (keeping the leaf under observation for a later turn in this session)'
      return scrub(`${prefix} ${head}${bracket}${tail}`, 400)
    }
    case 'aborted': {
      const cause = turn.cancelCause ?? 'legacy'
      const tail = cause === 'disposed' ? ' (host shutdown; the restart recovery resumes it)' : ''
      return scrub(`${prefix} aborted: cancelled by ${cause}${bracket}${tail}`, 400)
    }
    case 'max-tokens':
      return scrub(`${prefix} ended: hit the output token ceiling${bracket}`, 400)
    case 'blocked':
      return scrub(`${prefix} ended: blocked${bracket}`, 400)
    case 'interrupted':
      return scrub(`${prefix} interrupted: crash-orphaned turn closed after the fact${bracket} (keeping the leaf under observation)`, 400)
    case 'unknown':
      return scrub(`${prefix} unknown: unrecognized turn/end reason ${turn.rawKind ?? '<missing>'}${bracket}`, 400)
  }
  return assertNever(turn.kind)
}

/**
 * Decode one turn/end event into facts. Never throws and never returns
 * undefined.
 *
 * The ONE deliberate "unknown means success": an event with no `data.reason`
 * at all predates this vocabulary (and several round-trip fixtures use it),
 * so it keeps the historical meaning (a completed turn) — but it is flagged
 * with `legacyReason` so it stays countable. A reason.kind that IS present but
 * unrecognized is the opposite: 'unknown' and fail-safe (never silently
 * treated as success).
 */
export function decodeTurnEnd(data: unknown, seq?: number, time?: number): TurnEndFacts {
  const base: Pick<TurnEndFacts, 'seq' | 'time'> = {
    ...(seq === undefined ? {} : { seq }),
    ...(time === undefined ? {} : { time }),
  }
  if (typeof data !== 'object' || data === null) return { kind: 'completed', legacyReason: true, ...base }
  const turn = typeof (data as { turn?: unknown }).turn === 'number' ? (data as { turn: number }).turn : undefined
  const withTurn: Pick<TurnEndFacts, 'seq' | 'time' | 'turn'> = { ...base, ...(turn === undefined ? {} : { turn }) }
  const reason = (data as { reason?: unknown }).reason
  if (reason === undefined || reason === null) return { kind: 'completed', legacyReason: true, ...withTurn }
  if (typeof reason !== 'object') return { kind: 'unknown', ...withTurn }
  const kind = (reason as { kind?: unknown }).kind
  if (typeof kind !== 'string') return { kind: 'unknown', ...withTurn }
  if (kind === 'error') {
    const payload = (reason as { error?: unknown }).error
    const fallback = (reason as { message?: unknown }).message
    const message = typeof payload === 'object' && payload !== null && typeof (payload as { message?: unknown }).message === 'string'
      ? (payload as { message: string }).message
      : typeof fallback === 'string' ? fallback : 'unrecognized failure'
    const code = typeof payload === 'object' && payload !== null && typeof (payload as { code?: unknown }).code === 'string'
      ? (payload as { code: string }).code
      : undefined
    const status = typeof payload === 'object' && payload !== null && typeof (payload as { status?: unknown }).status === 'number'
      ? (payload as { status: number }).status
      : undefined
    return {
      kind: 'error',
      failure: { message, ...(code === undefined ? {} : { code }), ...(status === undefined ? {} : { status }) },
      ...withTurn,
    }
  }
  if (kind === 'aborted') {
    // The payload nests a second `reason`: {kind:'aborted', reason:{kind:'user'}}.
    const nested = (reason as { reason?: unknown }).reason
    const cancelCause = typeof nested === 'object' && nested !== null && typeof (nested as { kind?: unknown }).kind === 'string'
      ? (nested as { kind: string }).kind
      : 'legacy'
    return { kind: 'aborted', cancelCause, ...withTurn }
  }
  if (kind === 'completed' || kind === 'blocked' || kind === 'max-tokens' || kind === 'interrupted') {
    return { kind, ...withTurn }
  }
  return { kind: 'unknown', rawKind: scrub(kind, 60), ...withTurn }
}

/**
 * Turn/end evidence → the persisted failure diagnostic. `recoverable` is an
 * advisory UI hint only; it never gates the recovery entry point.
 */
export function turnEndDiagnostic(sessionId: string, turn: TurnEndFacts, cause: FailureCause = 'turn-end'): FailureDiagnostic {
  return {
    at: Date.now(),
    cause,
    message: describeTurnEnd(sessionId, turn),
    reason: turn.kind,
    ...(turn.cancelCause === undefined ? {} : { cancelCause: turn.cancelCause }),
    ...(turn.failure?.code === undefined ? {} : { code: turn.failure.code }),
    ...(turn.failure?.status === undefined ? {} : { status: turn.failure.status }),
    ...(turn.turn === undefined ? {} : { turn: turn.turn }),
    ...(turn.seq === undefined ? {} : { seq: turn.seq }),
    sessionId,
    recoverable: true,
  }
}

/**
 * A non-turn/end failure (launch RPC, missing artifact, malformed additions,
 * stale timer). A vanished session is the only definitively unrecoverable
 * cause — and even then the UI only changes its hint, not the entry point.
 */
export function failureDiagnostic(cause: FailureCause, message: string, sessionId?: string): FailureDiagnostic {
  return {
    at: Date.now(),
    cause,
    message: scrub(message, 400),
    ...(sessionId === undefined ? {} : { sessionId }),
    recoverable: cause !== 'session-missing',
  }
}

/** A post-create launch failure that still identifies the session. */
export class SessionLaunchError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    super(`execution session ${sessionId} failed during launch: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'SessionLaunchError'
  }
}

/**
 * Adapt the branded current Session Controller contract to the small,
 * string-based surface persisted by the kanban ledger.
 */
export function createKanbanApi(controller: SessionController): KanbanApi {
  const sessionId = (value: string): SessionId => value as SessionId
  const signal = (): AbortSignal => new AbortController().signal
  return {
    create: async request => controller.create(request),
    rename: async request => controller.rename({ ...request, sessionId: sessionId(request.sessionId) }),
    prompt: async request => controller.prompt({
      ...request,
      requestId: request.requestId as SessionRequestId,
      sessionId: sessionId(request.sessionId),
    }, signal()),
    list: async request => controller.list(request, signal()),
    inspect: async value => {
      const inspection = await controller.inspect(sessionId(value), signal())
      return { events: inspection.events.map(event => ({ event })) }
    },
    cancel: async request => controller.cancel({ sessionId: sessionId(request.sessionId) }),
  }
}

function requestId(): string {
  return `kanban-${crypto.randomUUID()}`
}

/**
 * Compare two turn/end events and report which one is newer. Deterministic
 * and robust to missing fields: seq wins when both have one, then time, then
 * the array order (the log is append-only, so the later element is the later
 * event).
 */
function compareTurnEnd(a: KanbanHistoryEvent, b: KanbanHistoryEvent): 'a-newer' | 'b-newer' | 'tie' {
  const aSeq = a.event.seq
  const bSeq = b.event.seq
  if (typeof aSeq === 'number' && typeof bSeq === 'number') {
    return aSeq === bSeq ? 'tie' : aSeq > bSeq ? 'a-newer' : 'b-newer'
  }
  const aTime = a.event.time
  const bTime = b.event.time
  if (typeof aTime === 'number' && typeof bTime === 'number') {
    return aTime === bTime ? 'tie' : aTime > bTime ? 'a-newer' : 'b-newer'
  }
  return 'tie'
}

/** The newest turn/end of a window (ties resolve to the later array element). */
function latestTurnEnd(events: readonly KanbanHistoryEvent[]): KanbanHistoryEvent | undefined {
  return events.reduce<KanbanHistoryEvent | undefined>(
    (latest, entry) => (latest === undefined || compareTurnEnd(entry, latest) !== 'b-newer' ? entry : latest),
    undefined,
  )
}

/** The design agent's plan file name (inside the per-project artifact dir). */
export const PLAN_FILE = 'plan.md'

/** The design agent's decomposition file name (inside the per-project artifact dir). */
export const DECOMPOSITION_FILE = 'tasks.json'

/**
 * The execution agent's task-additions request file name (inside the
 * per-project artifact dir). Same schema as tasks.json; consumed (renamed
 * to *.consumed.json) by the host when an execute turn settles.
 */
export const TASK_ADDITIONS_FILE = 'tasks-additions.json'

/**
 * The per-project artifact directory: every artifact a project produces
 * lives under <workspaceDir>/.kanban/projects/<projectId>/, so projects
 * sharing one workspaceDir never overwrite or delete each other's files.
 * This is the single place artifact paths are derived from.
 */
export function projectDir(project: Project): string {
  return join(project.workspaceDir, '.kanban', 'projects', project.id)
}

/** The plan file the design agent writes for this project. */
export function planPathFor(project: Project): string {
  return join(projectDir(project), PLAN_FILE)
}

/** The decomposition file the design agent writes for this project. */
export function decompositionPathFor(project: Project): string {
  return join(projectDir(project), DECOMPOSITION_FILE)
}

/** The task-additions request file an execution agent may write mid-run. */
export function taskAdditionsPathFor(project: Project): string {
  return join(projectDir(project), TASK_ADDITIONS_FILE)
}

/**
 * The lifecycle stages a `tasks-additions*` file can be in.
 *
 * - `fresh`: the mutable slot the agent writes (`tasks-additions.json`). It is
 *   the ONLY overwritable path, so the host freezes it into a staged file as
 *   soon as it is stable — otherwise a second `write` in the same session
 *   physically destroys the first request (which is exactly how the
 *   `5f320d90` requests from turns 2 and 4 were lost).
 * - `pending`: ingested, immutable, waiting for a human click.
 * - `consuming`: claimed by a consumer that is materializing it right now.
 * - `consumed`: terminal audit copy of a successfully materialized request.
 */
export type TaskAdditionsStage = 'fresh' | 'pending' | 'consuming' | 'consumed'

/** One recognized request file, as classified from its basename. */
export interface TaskAdditionsFileRef {
  /** Basename exactly as it sits in the project directory. */
  name: string
  stage: TaskAdditionsStage
  /** The SOURCE file's mtime (epoch millis); staged names embed it as their identity. */
  mtimeMs: number
  /** Tie-breaker for two staged files sharing one mtime (0 when absent). */
  ordinal: number
}

/** The stem every staged request file shares (`tasks-additions`). */
const TASK_ADDITIONS_STEM = TASK_ADDITIONS_FILE.replace(/\.json$/, '')

/** `tasks-additions.<mtimeMs>[.<ordinal>].<stage>.json`. */
const TASK_ADDITIONS_STAGED_PATTERN = /^tasks-additions\.(\d+)(?:\.(\d+))?\.(pending|consuming|consumed)\.json$/

/**
 * Classify one directory entry as a task-additions file (or not). This is the
 * single matcher shared by the probe, the ingest phase and the consumer, so
 * "what the board shows" and "what gets consumed" can never drift apart.
 * @param name - a directory entry name.
 * @returns the classified reference, or undefined for anything else.
 */
export function classifyTaskAdditionsFile(name: string): TaskAdditionsFileRef | undefined {
  if (name === TASK_ADDITIONS_FILE) return { name, stage: 'fresh', mtimeMs: 0, ordinal: 0 }
  const match = TASK_ADDITIONS_STAGED_PATTERN.exec(name)
  if (match === null) return undefined
  return {
    name,
    stage: match[3] as TaskAdditionsStage,
    mtimeMs: Number(match[1]),
    ordinal: match[2] === undefined ? 0 : Number(match[2]),
  }
}

/** The staged file name for one request (the inverse of classifyTaskAdditionsFile). */
export function taskAdditionsStagedName(mtimeMs: number, stage: 'pending' | 'consuming' | 'consumed', ordinal = 0): string {
  const suffix = ordinal === 0 ? '' : `.${ordinal}`
  return `${TASK_ADDITIONS_STEM}.${mtimeMs}${suffix}.${stage}.json`
}

/**
 * A staged name that does not exist yet: two files sharing one mtime (or two
 * audits in the same millisecond) must never overwrite each other — POSIX
 * rename silently replaces the target.
 * @param dir - the project artifact directory.
 * @param mtimeMs - the source file's mtime (the identity of the request).
 * @param stage - the target stage.
 * @param exists - existence predicate (injected for testability).
 */
export function uniqueTaskAdditionsName(
  dir: string,
  mtimeMs: number,
  stage: 'pending' | 'consuming' | 'consumed',
  exists: (path: string) => boolean = existsSync,
): string {
  for (let ordinal = 0; ordinal < 1000; ordinal += 1) {
    const candidate = taskAdditionsStagedName(mtimeMs, stage, ordinal)
    if (!exists(join(dir, candidate))) return candidate
  }
  throw new Error(`cannot allocate a unique ${stage} name for mtime ${mtimeMs}`)
}

/**
 * Every task-additions file of a project that is NOT yet materialized
 * (fresh / pending / consuming), as basenames sorted for stable display.
 * Used by the fresh-design note so a kept request is visible in the history
 * instead of silently surviving the directory clean-up.
 * @param project - the project whose artifact directory is inspected.
 */
export function pendingAdditionsFileNames(project: Project): string[] {
  const dir = projectDir(project)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map(name => classifyTaskAdditionsFile(name))
    .filter((ref): ref is TaskAdditionsFileRef => ref !== undefined)
    .filter(ref => ref.stage === 'fresh' || ref.stage === 'pending' || ref.stage === 'consuming')
    .map(ref => ref.name)
    .sort()
}

/** The directory holding this project's task-leaf artifacts. */
export function projectArtifactsDir(project: Project): string {
  return join(projectDir(project), 'artifacts')
}

/**
 * The plan path a prompt should point at: a persisted planPath (e.g. a
 * legacy project whose plan still sits at the workspace root) wins;
 * otherwise the per-project artifact dir.
 */
function planPathHint(project: Project): string {
  return project.planPath ?? planPathFor(project)
}

/** The design agent's task prompt: produce the plan (and optionally the decomposition), then stop. */
export function designPrompt(project: Project): string {
  return [
    '你是 dsh-kanban 的设计 agent。请为以下项目目标产出一份可执行的方案。',
    '',
    `项目：${project.title}`,
    `工作目录：${project.workspaceDir}`,
    `目标：${project.goal}`,
    '',
    '要求：',
    `1. 把方案写入 ${planPathFor(project)}（Markdown）。`,
    '2. 方案必须包含：目标拆解、执行步骤、验收标准。',
    '3. 判断任务本身是否已经具体到可直接执行。如果不可直接执行，额外把拆解清单写入',
    `   ${decompositionPathFor(project)}，格式如下：`,
    '   { "decomposed": true, "tasks": [',
    '     { "title": "子任务标题", "kind": "clarify", "question": "需要创建人明确的问题" },',
    '     { "title": "子任务标题", "kind": "research" },',
    '     { "title": "子任务标题", "kind": "design", "subtasks": [ ... ] },',
    '     { "title": "子任务标题", "kind": "execute" }',
    '   ] }',
    '   kind 取值：clarify=需与创建人明确目标/输入（必须带 question）；research=需提前调研；',
    '   design=复杂设计的一部分（可嵌套 subtasks 继续拆解）；execute=任务的具体执行。',
    '   拆解可以嵌套任意深度，只有最底层（没有 subtasks）的任务会被执行。',
    '   子任务之间有先后依赖时，用 dependsOn 声明（值为同项目其他子任务的标题，嵌套子任务用',
    '   "父标题 > 子标题" 的完整路径）：如编码实现依赖架构设计、测试验证依赖编码实现时：',
    '     { "title": "编码实现", "kind": "execute", "dependsOn": ["架构设计"] },',
    '     { "title": "测试验证", "kind": "execute", "dependsOn": ["编码实现"] }',
    '   有依赖关系的子任务必须在依赖完成后才能开始，请务必声明清楚。',
    '4. 如果任务可直接执行，不要写 tasks.json。',
    '5. 全部完成后结束你的回合，不要继续做其他事。',
  ].join('\n')
}

/** The parent long-running project's identity, injected into execute prompts. */
export interface ParentProjectContext {
  title: string
  goal: string
}

/** The one-line affiliation context appended to execute prompts. */
function parentContextLine(parent: ParentProjectContext | undefined): string[] {
  return parent === undefined ? [] : [`本项目隶属于长期项目：${parent.title} — ${parent.goal}`]
}

/**
 * The mid-execution split instructions appended to execute prompts (both
 * project-level and leaf-level): the agent may request new task leaves by
 * writing the task-additions file, and the host picks the request up.
 *
 * The last line is worded to match what the host actually guarantees: a
 * request written BEFORE the turn settles is materialized automatically; a
 * request written after the leaf was already settled (a human continued the
 * session) is picked up by the scan phase, shown on the board as「待处理的
 * 新增任务请求」and materialized on the human's click. Promising an
 * unconditional auto-materialization is exactly the contract the incident
 * broke, so it is not promised here.
 */
function taskAdditionsLines(project: Project): string[] {
  return [
    '',
    '如果在执行过程中发现方案未覆盖、且必须新增的独立工作项：',
    `1. 把它们写入 ${taskAdditionsPathFor(project)}，格式与 tasks.json 完全相同`,
    '   （decomposed/tasks/title/kind/dependsOn），dependsOn 可引用本项目任何已有子任务的标题路径；',
    '2. 只拆分超出当前任务范围的新工作，不要重复拆分你正在执行的任务本身；',
    '3. 写完后再结束你的回合；宿主会读取该请求并在看板上按依赖调度；',
    '   同一会话可多次写入，宿主会逐批接收（不会互相覆盖）；',
    '   若本回合结束时任务已被结算完成，请求会以「待处理的新增任务请求」出现在看板上，由创建人点击物化。',
  ]
}

/** The execution agent's task prompt: read the confirmed plan and execute it. */
export function executePrompt(project: Project, parent?: ParentProjectContext): string {
  return [
    '你是 dsh-kanban 的执行 agent。方案已经人工确认，请执行。',
    '',
    `项目：${project.title}`,
    `工作目录：${project.workspaceDir}`,
    `方案文件：${planPathHint(project)}`,
    ...parentContextLine(parent),
    '',
    '要求：按照方案逐步执行，全部完成后结束你的回合。',
    ...taskAdditionsLines(project),
  ].join('\n')
}

/** The design-resume prompt: apply the human's feedback, then stop. */
export function resumePrompt(project: Project): string {
  return [
    '设计需要修改。人工反馈如下：',
    '',
    project.feedback ?? '（无具体反馈，请自行检查方案质量后改进）',
    '',
    `请修改 ${planPathHint(project)} 后结束你的回合。`,
  ].join('\n')
}

/** The execution-resume prompt: the host restarted mid-run, continue in this session. */
export function executeResumePrompt(project: Project): string {
  return [
    '你是 dsh-kanban 的执行 agent。宿主已重启，你的任务尚未完成，请继续。',
    '',
    `项目：${project.title}`,
    `工作目录：${project.workspaceDir}`,
    `方案文件：${planPathHint(project)}`,
    '',
    '请检查当前进度，继续按方案执行，全部完成后结束你的回合。',
  ].join('\n')
}

/** The artifact file of a research/design leaf. */
export function taskArtifactPath(project: Project, taskId: string): string {
  return join(projectArtifactsDir(project), `${taskId}.md`)
}

/** The research leaf prompt: investigate the question, write the report, stop. */
export function researchTaskPrompt(task: TaskNode, project: Project): string {
  return [
    '你是 dsh-kanban 的调研 agent。请针对以下调研子任务做前期调研。',
    '',
    `子任务：${task.titlePath}`,
    `所属项目：${project.title}（目标：${project.goal}）`,
    `项目方案：${planPathHint(project)}`,
    '',
    `要求：把调研结论写入 ${taskArtifactPath(project, task.id)}（Markdown），写完结束你的回合。`,
  ].join('\n')
}

/** The design-part leaf prompt: produce this part of the design, stop. */
export function designTaskPrompt(task: TaskNode, project: Project): string {
  return [
    '你是 dsh-kanban 的设计 agent。请完成以下设计子任务（它是项目复杂设计的一部分）。',
    '',
    `子任务：${task.titlePath}`,
    `所属项目：${project.title}（目标：${project.goal}）`,
    `项目方案：${planPathHint(project)}`,
    '',
    `要求：把该部分设计写入 ${taskArtifactPath(project, task.id)}（Markdown），写完结束你的回合。`,
  ].join('\n')
}

/** The execute leaf prompt: run this leaf with the plan and clarification context. */
export function executeTaskPrompt(
  task: TaskNode,
  project: Project,
  clarifications: ReadonlyArray<{ question: string; answer: string }>,
  parent?: ParentProjectContext,
): string {
  const lines = [
    '你是 dsh-kanban 的执行 agent。请执行以下子任务。',
    '',
    `子任务：${task.titlePath}`,
    `所属项目：${project.title}`,
    `工作目录：${project.workspaceDir}`,
    `项目方案：${planPathHint(project)}`,
    ...parentContextLine(parent),
  ]
  if (clarifications.length > 0) {
    lines.push('', '已确认的目标澄清记录：')
    for (const item of clarifications) lines.push(`- 问：${item.question}；答：${item.answer}`)
  }
  lines.push('', '要求：按方案执行该子任务，全部完成后结束你的回合。', ...taskAdditionsLines(project))
  return lines.join('\n')
}

export class KanbanSessionRunner {
  constructor(private readonly api: KanbanApi) {}

  /** Create + rename + prompt a fresh design session; returns the session id. */
  async launchDesign(project: Project): Promise<string> {
    this.clearStaleArtifacts(project)
    return this.launch(project, designPrompt(project), `${project.title}·设计`)
  }

  /**
   * A fresh design round must start from a clean PLAN: a leftover
   * plan.md/tasks.json from a previous round of THIS project would either
   * be reused by the agent ("the plan already exists") or materialized as a
   * stale decomposition on confirm.
   *
   * It must NOT clear anything else. The original `rm -rf <projectDir>`
   * also destroyed every `tasks-additions*` request (silently: no note, no
   * rename, no way back) even though a request is not a stale plan — it is a
   * not-yet-effective new intent, and the trigger is a HUMAN click. The
   * `artifacts/` directory is kept for the same reason: leaves that are
   * still in the ledger must not be left with dangling artifact paths.
   */
  private clearStaleArtifacts(project: Project): void {
    const dir = projectDir(project)
    rmSync(join(dir, PLAN_FILE), { force: true })
    rmSync(join(dir, DECOMPOSITION_FILE), { force: true })
  }

  /** Create + rename + prompt a fresh execution session; returns the session id. */
  async launchExecute(project: Project, parent?: ParentProjectContext): Promise<string> {
    return this.launch(project, executePrompt(project, parent), `${project.title}·执行`)
  }

  /** Create + rename + prompt a research leaf session; returns the session id. */
  async launchResearch(task: TaskNode, project: Project): Promise<string> {
    return this.launch(project, researchTaskPrompt(task, project), `${task.titlePath.split(' > ').at(-1)}·调研`)
  }

  /** Create + rename + prompt a design-part leaf session; returns the session id. */
  async launchDesignTask(task: TaskNode, project: Project): Promise<string> {
    return this.launch(project, designTaskPrompt(task, project), `${task.titlePath.split(' > ').at(-1)}·设计`)
  }

  /** Create + rename + prompt an execute leaf session; returns the session id. */
  async launchExecuteTask(
    task: TaskNode,
    project: Project,
    clarifications: ReadonlyArray<{ question: string; answer: string }>,
    parent?: ParentProjectContext,
  ): Promise<string> {
    return this.launch(project, executeTaskPrompt(task, project, clarifications, parent), `${task.titlePath.split(' > ').at(-1)}·执行`)
  }

  /** Prompt the project's existing design session with the rejection feedback. */
  async resumeDesign(project: Project): Promise<string> {
    return this.resume(project, resumePrompt(project))
  }

  /** Prompt the project's existing execution session to continue after a host restart. */
  async resumeExecute(project: Project): Promise<string> {
    return this.resume(project, executeResumePrompt(project))
  }

  /** Prompt the project's attached session with the given text; returns the session id. */
  private async resume(project: Project, text: string): Promise<string> {
    if (project.sessionId === undefined) throw new Error('resume requested but no session is attached')
    return this.resumeTaskSession(project.sessionId, text)
  }

  /** Prompt an already-attached session (project or task leaf) with the given text. */
  async resumeTaskSession(sessionId: string, text: string): Promise<string> {
    try {
      await this.api.prompt({
        requestId: requestId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  /** Whether the plan file exists on disk (the design turn's required artifact). */
  planExists(project: Project): boolean {
    // A persisted planPath (legacy root-level plan) wins for resume compat;
    // fresh projects check their own per-project artifact path.
    return existsSync(planPathHint(project))
  }

  /** Create + rename + prompt one fresh session; returns the session id. */
  private async launch(project: Project, promptText: string, title: string): Promise<string> {
    // The user may point a project at a directory that does not exist yet;
    // the design agent needs both it and the per-project artifact directory
    // before it can write plan.md.
    mkdirSync(project.workspaceDir, { recursive: true })
    mkdirSync(projectDir(project), { recursive: true })
    const created = await this.api.create({ cwd: project.workspaceDir })
    const sessionId = created.sessionId
    try {
      await this.api.rename({ sessionId, title })
      await this.api.prompt({
        requestId: requestId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptText }],
      })
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  /**
   * Best-effort cancel of a session's active turn. Every failure is
   * swallowed: the session may already have ended (or never existed on this
   * host), and a kanban terminate/delete must never be blocked by the RPC.
   */
  async cancelSession(sessionId: string): Promise<void> {
    try {
      await this.api.cancel({ sessionId })
    } catch {
      // Best-effort semantics: the board state change commits regardless.
    }
  }

  /** Count of running sessions (one sessions.list RPC per poll tick). */
  async listRunning(): Promise<{ known: true; count: number; items: KanbanSessionSummary[] } | { known: false }> {
    try {
      const response = await this.api.list({})
      const items = [...response.items]
      return { known: true, count: items.filter(item => item.running).length, items }
    } catch {
      return { known: false }
    }
  }

  /**
   * Resolve one execution's outcome. The caller may pass the session list it
   * already fetched this poll tick; otherwise the runner lists sessions itself.
   *
   * The window semantics: `startedAt` is the LOWER bound of the observation
   * window ("ignore turn/end events from before this launch/resume"), and the
   * verdict is read from the LAST (highest seq) turn/end inside it. Reading
   * the FIRST one was the production defect: an early transient error
   * permanently outranked a later successful turn, so a leaf that was still
   * being observed could never settle.
   *
   * @param sessionId - the session under inspection.
   * @param startedAt - launch timestamp (epoch millis); 0 inspects the whole history.
   * @param sessions - the poll tick's session list, when already fetched.
   */
  async inspect(sessionId: string, startedAt = 0, sessions?: readonly KanbanSessionSummary[]): Promise<ExecutionInspection> {
    let items: readonly KanbanSessionSummary[]
    if (sessions !== undefined) {
      items = sessions
    } else {
      try {
        items = (await this.api.list({})).items
      } catch {
        return { outcome: 'pending', pending: 'running' }
      }
    }
    let summary = items.find(item => item.sessionId === sessionId)
    if (summary === undefined && sessions !== undefined) {
      // Stale-snapshot self-verification: the tick's list was taken before a
      // leaf created its own session this same tick, so a miss must be
      // confirmed against a fresh list before declaring the session gone
      // (a false 'cancelled' parks a live leaf permanently).
      try {
        summary = (await this.api.list({})).items.find(item => item.sessionId === sessionId)
      } catch {
        return { outcome: 'pending', pending: 'running' }
      }
    }
    if (summary === undefined) return { outcome: 'cancelled', error: 'execution session no longer exists' }
    if (summary.running) return { outcome: 'pending', pending: 'running' }
    const events = [...(await this.api.inspect(summary.sessionId)).events]
    const inWindow = events.filter(entry => entry.event.type === 'turn/end' && (
      startedAt <= 0 || (typeof entry.event.time === 'number' && entry.event.time >= startedAt)
    ))
    const turnEnd = latestTurnEnd(inWindow)
    if (turnEnd === undefined) return { outcome: 'pending', pending: 'no-evidence' }
    const turn = decodeTurnEnd(turnEnd.event.data, turnEnd.event.seq, turnEnd.event.time)
    const { verdict, note } = verdictFor(sessionId, turn)
    switch (verdict) {
      case 'succeeded': return { outcome: 'succeeded', turn }
      case 'observing': return { outcome: 'observing', turn, note }
      case 'stopped': return { outcome: 'stopped', turn, note }
    }
    return assertNever(verdict)
  }
}
