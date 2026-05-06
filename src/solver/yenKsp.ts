import type { Planet } from './types'
import { edgeCost } from './edgeCost'
import { dijkstra } from './dijkstra'

export interface KspPath {
  cost: number
  path: number[]
}

function pathEquals(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function yenKsp(
  source: number,
  target: number,
  K: number,
  allNodes: number[],
  baseForbiddenNodes: Set<number>,
  mainSet: Set<string>,
  otherSet: Set<string>,
  coords: Map<number, Planet>,
): KspPath[] {
  const A: KspPath[] = []
  // String-keyed set for O(1) path deduplication
  const seen = new Set<string>()
  const B: KspPath[] = []

  const first = dijkstra(source, target, allNodes, baseForbiddenNodes, new Set(), mainSet, otherSet, coords)
  if (!first) return []
  A.push(first)
  seen.add(first.path.join(','))

  for (let k = 1; k < K; k++) {
    const prevPath = A[A.length - 1].path

    for (let i = 0; i < prevPath.length - 1; i++) {
      const spurNode = prevPath[i]
      const rootPath = prevPath.slice(0, i + 1)

      const forbiddenEdges = new Set<string>()
      for (const { path } of A) {
        if (path.length > i && pathEquals(path.slice(0, i + 1), rootPath)) {
          forbiddenEdges.add(`${path[i]}-${path[i + 1]}`)
          forbiddenEdges.add(`${path[i + 1]}-${path[i]}`)
        }
      }

      const forbiddenNodes = new Set(baseForbiddenNodes)
      for (const n of rootPath.slice(0, i)) forbiddenNodes.add(n)

      const spur = dijkstra(spurNode, target, allNodes, forbiddenNodes, forbiddenEdges, mainSet, otherSet, coords)
      if (!spur) continue

      let rootCost = 0
      for (let j = 0; j < rootPath.length - 1; j++) {
        rootCost += edgeCost(coords.get(rootPath[j])!, coords.get(rootPath[j + 1])!, mainSet, otherSet)
      }

      const fullPath = [...rootPath.slice(0, i), ...spur.path]
      const key = fullPath.join(',')
      if (!seen.has(key)) {
        seen.add(key)
        B.push({ cost: rootCost + spur.cost, path: fullPath })
      }
    }

    if (B.length === 0) break
    B.sort((a, b) => a.cost - b.cost)
    A.push(B.shift()!)
  }

  return A
}
