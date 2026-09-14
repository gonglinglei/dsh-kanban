/**
 * Board stylesheet (injected as one <style data-plugin> tag; the plugin has
 * no CSS-modules pipeline yet — see Known Limitations). All rules are scoped
 * under the plugin's view attribute so nothing leaks into the rest of the
 * GUI; colors ride the dsh --dsw-* tokens with neutral fallbacks.
 */
export const BOARD_CSS = `
[data-dsh-kanban-view] {
  position: absolute; inset: 0; display: none; z-index: 60;
  background: var(--dsw-alias-bg-base, #ffffff); overflow: hidden;
}
html[data-dsh-kanban-active] [data-dsh-kanban-view] { display: block; }
html[data-dsh-kanban-active] [data-pane='conversation'] > :not([data-dsh-kanban-view]),
html[data-dsh-kanban-active] [class*='centerCol'] > :not([data-dsh-kanban-view]) {
  display: none !important;
}

[data-dsh-kanban-view] .dk-board { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
[data-dsh-kanban-view] .dk-header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 20px; border-bottom: 1px solid var(--dsw-alias-border, #e5e5e5);
  flex: 0 0 auto;
}
[data-dsh-kanban-view] .dk-title { margin: 0; font-size: 16px; font-weight: 600; }
[data-dsh-kanban-view] .dk-error {
  margin: 0; padding: 8px 12px; font-size: 12px; color: #b3261e;
  background: #fdecea; border-bottom: 1px solid #f5c6c2; flex: 0 0 auto;
}
[data-dsh-kanban-view] .dk-banner {
  margin: 0; padding: 8px 12px; font-size: 12px; color: #7a5b00;
  background: #fff7e0; border-bottom: 1px solid #efe0a8; flex: 0 0 auto;
}
[data-dsh-kanban-view] .dk-columns {
  display: flex; gap: 12px; padding: 16px 20px; overflow-x: auto;
  flex: 1 1 auto; align-items: flex-start;
}
[data-dsh-kanban-view] .dk-column {
  flex: 0 0 280px; display: flex; flex-direction: column; gap: 8px;
  background: var(--dsw-alias-bg-subtle, #f4f5f7); border-radius: 8px; padding: 8px;
  max-height: 100%; overflow-y: auto;
}
[data-dsh-kanban-view] .dk-column-title {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 13px; font-weight: 600; padding: 2px 4px;
}
[data-dsh-kanban-view] .dk-column-count {
  font-size: 11px; font-weight: 400; color: var(--dsw-alias-text-secondary, #666);
  background: var(--dsw-alias-bg-base, #fff); border-radius: 999px; padding: 1px 8px;
}
[data-dsh-kanban-view] .dk-card {
  display: flex; flex-direction: column; gap: 6px;
  background: var(--dsw-alias-bg-base, #ffffff); border: 1px solid var(--dsw-alias-border, #e0e0e0);
  border-radius: 8px; padding: 10px;
}
[data-dsh-kanban-view] .dk-card-title { margin: 0; font-size: 13px; font-weight: 600; word-break: break-all; }
[data-dsh-kanban-view] .dk-card-title .dk-kind-badge { margin-right: 6px; font-weight: 400; }
[data-dsh-kanban-view] .dk-card-parent { margin: 0; font-size: 11px; color: var(--dsw-alias-text-tertiary, #999); }
[data-dsh-kanban-view] .dk-card-goal {
  margin: 0; font-size: 12px; color: var(--dsw-alias-text-secondary, #666);
  word-break: break-all; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
[data-dsh-kanban-view] .dk-detail-qa {
  margin: 0; font-size: 12px; color: var(--dsw-alias-text-secondary, #666);
  word-break: break-all; white-space: pre-wrap;
}
[data-dsh-kanban-view] .dk-card-meta { font-size: 11px; color: var(--dsw-alias-text-tertiary, #999); }
[data-dsh-kanban-view] .dk-card-path { margin: 0; font-size: 11px; color: var(--dsw-alias-text-tertiary, #999); }
[data-dsh-kanban-view] .dk-kind-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border, #d0d0d0); color: var(--dsw-alias-text-secondary, #666);
}
[data-dsh-kanban-view] .dk-card-error { margin: 0; font-size: 12px; color: #b3261e; }
[data-dsh-kanban-view] .dk-card-waiting { margin: 0; font-size: 12px; color: #b26a00; }
[data-dsh-kanban-view] .dk-card-failure {
  margin: 0; font-size: 12px; color: #b3261e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-dsh-kanban-view] .dk-card-recovering { margin: 0; font-size: 12px; color: #b26a00; }
/* Pending task-additions request: an actionable positive hint, so it sits
   before the failure chip and reuses the amber/red palette. */
[data-dsh-kanban-view] .dk-card-pending { margin: 0; font-size: 12px; color: #b26a00; font-weight: 600; }
[data-dsh-kanban-view] .dk-card-pending-error { margin: 0; font-size: 12px; color: #b3261e; font-weight: 600; }
[data-dsh-kanban-view] .dk-pending-section { border-left: 3px solid #e0a63c; }
[data-dsh-kanban-view] .dk-pending-item { margin: 0; font-size: 12px; word-break: break-all; }
[data-dsh-kanban-view] .dk-pending-meta { margin: 0; font-size: 11px; color: var(--dsw-alias-text-tertiary, #999); }
[data-dsh-kanban-view] .dk-hint { margin: 0; font-size: 12px; color: #6b6b6b; }
[data-dsh-kanban-view] .dk-card-actions { display: flex; gap: 6px; flex-wrap: wrap; }
[data-dsh-kanban-view] .dk-btn {
  border: 1px solid var(--dsw-alias-border, #d0d0d0); background: var(--dsw-alias-bg-base, #fff);
  color: inherit; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
}
[data-dsh-kanban-view] .dk-btn:hover { border-color: var(--dsw-alias-border-strong, #999); }
[data-dsh-kanban-view] .dk-btn-primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
[data-dsh-kanban-view] .dk-btn-danger { color: #b3261e; border-color: #e0a6a2; }
[data-dsh-kanban-view] .dk-btn-ghost { border-color: transparent; color: var(--dsw-alias-text-secondary, #666); }
[data-dsh-kanban-view] .dk-reject { display: flex; flex-direction: column; gap: 6px; }
[data-dsh-kanban-view] .dk-reject textarea {
  resize: vertical; min-height: 56px; font: inherit; font-size: 12px;
  border: 1px solid var(--dsw-alias-border, #d0d0d0); border-radius: 6px; padding: 6px;
  background: var(--dsw-alias-bg-base, #fff); color: inherit;
}
[data-dsh-kanban-view] .dk-modal-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); z-index: 100;
  display: flex; align-items: center; justify-content: center;
}
[data-dsh-kanban-view] .dk-modal {
  width: 420px; max-width: calc(100vw - 48px); display: flex; flex-direction: column; gap: 12px;
  background: var(--dsw-alias-bg-base, #fff); border-radius: 10px; padding: 20px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
}
[data-dsh-kanban-view] .dk-field { display: flex; flex-direction: column; gap: 4px; }
[data-dsh-kanban-view] .dk-field label { font-size: 12px; font-weight: 600; }
[data-dsh-kanban-view] .dk-field input, [data-dsh-kanban-view] .dk-field select {
  font: inherit; font-size: 13px; border: 1px solid var(--dsw-alias-border, #d0d0d0);
  border-radius: 6px; padding: 6px 8px; background: var(--dsw-alias-bg-base, #fff); color: inherit;
}
[data-dsh-kanban-view] .dk-radio-row { display: flex; gap: 14px; font-size: 12px; }
[data-dsh-kanban-view] .dk-radio-row label { display: flex; align-items: center; gap: 4px; font-weight: 400; cursor: pointer; }
[data-dsh-kanban-view] .dk-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
[data-dsh-kanban-view] .dk-modal-error { margin: 0; font-size: 12px; color: #b3261e; }
[data-dsh-kanban-view] .dk-btn:disabled { opacity: 0.5; cursor: not-allowed; }
[data-dsh-kanban-view] .dk-empty { font-size: 12px; color: var(--dsw-alias-text-tertiary, #999); padding: 4px; }

/* Project detail view (full-screen switch inside the board container). */
[data-dsh-kanban-view] .dk-detail { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
[data-dsh-kanban-view] .dk-detail-body {
  flex: 1 1 auto; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 16px;
  max-width: 880px;
}
[data-dsh-kanban-view] .dk-detail-section {
  background: var(--dsw-alias-bg-subtle, #f4f5f7); border-radius: 8px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
[data-dsh-kanban-view] .dk-detail-heading { margin: 0; font-size: 13px; font-weight: 600; }
[data-dsh-kanban-view] .dk-detail-grid {
  margin: 0; display: grid; grid-template-columns: 88px 1fr; gap: 6px 12px; font-size: 12px;
}
[data-dsh-kanban-view] .dk-detail-grid dt { color: var(--dsw-alias-text-tertiary, #999); }
[data-dsh-kanban-view] .dk-detail-grid dd { margin: 0; word-break: break-all; }
[data-dsh-kanban-view] .dk-failure-grid {
  margin: 0; display: grid; grid-template-columns: 88px 1fr; gap: 6px 12px; font-size: 12px;
}
[data-dsh-kanban-view] .dk-failure-grid dt { color: var(--dsw-alias-text-tertiary, #999); }
[data-dsh-kanban-view] .dk-failure-grid dd { margin: 0; word-break: break-all; }
[data-dsh-kanban-view] .dk-detail-task {
  background: var(--dsw-alias-bg-base, #fff); border: 1px solid var(--dsw-alias-border, #e0e0e0);
  border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;
}
[data-dsh-kanban-view] .dk-detail-task-path { margin: 0; font-size: 12px; font-weight: 600; word-break: break-all; }
[data-dsh-kanban-view] .dk-detail-history {
  margin: 0; padding: 0 0 0 4px; list-style: none; display: flex; flex-direction: column; gap: 6px;
  border-left: 2px solid var(--dsw-alias-border, #e0e0e0);
}
[data-dsh-kanban-view] .dk-detail-history li {
  display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 12px; padding-left: 8px;
}
[data-dsh-kanban-view] .dk-detail-history-time { color: var(--dsw-alias-text-tertiary, #999); font-variant-numeric: tabular-nums; }
[data-dsh-kanban-view] .dk-detail-history-actor { font-weight: 600; }
[data-dsh-kanban-view] .dk-detail-history-note { color: var(--dsw-alias-text-secondary, #666); word-break: break-all; }

/* Sub-task dependency graph (project detail「列表 / 依赖图」switch). */
[data-dsh-kanban-view] .dk-detail-heading-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
[data-dsh-kanban-view] .dk-view-toggle { display: flex; gap: 4px; }
[data-dsh-kanban-view] .dk-view-toggle .dk-btn { padding: 2px 8px; font-size: 11px; }
[data-dsh-kanban-view] .dk-graph {
  overflow: auto; max-height: 60vh; border-radius: 8px;
  background: var(--dsw-alias-bg-subtle, #f4f5f7); border: 1px solid var(--dsw-alias-border, #e0e0e0);
}
[data-dsh-kanban-view] .dk-graph-canvas { position: relative; }
[data-dsh-kanban-view] .dk-graph-edges { position: absolute; inset: 0; pointer-events: none; }
[data-dsh-kanban-view] .dk-graph-edge { fill: none; stroke: #1a73e8; stroke-width: 1.5; }
[data-dsh-kanban-view] .dk-graph-edge-done { stroke: var(--dsw-alias-border-strong, #b0b0b0); }
[data-dsh-kanban-view] .dk-graph-arrow-head { fill: #1a73e8; }
[data-dsh-kanban-view] .dk-graph-arrow-head-done { fill: var(--dsw-alias-border-strong, #b0b0b0); }
[data-dsh-kanban-view] .dk-graph-node {
  position: absolute; box-sizing: border-box; display: flex; flex-direction: column;
  justify-content: center; gap: 4px; overflow: hidden; cursor: pointer;
  background: var(--dsw-alias-bg-base, #ffffff); border: 1px solid var(--dsw-alias-border, #e0e0e0);
  border-radius: 8px; padding: 6px 8px;
}
[data-dsh-kanban-view] .dk-graph-node:hover { border-color: var(--dsw-alias-border-strong, #999); }
[data-dsh-kanban-view] .dk-graph-node-blocked { border-left: 3px solid #b3261e; }
[data-dsh-kanban-view] .dk-graph-node-done { opacity: 0.6; }
[data-dsh-kanban-view] .dk-graph-node-title {
  font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
[data-dsh-kanban-view] .dk-graph-node-badges { display: flex; gap: 4px; }

/* Lightweight markdown subset (plan preview). */
[data-dsh-kanban-view] .dk-md { font-size: 13px; line-height: 1.6; word-break: break-word; }
[data-dsh-kanban-view] .dk-md h4, [data-dsh-kanban-view] .dk-md h5, [data-dsh-kanban-view] .dk-md h6 {
  margin: 10px 0 4px; font-size: 13px; font-weight: 600;
}
[data-dsh-kanban-view] .dk-md p { margin: 4px 0; }
[data-dsh-kanban-view] .dk-md ul, [data-dsh-kanban-view] .dk-md ol { margin: 4px 0; padding-left: 20px; }
[data-dsh-kanban-view] .dk-md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--dsw-alias-bg-base, #fff); border-radius: 4px; padding: 1px 4px;
}
[data-dsh-kanban-view] .dk-md-code {
  margin: 6px 0; padding: 8px 10px; overflow-x: auto; border-radius: 6px;
  background: var(--dsw-alias-bg-base, #fff); border: 1px solid var(--dsw-alias-border, #e0e0e0);
}
[data-dsh-kanban-view] .dk-md-code code { background: none; padding: 0; }
`
