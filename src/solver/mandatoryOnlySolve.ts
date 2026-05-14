import type { Planet, SolveInput, SolveResult } from './types'
import type { CostMatrix } from './costMatrix'
import { buildCostMatrix } from './costMatrix'

const MAX_MANDATORY_COUNT = 3

interface RealizedRoute {
  route: number[]
  gross: number
}

function fail(msg: string): SolveResult {
  return { success: false, errorMessage: msg, orderedRoute: [], effectiveFuel: 0, grossFuel: 0, collectedBonus: 0 }
}

// O(n²) Dijkstra from src to dst, treating blockedInput nodes as impassable.
// src and dst are always unblocked regardless of blockedInput.
function shortestPathAvoiding(matrix: CostMatrix, src: number, dst: number, blockedInput: Uint8Array): number[] | null {
  const { n, data } = matrix
  const blocked = new Uint8Array(blockedInput)
  blocked[src] = 0
  blocked[dst] = 0

  const dist = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const used = new Uint8Array(n)
  dist[src] = 0

  for (let iter = 0; iter < n; iter++) {
    let u = -1, best = Infinity
    for (let i = 0; i < n; i++) {
      if (!used[i] && !blocked[i] && dist[i] < best) { best = dist[i]; u = i }
    }
    if (u === -1 || u === dst) break
    used[u] = 1
    const base = u * n
    for (let v = 0; v < n; v++) {
      if (used[v] || blocked[v] || v === u) continue
      const nd = best + data[base + v]
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u }
    }
  }

  if (!isFinite(dist[dst])) return null
  const path: number[] = []
  for (let cur = dst; cur !== -1; cur = prev[cur]) path.unshift(cur)
  return path[0] === src ? path : null
}

// Realizes one mandatory ordering as a simple physical route using segment-by-segment
// Dijkstra that avoids already-visited planets and future mandatory stops.
function realizeMandatoryOrdering(
  matrix: CostMatrix,
  startIdx: number,
  ordering: number[],
  baseBlocked: Uint8Array,
): RealizedRoute | null {
  const { n, data } = matrix
  const stops = [startIdx, ...ordering, startIdx]
  const forced = new Uint8Array(n)
  forced[startIdx] = 1
  for (const idx of ordering) forced[idx] = 1

  const seen = new Uint8Array(n)
  const routeDense: number[] = [startIdx]
  seen[startIdx] = 1

  for (let seg = 0; seg < stops.length - 1; seg++) {
    const src = stops[seg]
    const dst = stops[seg + 1]
    const isFinal = seg === stops.length - 2

    const blocked = new Uint8Array(baseBlocked)
    for (let i = 0; i < n; i++) if (seen[i]) blocked[i] = 1
    blocked[src] = 0
    if (isFinal && dst === startIdx) blocked[dst] = 0
    // Block future mandatory stops to prevent premature visits
    for (let i = 0; i < n; i++) {
      if (forced[i] && i !== src && i !== dst) blocked[i] = 1
    }

    const path = shortestPathAvoiding(matrix, src, dst, blocked)
    if (!path || path.length < 2) return null

    for (let i = 1; i < path.length; i++) {
      const node = path[i]
      const isFinalReturn = isFinal && i === path.length - 1 && node === startIdx
      if (seen[node] && !isFinalReturn) return null
      routeDense.push(node)
      if (!isFinalReturn) seen[node] = 1
    }
  }

  if (routeDense[0] !== startIdx || routeDense[routeDense.length - 1] !== startIdx) return null

  let gross = 0
  for (let i = 0; i < routeDense.length - 1; i++)
    gross += data[routeDense[i] * n + routeDense[i + 1]]

  return { route: routeDense, gross }
}

/**
 * Fast solver for mandatory-only challenges with at most MAX_MANDATORY_COUNT (3) stops.
 * Skips all-pairs SP (no Floyd-Warshall) and uses direct segment Dijkstra instead.
 * Returns null if the input doesn't qualify (has bonuses, or too many mandatory stops).
 */
export function trySolveSmallMandatoryOnly(input: SolveInput): SolveResult | null {
  const { planets, routes, startPlanetId, mandatoryIds, forbiddenIds, bonuses } = input

  if (bonuses.length > 0) return null

  const mandatoryUnique = [...new Set(mandatoryIds.filter(id => id !== startPlanetId))]
  if (mandatoryUnique.length > MAX_MANDATORY_COUNT) return null

  const byId = new Map<number, Planet>(planets.map(p => [p.id, p]))
  if (!byId.has(startPlanetId)) return fail(`Start planet ${startPlanetId} not found`)

  const forbiddenSet = new Set(forbiddenIds)
  if (forbiddenSet.has(startPlanetId)) return fail('Start planet is forbidden')

  for (const id of mandatoryUnique) {
    if (!byId.has(id)) return fail(`Mandatory planet ${id} not found in planet list`)
    if (forbiddenSet.has(id)) return fail(`Mandatory planet ${id} is also forbidden`)
  }

  if (mandatoryUnique.length === 0) {
    const start = byId.get(startPlanetId)!
    return { success: true, orderedRoute: [start, start], effectiveFuel: 0, grossFuel: 0, collectedBonus: 0 }
  }

  const matrix = buildCostMatrix(planets, routes)
  const { idToIdx, idxToId, n } = matrix

  const startIdx = idToIdx.get(startPlanetId)
  if (startIdx === undefined) return fail(`Start planet ${startPlanetId} not found in matrix`)

  const mandatoryIdxs: number[] = []
  for (const id of mandatoryUnique) {
    const idx = idToIdx.get(id)
    if (idx === undefined) return fail(`Mandatory planet ${id} not found in matrix`)
    mandatoryIdxs.push(idx)
  }

  const baseBlocked = new Uint8Array(n)
  for (const id of forbiddenIds) {
    const idx = idToIdx.get(id)
    if (idx !== undefined) baseBlocked[idx] = 1
  }

  let best: RealizedRoute | null = null
  let bestEff = Infinity

  const used = new Uint8Array(mandatoryIdxs.length)
  const perm: number[] = []

  function dfs(): void {
    if (perm.length === mandatoryIdxs.length) {
      const r = realizeMandatoryOrdering(matrix, startIdx!, perm.slice(), baseBlocked)
      if (r !== null && r.gross < bestEff) { bestEff = r.gross; best = r }
      return
    }
    for (let i = 0; i < mandatoryIdxs.length; i++) {
      if (used[i]) continue
      used[i] = 1; perm.push(mandatoryIdxs[i])
      dfs()
      perm.pop(); used[i] = 0
    }
  }
  dfs()

  if (best === null) return null

  const orderedRoute = (best as RealizedRoute).route.map(idx => byId.get(idxToId[idx])!)
  return {
    success: true,
    orderedRoute,
    effectiveFuel: (best as RealizedRoute).gross,
    grossFuel: (best as RealizedRoute).gross,
    collectedBonus: 0,
  }
}
