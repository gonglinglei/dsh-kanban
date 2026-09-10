/**
 * Shared Chinese display labels, hoisted out of board.tsx so every client
 * view (board, task detail, dependency graph) renders one copy of the
 * wording instead of drifting duplicates.
 */
import type { Actor, ProjectStatus, TaskKind } from '../protocol.ts'

/** Chinese labels for every board status (detail view badges and history timeline). */
export const STATUS_LABELS: Record<ProjectStatus, string> = {
  backlog: '待开始',
  designing: '设计中',
  'awaiting-clarification': '待澄清',
  'awaiting-review': '待确认',
  executing: '执行中',
  blocked: '阻塞',
  done: '已完成',
}

/** Chinese labels for history actors. */
export const ACTOR_LABELS: Record<Actor, string> = {
  human: '人工',
  agent: 'agent',
  system: '系统',
}

/** Chinese labels for the four task kinds. */
export const KIND_LABELS: Record<TaskKind, string> = {
  clarify: '澄清',
  research: '调研',
  design: '设计',
  execute: '执行',
}
