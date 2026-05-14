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
// Target state count for realizeOrderingDP: (segCount+1) × n × 2^K.
// Keeping this under ~30k gives ~20ms per ordering at typical JS speed.
const MAX_DP_STATES = 120_000

function identifyKeyNodes(
  ordering: number[],
  forcedIdxs: number[],
  sp: AllPairsSP,
  forcedSet: ReadonlySet<number>,
  n: number,
  segCount: number,
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
  const maxK = Math.max(0, Math.floor(Math.log2(MAX_DP_STATES / ((segCount + 1) * n))))
  return [...freq.entries()]
    .filter(([, f]) => f >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxK)
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
  const keyNodes = identifyKeyNodes(ordering, forcedIdxs, sp, forcedSet, n, segCount)
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
  let bestState = -1

  while (pq.size > 0) {
    const [d, state] = pq.pop()!
    if (d > dist[state]) continue

    const mask = state % maskCount
    const rem = (state / maskCount) | 0
    const planet = rem % n
    const seg = (rem / n) | 0

    if (seg === segCount) {
      bestState = state  // first pop at segCount is Dijkstra-optimal — stop immediately
      break
    }

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

  if (!isFinite(dist[bestState] ?? Infinity)) return null

  // Reconstruct dense-index route by following parent pointers
  const routeDense: number[] = []
  let cur: number = bestState
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

// Orienteering DP: identifies which bonus subsets are worth considering and their
// DP-optimal ordering. Returns one candidate per unique bonus bitmask, sorted so the
// mandatory-only subset (bonusMask=0) comes first — establishing an initial upper bound
// before large subsets are attempted. Remaining candidates are sorted by lbCost ascending.
// For subsets with fLen ≤ MAX_HK_N the caller hands off to heldKarpGen for full ordering
// enumeration; for larger subsets the stored dpKeySeq is used as a fallback ordering.
const MAX_HK_N = 11  // heldKarpGen is used for fLen ≤ this; DP fallback for fLen > this

function orienteeringDPCandidates(
  allKeyDense: number[],    // [startDense, m0..mM-1, b0..bB-1]
  mandatoryCount: number,
  sp: AllPairsSP,
  bonusValueByDense: ReadonlyMap<number, number>,
): { bonusMask: number; lbCost: number; dpKeySeq: number[] }[] {
  const nk = allKeyDense.length
  const stateCount = (1 << nk) * nk
  const dp  = new Float64Array(stateCount).fill(Infinity)
  const par = new Int32Array(stateCount).fill(-1)

  const mandatoryBits  = (2 << mandatoryCount) - 2  // bits 1..mandatoryCount
  const bonusBitOffset = 1 + mandatoryCount          // bonus bits start here in the mask

  dp[nk] = 0  // mask=1 (start visited), v=0, cost=0

  for (let mask = 1; mask < (1 << nk); mask++) {
    if (!(mask & 1)) continue
    for (let v = 0; v < nk; v++) {
      if (!(mask & (1 << v))) continue
      const cur = dp[mask * nk + v]
      if (!isFinite(cur)) continue
      for (let u = 1; u < nk; u++) {
        if (mask & (1 << u)) continue
        const cost = sp.spCost.get(allKeyDense[v])?.[allKeyDense[u]]
        if (cost === undefined || !isFinite(cost)) continue
        const bonus = bonusValueByDense.get(allKeyDense[u]) ?? 0
        const nd = cur + cost - bonus
        const ns = (mask | (1 << u)) * nk + u
        if (nd < dp[ns]) { dp[ns] = nd; par[ns] = mask * nk + v }
      }
    }
  }

  // For each unique bonus bitmask, record the best terminal state and backtrack it.
  const bonusMaskBest = new Map<number, { lbCost: number; state: number }>()
  for (let mask = 1; mask < (1 << nk); mask++) {
    if ((mask & mandatoryBits) !== mandatoryBits) continue
    for (let v = 0; v < nk; v++) {
      if (!(mask & (1 << v))) continue
      const cur = dp[mask * nk + v]
      if (!isFinite(cur)) continue
      const ret = v === 0 ? 0 : (sp.spCost.get(allKeyDense[v])?.[allKeyDense[0]] ?? Infinity)
      if (!isFinite(ret)) continue
      const total    = cur + ret
      const bonusMask = mask >> bonusBitOffset
      const existing = bonusMaskBest.get(bonusMask)
      if (!existing || total < existing.lbCost) bonusMaskBest.set(bonusMask, { lbCost: total, state: mask * nk + v })
    }
  }

  const results: { bonusMask: number; lbCost: number; dpKeySeq: number[] }[] = []
  for (const [bonusMask, { lbCost, state }] of bonusMaskBest) {
    const seq: number[] = []
    let cur = state
    while (cur !== -1) { seq.unshift(cur % nk); cur = par[cur] }
    seq.push(0)
    results.push({ bonusMask, lbCost, dpKeySeq: seq })
  }

  // Mandatory-only subset (bonusMask=0) goes first to establish an initial bound,
  // preventing heldKarpGen from exploring unbounded orderings without a B&B threshold.
  results.sort((a, b) => {
    if (a.bonusMask === 0 && b.bonusMask !== 0) return -1
    if (b.bonusMask === 0 && a.bonusMask !== 0) return 1
    return a.lbCost - b.lbCost
  })
  return results
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

  // Orienteering DP selects which bonus subsets to try; heldKarpGen enumerates orderings
  // within each subset for small fLen (complete, correct), DP ordering for large fLen (no OOM).
  const allKeyDense = [startIdx, ...mandatoryIdxs, ...validBonuses.map(b => bonusIdxByPlanetId.get(b.planetId)!)]
  const bonusCandidates = orienteeringDPCandidates(
    allKeyDense, mandatoryIdxs.length, sp, bonusValueByDense,
  )

  for (const { bonusMask, lbCost, dpKeySeq } of bonusCandidates) {
    if (Date.now() >= deadline) { best.timedOut = true; break }
    if (lbCost >= best.effectiveFuel) break  // B&B cutoff

    const subsetBonuses    = validBonuses.filter((_, k) => bonusMask & (1 << k))
    const bonusCredit      = subsetBonuses.reduce((s, b) => s + b.value, 0)
    const bonusSubsetIdxs  = subsetBonuses.map(b => bonusIdxByPlanetId.get(b.planetId)!)
    const forcedIdxs       = [startIdx, ...mandatoryIdxs, ...bonusSubsetIdxs]
    const fLen             = forcedIdxs.length

    if (fLen <= MAX_HK_N) {
      // Full ordering enumeration via heldKarpGen — correct even under path interference.
      const hkCosts = new Float64Array(fLen * fLen)
      for (let i = 0; i < fLen; i++) {
        const row = sp.spCost.get(forcedIdxs[i])
        if (!row) continue
        for (let j = 0; j < fLen; j++) hkCosts[i * fLen + j] = row[forcedIdxs[j]]
      }

      // Realize the DP-optimal ordering first to get a tight initial B&B bound.
      // dpKeySeq indices are into allKeyDense; map them to forcedIdxs positions.
      {
        const M = mandatoryIdxs.length
        const kiToPos: number[] = new Array(allKeyDense.length)
        for (let i = 0; i <= M; i++) kiToPos[i] = i  // start + mandatory: same positions
        let bRank = 0
        for (let b = 0; b < validBonuses.length; b++) {
          if (bonusMask & (1 << b)) kiToPos[M + 1 + b] = M + 1 + bRank++
        }
        const dpOrdering = dpKeySeq.map((ki) => kiToPos[ki])
        const dpWarm = realizeOrderingDP(dpOrdering, forcedIdxs, sp, forbiddenDenseSet, matrix, bonusValueByDense)
        if (dpWarm !== null) {
          const dpEff = dpWarm.gross - dpWarm.collected
          if (dpEff < best.effectiveFuel) {
            best.effectiveFuel = dpEff
            best.route         = dpWarm.route
            best.gross         = dpWarm.gross
            best.collected     = dpWarm.collected
          }
        }
      }

      for (const { ordering, cost: lbOrd } of heldKarpGen(fLen, hkCosts)) {
        if (Date.now() >= deadline) { best.timedOut = true; break }
        if (lbOrd - bonusCredit >= best.effectiveFuel) break
        const result = realizeOrderingDP(ordering, forcedIdxs, sp, forbiddenDenseSet, matrix, bonusValueByDense)
        if (result === null) continue
        const effective = result.gross - result.collected
        if (effective < best.effectiveFuel) {
          best.effectiveFuel = effective
          best.route         = result.route
          best.gross         = result.gross
          best.collected     = result.collected
        }
      }
    } else {
      // DP fallback for large subsets: use the DP-optimal ordering for this bonus mask.
      const forcedSeq    = dpKeySeq.slice(0, -1)
      const forcedDpIdxs = forcedSeq.map(ki => allKeyDense[ki])
      const ordering     = forcedSeq.map((_, i) => i).concat([0])
      const result = realizeOrderingDP(ordering, forcedDpIdxs, sp, forbiddenDenseSet, matrix, bonusValueByDense)
      if (result !== null) {
        const effective = result.gross - result.collected
        if (effective < best.effectiveFuel) {
          best.effectiveFuel = effective
          best.route         = result.route
          best.gross         = result.gross
          best.collected     = result.collected
        }
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
