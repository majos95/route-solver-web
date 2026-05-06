import type { Planet } from './types'
import { edgeCost } from './edgeCost'
import { MinHeap } from './heap'

export interface ShortestPath {
  cost: number
  path: number[]
}

export function dijkstra(
  source: number,
  target: number,
  allNodes: number[],
  forbiddenNodes: Set<number>,
  forbiddenEdges: Set<string>,
  mainSet: Set<string>,
  otherSet: Set<string>,
  coords: Map<number, Planet>,
): ShortestPath | null {
  const dist = new Map<number, number>()
  const prev = new Map<number, number>()

  for (const n of allNodes) dist.set(n, Infinity)
  dist.set(source, 0)

  const pq = new MinHeap<number>()
  pq.push(0, source)

  while (pq.size > 0) {
    const [d, u] = pq.pop()!
    if (d > (dist.get(u) ?? Infinity)) continue
    if (u === target) break

    const uPlanet = coords.get(u)!
    for (const v of allNodes) {
      if (v === u) continue
      if (forbiddenNodes.has(v)) continue
      if (forbiddenEdges.has(`${u}-${v}`)) continue

      const nd = d + edgeCost(uPlanet, coords.get(v)!, mainSet, otherSet)
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd)
        prev.set(v, u)
        pq.push(nd, v)
      }
    }
  }

  if ((dist.get(target) ?? Infinity) === Infinity) return null

  const path: number[] = []
  let cur: number | undefined = target
  while (cur !== undefined) {
    path.unshift(cur)
    cur = prev.get(cur)
  }

  return { cost: dist.get(target)!, path }
}
