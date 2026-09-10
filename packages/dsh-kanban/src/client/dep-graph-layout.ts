/**
 * Dependency-graph layout for the project-detail DAG view. Pure functions,
 * zero dependencies: same input always produces the same output.
 *
 * Semantics (per project plan): an edge points from the dependent task
 * (依赖方, the one waiting) toward the task it depends on (被依赖方, the
 * blocker) — the arrow answers "what is this task still waiting for?".
 * Layering is longest-path: a task with no dependencies sits at layer 0,
 * otherwise `max(layer(dep)) + 1`. The screen column is the REVERSED layer
 * index, so the depended-upon task always renders to the RIGHT of its
 * dependent and every edge runs left → right (from = dependent's right-edge
 * midpoint, to = depended-upon's left-edge midpoint).
 *
 * The host already guarantees the graph is acyclic (assertAcyclic), but the
 * layering DFS still defends against cycles: a back edge is ignored (never
 * followed), and any edge that would not run strictly left → right is
 * dropped from the output — better to draw one edge less than to crash or
 * dead-loop.
 */
import type { TaskNode } from '../protocol.ts'

/** Fixed node width in px. */
export const NODE_WIDTH = 200
/** Fixed node height in px. */
export const NODE_HEIGHT = 56
/** Horizontal gap between adjacent layers (columns), in px. */
export const LAYER_GAP_X = 80
/** Vertical gap between nodes inside one layer, in px. */
export const LAYER_GAP_Y = 24
/** Canvas padding on all sides, in px. */
export const CANVAS_PADDING = 16
/** Barycenter (crossing-reduction) iterations: each round sweeps left→right then right→left. */
export const BARYCENTER_ROUNDS = 2

/** One laid-out task node; the canvas origin is the top-left corner. */
export interface DepGraphLayoutNode {
  id: string
  /** Longest-path layer: 0 for tasks without dependencies, otherwise max(layer(dep)) + 1. */
  layer: number
  x: number
  y: number
  width: number
  height: number
}

/** One directed edge: from the dependent task (left) to the depended-upon task (right). */
export interface DepGraphLayoutEdge {
  /** Dependent task id (left endpoint). */
  fromId: string
  /** Depended-upon task id (right endpoint). */
  toId: string
  /** Right-edge midpoint of the dependent node. */
  from: { x: number; y: number }
  /** Left-edge midpoint of the depended-upon node. */
  to: { x: number; y: number }
}

export interface DepGraphLayout {
  nodes: DepGraphLayoutNode[]
  edges: DepGraphLayoutEdge[]
  size: { width: number; height: number }
}

/** Deterministic string order: plain code-unit comparison (locale-independent). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Lay out one project's task leaves as a layered DAG.
 * Isolated tasks (no dependencies in either direction) all land on layer 0
 * and participate in the layout like any other node.
 */
export function layoutDependencyGraph(tasks: readonly TaskNode[]): DepGraphLayout {
  if (tasks.length === 0) {
    return { nodes: [], edges: [], size: { width: 0, height: 0 } }
  }

  const byId = new Map(tasks.map((task) => [task.id, task]))

  // Adjacency over known nodes only; dangling dependency ids are ignored.
  const depsOf = new Map<string, string[]>() // dependent → its dependencies (rendered to the right)
  const dependentsOf = new Map<string, string[]>() // dependency → its dependents (rendered to the left)
  for (const task of tasks) {
    const deps = task.dependencies.filter((dep) => dep !== task.id && byId.has(dep))
    depsOf.set(task.id, deps)
    for (const dep of deps) {
      const list = dependentsOf.get(dep)
      if (list) list.push(task.id)
      else dependentsOf.set(dep, [task.id])
    }
  }

  // Longest-path layering, memoized DFS. An edge into a node already on the
  // DFS stack is a back edge (cycle): it is ignored, not followed.
  const layer = new Map<string, number>()
  const visiting = new Set<string>()
  const layerOf = (id: string): number => {
    const cached = layer.get(id)
    if (cached !== undefined) return cached
    visiting.add(id)
    let value = 0
    for (const dep of depsOf.get(id) ?? []) {
      if (visiting.has(dep)) continue // back edge: ignore
      value = Math.max(value, layerOf(dep) + 1)
    }
    visiting.delete(id)
    layer.set(id, value)
    return value
  }
  let maxLayer = 0
  for (const task of tasks) {
    maxLayer = Math.max(maxLayer, layerOf(task.id))
  }

  // Screen column = reversed layer: layer 0 (no dependencies) is the
  // rightmost column, the most-dependent tasks the leftmost.
  const columnOf = new Map<string, number>()
  const columns: string[][] = Array.from({ length: maxLayer + 1 }, () => [])
  for (const task of tasks) {
    const column = maxLayer - layer.get(task.id)!
    columnOf.set(task.id, column)
    columns[column].push(task.id)
  }
  // Deterministic initial order inside each column: titlePath, then id.
  for (const column of columns) {
    column.sort((a, b) => compareStrings(byId.get(a)!.titlePath, byId.get(b)!.titlePath) || compareStrings(a, b))
  }

  // Barycenter heuristic to reduce edge crossings. `pos` tracks each node's
  // index inside its column; sweeps reorder one column at a time by the
  // average position of its already-placed neighbours on the swept side.
  const pos = new Map<string, number>()
  const refreshColumn = (columnIndex: number): void => {
    columns[columnIndex].forEach((id, index) => pos.set(id, index))
  }
  columns.forEach((_, index) => refreshColumn(index))

  const sweep = (leftToRight: boolean): void => {
    const indices: number[] = []
    if (leftToRight) {
      for (let c = 1; c < columns.length; c += 1) indices.push(c)
    } else {
      for (let c = columns.length - 2; c >= 0; c -= 1) indices.push(c)
    }
    for (const c of indices) {
      const entries = columns[c].map((id, index) => {
        const neighbours = (leftToRight ? dependentsOf.get(id) : depsOf.get(id)) ?? []
        const neighbourPositions = neighbours
          .filter((n) => (leftToRight ? columnOf.get(n)! < c : columnOf.get(n)! > c))
          .map((n) => pos.get(n)!)
        const barycenter =
          neighbourPositions.length === 0
            ? index
            : neighbourPositions.reduce((sum, p) => sum + p, 0) / neighbourPositions.length
        return { id, index, barycenter }
      })
      entries.sort((a, b) => a.barycenter - b.barycenter || a.index - b.index)
      columns[c] = entries.map((entry) => entry.id)
      refreshColumn(c)
    }
  }
  for (let round = 0; round < BARYCENTER_ROUNDS; round += 1) {
    sweep(true)
    sweep(false)
  }

  // Coordinates.
  const geometry = new Map<string, DepGraphLayoutNode>()
  let maxColumnSize = 0
  columns.forEach((column, columnIndex) => {
    maxColumnSize = Math.max(maxColumnSize, column.length)
    column.forEach((id, index) => {
      geometry.set(id, {
        id,
        layer: layer.get(id)!,
        x: CANVAS_PADDING + columnIndex * (NODE_WIDTH + LAYER_GAP_X),
        y: CANVAS_PADDING + index * (NODE_HEIGHT + LAYER_GAP_Y),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })
    })
  })

  // Nodes keep the input task order (stable identity for the renderer).
  const nodes = tasks.map((task) => geometry.get(task.id)!)

  // Edges: only those running strictly left → right (dependent's layer above
  // the depended-upon's). Cycle back-edges fail this check and are dropped.
  const edges: DepGraphLayoutEdge[] = []
  for (const task of tasks) {
    const fromNode = geometry.get(task.id)!
    for (const dep of depsOf.get(task.id) ?? []) {
      const toNode = geometry.get(dep)!
      if (fromNode.layer <= toNode.layer) continue
      edges.push({
        fromId: task.id,
        toId: dep,
        from: { x: fromNode.x + fromNode.width, y: fromNode.y + fromNode.height / 2 },
        to: { x: toNode.x, y: toNode.y + toNode.height / 2 },
      })
    }
  }

  const columnCount = maxLayer + 1
  const size = {
    width: CANVAS_PADDING * 2 + columnCount * NODE_WIDTH + (columnCount - 1) * LAYER_GAP_X,
    height: CANVAS_PADDING * 2 + maxColumnSize * NODE_HEIGHT + Math.max(0, maxColumnSize - 1) * LAYER_GAP_Y,
  }

  return { nodes, edges, size }
}
