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
[data-dsh-kanban-view] .dk-card-goal {
  margin: 0; font-size: 12px; color: var(--dsw-alias-text-secondary, #666);
  word-break: break-all; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
[data-dsh-kanban-view] .dk-card-meta { font-size: 11px; color: var(--dsw-alias-text-tertiary, #999); }
[data-dsh-kanban-view] .dk-card-error { margin: 0; font-size: 12px; color: #b3261e; }
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
[data-dsh-kanban-view] .dk-field input {
  font: inherit; font-size: 13px; border: 1px solid var(--dsw-alias-border, #d0d0d0);
  border-radius: 6px; padding: 6px 8px; background: var(--dsw-alias-bg-base, #fff); color: inherit;
}
[data-dsh-kanban-view] .dk-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
[data-dsh-kanban-view] .dk-modal-error { margin: 0; font-size: 12px; color: #b3261e; }
[data-dsh-kanban-view] .dk-btn:disabled { opacity: 0.5; cursor: not-allowed; }
[data-dsh-kanban-view] .dk-empty { font-size: 12px; color: var(--dsw-alias-text-tertiary, #999); padding: 4px; }
`
