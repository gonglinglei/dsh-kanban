/**
 * The project-detail dependency-graph view: one absolutely positioned HTML
 * card per task leaf (reusing the board badges, so clicks and jsdom tests
 * behave like any other node) over a plain SVG layer that draws one cubic
 * bezier per dependency edge with an arrowhead at the depended-upon end.
 * Nodes are HTML rather than SVG `foreignObject` on purpose (jsdom and some
 * browsers handle the latter poorly). All geometry comes from the pure
 * `layoutDependencyGraph` — this file only renders.
 */
import { useMemo } from 'react'
import type { TaskNode } from '../protocol.ts'
import { layoutDependencyGraph } from './dep-graph-layout.ts'
import { KIND_LABELS, STATUS_LABELS } from './labels.ts'

export interface DependencyGraphProps {
  /** The task leaves of one project (already filtered by projectId by the caller). */
  tasks: TaskNode[]
  /** Node click: opens the task detail, same entry as the list view's「详情」. */
  onOpenTaskDetail(taskId: string): void
}

export function DependencyGraph({ tasks, onOpenTaskDetail }: DependencyGraphProps): JSX.Element {
  // Keyed on the tasks reference: a new snapshot array re-lays out, an
  // unchanged one (e.g. an unrelated project updated) does not.
  const layout = useMemo(() => layoutDependencyGraph(tasks), [tasks])
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])

  if (tasks.length === 0) {
    return <p className="dk-empty">尚无子任务</p>
  }

  return (
    <div className="dk-graph">
      <div className="dk-graph-canvas" style={{ width: layout.size.width, height: layout.size.height }}>
        <svg
          className="dk-graph-edges"
          width={layout.size.width}
          height={layout.size.height}
          viewBox={`0 0 ${layout.size.width} ${layout.size.height}`}
        >
          <defs>
            <marker id="dk-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path className="dk-graph-arrow-head" d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
            <marker id="dk-graph-arrow-done" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path className="dk-graph-arrow-head-done" d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          </defs>
          {layout.edges.map((edge) => {
            // An edge whose depended-upon task is already done is "no longer
            // blocking anything" — rendered in the weakened color.
            const done = taskById.get(edge.toId)?.status === 'done'
            // Horizontal control points halfway across the gap: the curve
            // leaves the dependent node flat and enters the blocker flat.
            const dx = (edge.to.x - edge.from.x) / 2
            const d = `M ${edge.from.x} ${edge.from.y} C ${edge.from.x + dx} ${edge.from.y}, ${edge.to.x - dx} ${edge.to.y}, ${edge.to.x} ${edge.to.y}`
            return (
              <path
                key={`${edge.fromId}->${edge.toId}`}
                className={done ? 'dk-graph-edge dk-graph-edge-done' : 'dk-graph-edge'}
                d={d}
                markerEnd={done ? 'url(#dk-graph-arrow-done)' : 'url(#dk-graph-arrow)'}
              />
            )
          })}
        </svg>
        {layout.nodes.map((node) => {
          const task = taskById.get(node.id)!
          const classNames = ['dk-graph-node']
          if (task.status === 'blocked') classNames.push('dk-graph-node-blocked')
          if (task.status === 'done') classNames.push('dk-graph-node-done')
          return (
            <div
              key={node.id}
              className={classNames.join(' ')}
              title={task.titlePath}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              onClick={() => { onOpenTaskDetail(task.id) }}
            >
              <span className="dk-graph-node-title">{task.titlePath.split(' > ').at(-1)}</span>
              <span className="dk-graph-node-badges">
                <span className="dk-kind-badge">{KIND_LABELS[task.kind]}</span>
                <span className="dk-kind-badge">{STATUS_LABELS[task.status]}</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
