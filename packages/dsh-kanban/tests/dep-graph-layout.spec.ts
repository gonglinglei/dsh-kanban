import { describe, expect, it } from 'vitest'
import type { TaskNode } from '../src/protocol.ts'
import {
  CANVAS_PADDING,
  LAYER_GAP_X,
  LAYER_GAP_Y,
  NODE_HEIGHT,
  NODE_WIDTH,
  layoutDependencyGraph,
} from '../src/client/dep-graph-layout.ts'

let created = 0
function makeTask(id: string, dependencies: string[] = [], titlePath = `项目 > ${id}`): TaskNode {
  created += 1
  return {
    id,
    projectId: 'p1',
    titlePath,
    kind: 'execute',
    status: 'backlog',
    dependencies,
    version: 1,
    createdAt: created,
    updatedAt: created,
    lastActivityAt: created,
    history: [],
  }
}

function nodeById(layout: ReturnType<typeof layoutDependencyGraph>, id: string) {
  const node = layout.nodes.find((n) => n.id === id)
  expect(node, `node ${id} present`).toBeTruthy()
  return node!
}

describe('layoutDependencyGraph', () => {
  it('returns an empty layout for no tasks', () => {
    expect(layoutDependencyGraph([])).toEqual({ nodes: [], edges: [], size: { width: 0, height: 0 } })
  })

  it('layers a chain A→B→C (A depends on B, B depends on C) as 2/1/0 with x increasing along the chain', () => {
    // Chain written in depends-on direction: A waits for B, B waits for C.
    const a = makeTask('a', ['b'])
    const b = makeTask('b', ['c'])
    const c = makeTask('c')
    const layout = layoutDependencyGraph([a, b, c])

    expect(nodeById(layout, 'a').layer).toBe(2)
    expect(nodeById(layout, 'b').layer).toBe(1)
    expect(nodeById(layout, 'c').layer).toBe(0)

    // Screen order along the depends-on chain: dependent left, blocker right.
    const xa = nodeById(layout, 'a').x
    const xb = nodeById(layout, 'b').x
    const xc = nodeById(layout, 'c').x
    expect(xa).toBeLessThan(xb)
    expect(xb).toBeLessThan(xc)
    expect(xb - xa).toBe(NODE_WIDTH + LAYER_GAP_X)
    expect(xc - xb).toBe(NODE_WIDTH + LAYER_GAP_X)
    expect(xa).toBe(CANVAS_PADDING)

    // Edges run left → right: from the dependent's right-edge midpoint to
    // the depended-upon's left-edge midpoint.
    expect(layout.edges).toHaveLength(2)
    for (const edge of layout.edges) {
      const from = nodeById(layout, edge.fromId)
      const to = nodeById(layout, edge.toId)
      expect(edge.from).toEqual({ x: from.x + NODE_WIDTH, y: from.y + NODE_HEIGHT / 2 })
      expect(edge.to).toEqual({ x: to.x, y: to.y + NODE_HEIGHT / 2 })
      expect(edge.from.x).toBeLessThan(edge.to.x)
    }
    expect(layout.edges.map((e) => [e.fromId, e.toId])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ])

    // Canvas exactly fits 3 columns of one node each.
    expect(layout.size).toEqual({
      width: CANVAS_PADDING * 2 + 3 * NODE_WIDTH + 2 * LAYER_GAP_X,
      height: CANVAS_PADDING * 2 + NODE_HEIGHT,
    })
  })

  it('keeps the middle pair of a diamond on the same layer', () => {
    // D depends on B and C; B and C depend on A.
    const d = makeTask('d', ['b', 'c'])
    const b = makeTask('b', ['a'])
    const c = makeTask('c', ['a'])
    const a = makeTask('a')
    const layout = layoutDependencyGraph([d, b, c, a])

    expect(nodeById(layout, 'a').layer).toBe(0)
    expect(nodeById(layout, 'b').layer).toBe(1)
    expect(nodeById(layout, 'c').layer).toBe(1)
    expect(nodeById(layout, 'd').layer).toBe(2)
    expect(nodeById(layout, 'b').x).toBe(nodeById(layout, 'c').x)
    expect(nodeById(layout, 'b').y).not.toBe(nodeById(layout, 'c').y)

    // D is the leftmost node, A the rightmost.
    expect(nodeById(layout, 'd').x).toBe(CANVAS_PADDING)
    expect(nodeById(layout, 'a').x).toBe(CANVAS_PADDING + 2 * (NODE_WIDTH + LAYER_GAP_X))

    // Middle column holds two stacked nodes, so the canvas is two nodes tall.
    expect(layout.size.height).toBe(CANVAS_PADDING * 2 + 2 * NODE_HEIGHT + LAYER_GAP_Y)
    expect(layout.edges).toHaveLength(4)
  })

  it('puts every task on layer 0 when there are no dependencies', () => {
    const tasks = [makeTask('x'), makeTask('y'), makeTask('z')]
    const layout = layoutDependencyGraph(tasks)

    expect(layout.edges).toEqual([])
    for (const task of tasks) {
      const node = nodeById(layout, task.id)
      expect(node.layer).toBe(0)
      expect(node.x).toBe(CANVAS_PADDING)
    }
    // Column stacked top to bottom with the configured spacing.
    const ys = layout.nodes.map((n) => n.y).sort((m, n) => m - n)
    expect(ys[0]).toBe(CANVAS_PADDING)
    expect(ys[1] - ys[0]).toBe(NODE_HEIGHT + LAYER_GAP_Y)
    expect(ys[2] - ys[1]).toBe(NODE_HEIGHT + LAYER_GAP_Y)
  })

  it('lays out isolated tasks alongside dependent ones without disturbing the chain', () => {
    const a = makeTask('a', ['b'])
    const b = makeTask('b')
    const lonely = makeTask('lonely')
    const layout = layoutDependencyGraph([a, b, lonely])

    expect(nodeById(layout, 'b').layer).toBe(0)
    expect(nodeById(layout, 'lonely').layer).toBe(0)
    expect(nodeById(layout, 'b').x).toBe(nodeById(layout, 'lonely').x)
    expect(nodeById(layout, 'a').layer).toBe(1)
    expect(layout.edges).toHaveLength(1)
  })

  it('is deterministic: identical input produces identical output', () => {
    const tasks = [
      makeTask('d', ['b', 'c']),
      makeTask('b', ['a']),
      makeTask('c', ['a']),
      makeTask('a'),
      makeTask('e', ['d']),
      makeTask('f'),
    ]
    const first = layoutDependencyGraph(tasks)
    const second = layoutDependencyGraph(tasks)
    expect(second).toEqual(first)
  })

  it('is input-order independent in geometry: same set, shuffled input, same coordinates and edges', () => {
    const tasks = [makeTask('d', ['b', 'c']), makeTask('b', ['a']), makeTask('c', ['a']), makeTask('a')]
    const shuffled = [tasks[3], tasks[2], tasks[1], tasks[0]]
    const base = layoutDependencyGraph(tasks)
    const other = layoutDependencyGraph(shuffled)
    const geo = (layout: typeof base) =>
      [...layout.nodes].sort((m, n) => (m.id < n.id ? -1 : 1)).map(({ id, x, y, layer }) => ({ id, x, y, layer }))
    expect(geo(other)).toEqual(geo(base))
    const edgeSet = (layout: typeof base) => layout.edges.map((e) => `${e.fromId}->${e.toId}`).sort()
    expect(edgeSet(other)).toEqual(edgeSet(base))
  })

  it('defends against cycles: no throw, no dead loop, back edge dropped', () => {
    const a = makeTask('a', ['b'])
    const b = makeTask('b', ['a'])
    const layout = layoutDependencyGraph([a, b])

    expect(layout.nodes).toHaveLength(2)
    // One of the two edges is a back edge and must be dropped; every
    // surviving edge still runs strictly left → right.
    expect(layout.edges.length).toBeLessThan(2)
    for (const edge of layout.edges) {
      expect(edge.from.x).toBeLessThan(edge.to.x)
    }
  })

  it('ignores dangling dependency ids and self references', () => {
    const a = makeTask('a', ['missing', 'a'])
    const b = makeTask('b', ['a'])
    const layout = layoutDependencyGraph([a, b])

    expect(nodeById(layout, 'a').layer).toBe(0)
    expect(nodeById(layout, 'b').layer).toBe(1)
    expect(layout.edges.map((e) => [e.fromId, e.toId])).toEqual([['b', 'a']])
  })

  it('reduces crossings with the barycenter heuristic on a classic crossed bipartite case', () => {
    // Two columns: left column L1/L2 depend on right column R1/R2.
    // With titlePath ordering forcing L1 above L2 and R1 above R2, wiring
    // L1→R2 and L2→R1 would cross unless the barycenter sweep reorders.
    const l1 = makeTask('l1', ['r2'], '项目 > A-l1')
    const l2 = makeTask('l2', ['r1'], '项目 > B-l2')
    const r1 = makeTask('r1', [], '项目 > A-r1')
    const r2 = makeTask('r2', [], '项目 > B-r2')
    const layout = layoutDependencyGraph([l1, l2, r1, r2])

    const y = (id: string) => nodeById(layout, id).y
    // After reordering, the two edges run parallel (no crossing): the
    // vertically higher left node connects to the vertically higher right node.
    const leftOrder = [y('l1'), y('l2')]
    const rightOrder = [y('r1'), y('r2')]
    const l1AboveL2 = leftOrder[0] < leftOrder[1]
    // l1 → r2, l2 → r1: crossing-free means l1 and r2 are on the same side.
    expect(l1AboveL2 ? y('r2') < y('r1') : y('r2') > y('r1')).toBe(true)
    expect(rightOrder).not.toEqual(leftOrder)
  })
})
