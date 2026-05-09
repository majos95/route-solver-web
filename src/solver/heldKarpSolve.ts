import type { SolveInput, SolveResult } from './types'
import type { CostMatrix } from './costMatrix'
import type { AllPairsSP } from './allPairsSP'
import { buildCostMatrix } from './costMatrix'
import { computeAllPairsSP } from './allPairsSP'
import { heldKarpGen } from './heldKarp'
import { MinHeap } from './heap'

const TIMEOUT_MS = 5 * 60 * 1000

// Single Dijkstra pass on the dense cost matrix.
// additionalForbidden must NOT include dst (target must remain reachable).
function repairDijkstra(
  matrix: CostMatrix,
  src: number,
  dst: number,
  baseForbidden: ReadonlySet<number>,
  additionalForbidden: ReadonlySet<number>,
): { cost: number; path: number[] } | null {
  const { n, data } = matrix
  const dist = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  dist[src] = 0
  const pq = new MinHeap<number>()
  pq.push(0, src)

  while (pq.size > 0) {
    const [d, u] = pq.pop()!
    if (d > dist[u]) continue
    if (u === dst) break
    const base = u * n
    for (let v = 0; v < n; v++) {
      if (v === u || baseForbidden.has(v) || additionalForbidden.has(v)) continue
      const nd = d + data[base + v]
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; pq.push(nd, v) }
    }
  }

  if (dist[dst] === Infinity) return null
  const path: number[] = []
  let cur = dst
  while (cur !== -1) { path.unshift(cur); cur = prev[cur] }
  return { cost: dist[dst], path }
}

// Forward-sweep realization of one Held-Karp ordering.
// Returns null if any segment cannot be realized without revisiting a node.
// bonusValueByDense includes ALL valid bonuses (not just the current subset),
// so transit bonuses are credited if encountered.
function realizeOrdering(
  ordering: number[],            // indices into forcedIdxs; first and last are both 0 (= start)
  forcedIdxs: number[],         // forcedIdxs[i] = dense index of i-th forced stop
  sp: AllPairsSP,
  baseForbidden: ReadonlySet<number>,
  matrix: CostMatrix,
  bonusValueByDense: ReadonlyMap<number, number>,
): { route: number[]; gross: number; collected: number } | null {
  const startDense = forcedIdxs[0]
  const visitedDense = new Set<number>([startDense])
  const segPaths: number[][] = []
  let gross = 0

  for (let i = 0; i < ordering.length - 1; i++) {
    const srcDense = forcedIdxs[ordering[i]]
    const dstDense = forcedIdxs[ordering[i + 1]]
    const isLastSeg = i === ordering.length - 2

    // Forced stop dstDense already visited as a transit → ordering is unrecoverable.
    if (!isLastSeg && visitedDense.has(dstDense)) return null

    let path = sp.spPath.get(srcDense)?.[dstDense] ?? null
    let cost = path !== null ? sp.spCost.get(srcDense)![dstDense] : Infinity

    if (path === null) return null  // no precomputed path at all (unreachable)

    // Forward-sweep conflict check: any intermediate node already visited?
    const hasConflict = path.slice(1, -1).some(v => visitedDense.has(v))

    if (hasConflict) {
      // Re-run Dijkstra with all currently-visited nodes forbidden.
      // Exclude dstDense from additionalForbidden so the target remains reachable
      // (relevant for the last segment, where dstDense = startDense ∈ visitedDense).
      const addForbidden = new Set(visitedDense)
      addForbidden.delete(dstDense)
      const repaired = repairDijkstra(matrix, srcDense, dstDense, baseForbidden, addForbidden)
      if (repaired === null) return null
      path = repaired.path
      cost = repaired.cost
    }

    gross += cost
    segPaths.push(path)

    // Grow visitedDense: every node in this segment (excluding the source, which is already there).
    for (const v of path.slice(1)) visitedDense.add(v)
  }

  // Concatenate dense-index route.
  const routeDense: number[] = [startDense]
  for (const path of segPaths) for (const v of path.slice(1)) routeDense.push(v)

  // fLen=1 edge case: start→start segment produces no new nodes; cap the route.
  if (routeDense.length === 1) routeDense.push(startDense)

  // Final no-revisit check: a repaired segment may have routed through a future forced stop.
  const seen = new Set<number>()
  for (let k = 0; k < routeDense.length; k++) {
    const v = routeDense[k]
    const isEndpoint = k === 0 || k === routeDense.length - 1
    if (seen.has(v) && !(isEndpoint && v === startDense)) return null
    seen.add(v)
  }

  // Collect bonus value for every bonus planet that appears in the route.
  let collected = 0
  for (const denseIdx of routeDense) {
    const val = bonusValueByDense.get(denseIdx)
    if (val !== undefined) collected += val
  }

  return { route: routeDense, gross, collected }
}

export function heldKarpSolve(input: SolveInput): SolveResult {
  const { planets, routes, startPlanetId, mandatoryIds, forbiddenIds, bonuses } = input

  const byId = new Map(planets.map(p => [p.id, p]))

  if (!byId.has(startPlanetId)) return fail(`Start planet ${startPlanetId} not found`)

  const forbiddenSet = new Set(forbiddenIds)
  if (forbiddenSet.has(startPlanetId)) return fail('Start planet is forbidden')

  const mandatoryUnique = [...new Set(mandatoryIds.filter(id => id !== startPlanetId))]
  for (const id of mandatoryUnique) {
    if (!byId.has(id)) return fail(`Mandatory planet ${id} not found in planet list`)
    if (forbiddenSet.has(id)) return fail(`Mandatory planet ${byId.get(id)!.name} is also forbidden`)
  }

  const validBonuses = bonuses.filter(
    b => byId.has(b.planetId) && b.value > 0 && !forbiddenSet.has(b.planetId) && b.planetId !== startPlanetId,
  )

  if (mandatoryUnique.length === 0 && validBonuses.length === 0) {
    const start = byId.get(startPlanetId)!
    return { success: true, orderedRoute: [start, start], effectiveFuel: 0, grossFuel: 0, collectedBonus: 0 }
  }

  // Step 1: cost matrix
  const matrix = buildCostMatrix(planets, routes)
  const { idToIdx, idxToId } = matrix

  const startIdx = idToIdx.get(startPlanetId)!
  const forbiddenDenseSet = new Set(
    [...forbiddenSet].flatMap(id => { const i = idToIdx.get(id); return i !== undefined ? [i] : [] }),
  )

  const mandatoryIdxs = mandatoryUnique.map(id => idToIdx.get(id)!)
  const bonusIdxByPlanetId = new Map(validBonuses.map(b => [b.planetId, idToIdx.get(b.planetId)!]))
  const bonusValueByDense = new Map(validBonuses.map(b => [bonusIdxByPlanetId.get(b.planetId)!, b.value]))

  // Step 2: all-pairs SP from all key nodes (cached globally across bonus subsets)
  const uniqueKeyIdxs = [...new Set([
    startIdx,
    ...mandatoryIdxs,
    ...validBonuses.map(b => bonusIdxByPlanetId.get(b.planetId)!),
  ])]
  const sp = computeAllPairsSP(matrix, uniqueKeyIdxs, forbiddenDenseSet)

  // Fail-fast: verify all mandatory pairs are mutually reachable
  for (const a of [startIdx, ...mandatoryIdxs]) {
    for (const b of [startIdx, ...mandatoryIdxs]) {
      if (a === b) continue
      if ((sp.spCost.get(a)?.[b] ?? Infinity) === Infinity) {
        return fail(`No reachable path between planets ${idxToId[a]} and ${idxToId[b]}`)
      }
    }
  }

  const deadline = Date.now() + TIMEOUT_MS

  interface Best {
    effectiveFuel: number
    route: number[] | null
    gross: number
    collected: number
    timedOut: boolean
  }
  const best: Best = { effectiveFuel: Infinity, route: null, gross: 0, collected: 0, timedOut: false }

  // Steps 3+4: enumerate bonus subsets in descending total value order
  const bonusCount = validBonuses.length
  const subsets = Array.from({ length: 1 << bonusCount }, (_, i) => i).sort((a, b) => {
    let va = 0, vb = 0
    for (let k = 0; k < bonusCount; k++) {
      if (a & (1 << k)) va += validBonuses[k].value
      if (b & (1 << k)) vb += validBonuses[k].value
    }
    return vb - va
  })

  for (const bonusMask of subsets) {
    if (Date.now() >= deadline) { best.timedOut = true; break }

    const subsetBonuses = validBonuses.filter((_, k) => bonusMask & (1 << k))
    const bonusCredit = subsetBonuses.reduce((s, b) => s + b.value, 0)
    const bonusSubsetIdxs = subsetBonuses.map(b => bonusIdxByPlanetId.get(b.planetId)!)

    const forcedIdxs = [startIdx, ...mandatoryIdxs, ...bonusSubsetIdxs]
    const fLen = forcedIdxs.length

    // Trivial case: no forced stops beyond start in this subset
    if (fLen === 1) {
      const effective = -bonusCredit  // gross = 0
      if (effective < best.effectiveFuel) {
        best.effectiveFuel = effective
        best.route = [startIdx, startIdx]
        best.gross = 0
        best.collected = bonusCredit
      }
      continue
    }

    // Build fLen×fLen cost matrix for Held-Karp (spCost between forced stops)
    const hkCosts = new Float64Array(fLen * fLen)
    for (let i = 0; i < fLen; i++) {
      const row = sp.spCost.get(forcedIdxs[i])
      if (!row) continue
      for (let j = 0; j < fLen; j++) hkCosts[i * fLen + j] = row[forcedIdxs[j]]
    }

    // Steps 5+6: enumerate orderings, realize with forward-sweep repair, B&B cutoff
    for (const { ordering, cost: lbCost } of heldKarpGen(fLen, hkCosts)) {
      if (Date.now() >= deadline) { best.timedOut = true; break }
      if (lbCost - bonusCredit >= best.effectiveFuel) break  // B&B cutoff

      const result = realizeOrdering(ordering, forcedIdxs, sp, forbiddenDenseSet, matrix, bonusValueByDense)
      if (result === null) continue

      const effective = result.gross - result.collected
      if (effective < best.effectiveFuel) {
        best.effectiveFuel = effective
        best.route = result.route
        best.gross = result.gross
        best.collected = result.collected
      }
    }

    if (best.timedOut) break
  }

  if (best.route === null) {
    return best.timedOut
      ? { ...fail('Timed out before finding any valid route'), timedOut: true }
      : fail('No valid route found')
  }

  const orderedRoute = best.route.map(denseIdx => byId.get(idxToId[denseIdx])!)
  return {
    success: true,
    orderedRoute,
    effectiveFuel: best.effectiveFuel,
    grossFuel: best.gross,
    collectedBonus: best.collected,
    timedOut: best.timedOut || undefined,
  }
}

function fail(msg: string): SolveResult {
  return { success: false, errorMessage: msg, orderedRoute: [], effectiveFuel: 0, grossFuel: 0, collectedBonus: 0 }
}
