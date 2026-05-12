import type { SolveInput, SolveResult } from './types'
import type { CostMatrix } from './costMatrix'
import type { AllPairsSP } from './allPairsSP'
import { buildCostMatrix } from './costMatrix'
import { computeAllPairsSP } from './allPairsSP'
import { heldKarpGen } from './heldKarp'
import { MinHeap } from './heap'

const TIMEOUT_MS = 5 * 60 * 1000

// Find transit nodes that appear as intermediates on 2+ segment SP paths in this ordering.
// These bottleneck nodes are tracked in the DP bitmask so consuming one in an early segment
// doesn't silently block a later segment from using the same node.
function identifyKeyNodes(
  ordering: number[],
  forcedIdxs: number[],
  sp: AllPairsSP,
  forcedSet: ReadonlySet<number>,
): number[] {
  const freq = new Map<number, number>()
  for (let i = 0; i < ordering.length - 1; i++) {
    const src = forcedIdxs[ordering[i]]
    const dst = forcedIdxs[ordering[i + 1]]
    const path = sp.spPath.get(src)?.[dst]
    if (!path) continue
    for (let k = 1; k < path.length - 1; k++) {
      const node = path[k]
      if (forcedSet.has(node)) continue
      freq.set(node, (freq.get(node) ?? 0) + 1)
    }
  }
  return [...freq.entries()]
    .filter(([, f]) => f >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([node]) => node)
}

// Realize one Held-Karp ordering via DP on joint state (segment, planet, keyNodeMask).
// Tracks which bottleneck transit nodes have been consumed across segments so that
// later segments can route around them rather than taking expensive repairs.
// Returns null if no valid simple path exists for this ordering.
function realizeOrderingDP(
  ordering: number[],            // indices into forcedIdxs; first and last are both 0 (= start)
  forcedIdxs: number[],         // forcedIdxs[i] = dense index of i-th forced stop
  sp: AllPairsSP,
  baseForbidden: ReadonlySet<number>,
  matrix: CostMatrix,
  bonusValueByDense: ReadonlyMap<number, number>,
): { route: number[]; gross: number; collected: number } | null {
  const { n, data } = matrix
  const segCount = ordering.length - 1
  const stops = ordering.map(i => forcedIdxs[i])
  const startDense = stops[0]

  const forcedSet = new Set(forcedIdxs)
  const keyNodes = identifyKeyNodes(ordering, forcedIdxs, sp, forcedSet)
  const K = keyNodes.length
  const maskCount = 1 << K
  const keyBit = new Map<number, number>()
  for (let k = 0; k < K; k++) keyBit.set(keyNodes[k], 1 << k)

  // State encoding: (seg * n + planet) * maskCount + mask
  const encode = (seg: number, planet: number, mask: number) =>
    (seg * n + planet) * maskCount + mask

  const totalStates = (segCount + 1) * n * maskCount
  const dist = new Float64Array(totalStates).fill(Infinity)
  const parent = new Int32Array(totalStates).fill(-2)  // -2 = unvisited, -1 = root

  // Per-segment forbidden sets:
  //   past: stops already visited (stops[1..seg]) — must not revisit
  //   future: stops not yet targeted (stops[seg+2..segCount]) — must not transit through prematurely
  const segPast: Set<number>[] = []
  const segFuture: Set<number>[] = []
  for (let s = 0; s < segCount; s++) {
    const past = new Set<number>()
    for (let k = 1; k <= s; k++) past.add(stops[k])
    segPast.push(past)
    const future = new Set<number>()
    for (let k = s + 2; k <= segCount; k++) future.add(stops[k])
    segFuture.push(future)
  }

  const initialMask = keyBit.get(startDense) ?? 0
  const startState = encode(0, startDense, initialMask)
  dist[startState] = 0
  parent[startState] = -1

  const pq = new MinHeap<number>()
  pq.push(0, startState)

  while (pq.size > 0) {
    const [d, state] = pq.pop()!
    if (d > dist[state]) continue

    const mask = state % maskCount
    const rem = (state / maskCount) | 0
    const planet = rem % n
    const seg = (rem / n) | 0

    if (seg === segCount) continue

    const past = segPast[seg]
    const future = segFuture[seg]
    const nextStop = stops[seg + 1]
    const base = planet * n

    for (let w = 0; w < n; w++) {
      if (w === planet) continue
      if (baseForbidden.has(w)) continue
      const wBit = keyBit.get(w) ?? 0
      if (wBit && (mask & wBit)) continue  // key node already consumed
      if (past.has(w)) continue            // already-visited forced stop
      if (future.has(w)) continue          // future forced stop — premature transit

      const newMask = mask | wBit
      const newSeg = w === nextStop ? seg + 1 : seg
      const nd = d + data[base + w]
      const ns = encode(newSeg, w, newMask)
      if (nd < dist[ns]) {
        dist[ns] = nd
        parent[ns] = state
        pq.push(nd, ns)
      }
    }
  }

  // Find best terminal: minimum cost over all key-node masks at (segCount, stops[segCount])
  const terminalPlanet = stops[segCount]
  let bestDist = Infinity
  let bestState = -1
  for (let mask = 0; mask < maskCount; mask++) {
    const s = encode(segCount, terminalPlanet, mask)
    if (dist[s] < bestDist) { bestDist = dist[s]; bestState = s }
  }
  if (!isFinite(bestDist)) return null

  // Reconstruct dense-index route by following parent pointers
  const routeDense: number[] = []
  let cur = bestState
  while (cur !== -1) {
    routeDense.unshift(((cur / maskCount) | 0) % n)
    cur = parent[cur]
  }

  // Verify simple path: bitmask only tracks K key nodes, so check no other revisits slipped through
  const seen = new Set<number>()
  for (let k = 0; k < routeDense.length; k++) {
    const v = routeDense[k]
    const isEnd = k === 0 || k === routeDense.length - 1
    if (seen.has(v) && !(isEnd && v === startDense)) return null
    seen.add(v)
  }

  let gross = 0
  for (let k = 0; k < routeDense.length - 1; k++)
    gross += data[routeDense[k] * n + routeDense[k + 1]]

  // bonusValueByDense includes ALL valid bonuses; transit bonuses are credited if encountered.
  let collected = 0
  for (const idx of routeDense) {
    const val = bonusValueByDense.get(idx)
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
  // Process the empty-bonus subset first to establish an initial upper bound.
  // Without a finite best, the B&B cutoff never fires, and heldKarpGen can
  // grow a heap of O(n!) entries before yielding its first ordering (OOM for n≥11).
  const subsets = Array.from({ length: 1 << bonusCount }, (_, i) => i).sort((a, b) => {
    if (a === 0) return -1
    if (b === 0) return 1
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

    // Steps 5+6: enumerate orderings, realize with forward-sweep DP repair, B&B cutoff
    for (const { ordering, cost: lbCost } of heldKarpGen(fLen, hkCosts)) {
      if (Date.now() >= deadline) { best.timedOut = true; break }
      if (lbCost - bonusCredit >= best.effectiveFuel) break  // B&B cutoff

      const result = realizeOrderingDP(ordering, forcedIdxs, sp, forbiddenDenseSet, matrix, bonusValueByDense)
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
