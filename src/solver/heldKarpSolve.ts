import type { SolveInput, SolveResult } from './types'
import type { CostMatrix } from './costMatrix'
import type { AllPairsSP } from './allPairsSP'
import { buildCostMatrix } from './costMatrix'
import { computeAllPairsSP } from './allPairsSP'
import { heldKarpGen } from './heldKarp'

const TIMEOUT_MS = 5 * 60 * 1000

// Target state count per Dijkstra call: (segCount+1) × n × 2^K.
// Lower value = smaller state space = faster per call; K drops from 6 to 3-4 for typical inputs.
// Target state count per Dijkstra call: (segCount+1) × n × 2^K.
// For T16 (fLen=8, ordering.length=9, segCount=8, n=194):
//   maxK = floor(log2(120000 / (9×194))) = 6; totalStates = 9×194×64 = 111,744.
// Reducing below 120K silently drops K from 6 to 5 for 8-segment orderings, causing wrong answers.
const MAX_DP_STATES = 120_000
// Fixed heap capacity per Dijkstra call. With K=6 and 111K states, the frontier can
// transiently hold many entries (each state may be pushed multiple times before settling).
// 1M entries = 12 MB pre-allocated; enough headroom even for dense orderings.
const HEAP_CAP = 1_000_000

// Working buffers shared across all realizeOrderingDP calls within one heldKarpSolve.
// Pre-allocating eliminates per-call TypedArray alloc (GC pressure) and
// per-push object boxing (the old MinHeap<number> allocated a [number,number] per push).
interface DpWork {
  dist:    Float64Array  // [MAX_DP_STATES]
  parent:  Int32Array    // [MAX_DP_STATES]
  stopOf:  Int32Array    // [n] stop-index per node (−1 if not a forced stop)
  keyBit:  Int32Array    // [n] bitmask bit per key node (0 otherwise)
  forbArr: Uint8Array    // [n] 1 if forbidden
  hPri:    Float64Array  // [HEAP_CAP] typed-heap priorities
  hVal:    Int32Array    // [HEAP_CAP] typed-heap state ids
  hSz:     number        // current heap size (reset to 0 before each Dijkstra)
}

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

// Typed min-heap push — no boxing, operates on shared TypedArrays in DpWork.
function hpush(dpw: DpWork, p: number, v: number): void {
  if (dpw.hSz >= HEAP_CAP) return  // overflow guard; should not trigger in practice
  let i = dpw.hSz++
  dpw.hPri[i] = p; dpw.hVal[i] = v
  while (i > 0) {
    const par = (i - 1) >> 1
    if (dpw.hPri[par] <= dpw.hPri[i]) break
    const tp = dpw.hPri[par]; dpw.hPri[par] = dpw.hPri[i]; dpw.hPri[i] = tp
    const tv = dpw.hVal[par]; dpw.hVal[par] = dpw.hVal[i]; dpw.hVal[i] = tv
    i = par
  }
}

// Typed min-heap pop — returns the state id; caller reads dpw.hPri[0] for priority BEFORE calling.
function hpop(dpw: DpWork): number {
  const rv = dpw.hVal[0]
  const last = --dpw.hSz
  if (last > 0) {
    dpw.hPri[0] = dpw.hPri[last]; dpw.hVal[0] = dpw.hVal[last]
    let i = 0
    while (true) {
      let sm = i
      const l = 2 * i + 1, r = 2 * i + 2
      if (l < dpw.hSz && dpw.hPri[l] < dpw.hPri[sm]) sm = l
      if (r < dpw.hSz && dpw.hPri[r] < dpw.hPri[sm]) sm = r
      if (sm === i) break
      const tp = dpw.hPri[sm]; dpw.hPri[sm] = dpw.hPri[i]; dpw.hPri[i] = tp
      const tv = dpw.hVal[sm]; dpw.hVal[sm] = dpw.hVal[i]; dpw.hVal[i] = tv
      i = sm
    }
  }
  return rv
}

// Realize one Held-Karp ordering via DP on joint state (segment, planet, keyNodeMask).
// Tracks which bottleneck transit nodes have been consumed across segments so that
// later segments can route around them rather than taking expensive repairs.
// Returns null if no valid simple path exists for this ordering.
//
// stopOf encoding: stopOf[v] = i means v is stops[i].
//   • i ∈ 1..segCount−1  → a non-start forced stop (mandatory or bonus)
//   • i = segCount        → startDense (the return position); blocks it as a future stop
//                           in all but the final segment, naturally.
//   • −1                  → not a forced stop; transit freely allowed.
function realizeOrderingDP(
  ordering: number[],
  forcedIdxs: number[],
  sp: AllPairsSP,
  matrix: CostMatrix,
  bonusValueByDense: ReadonlyMap<number, number>,
  dpw: DpWork,
  cutoff: number,  // best.effectiveFuel + bonusCredit; prune states whose cost+lb ≥ cutoff
): { route: number[]; gross: number; collected: number } | null {
  const { n, data } = matrix
  const segCount = ordering.length - 1
  const stops = ordering.map(i => forcedIdxs[i])
  const startDense = stops[0]

  const forcedSet = new Set(forcedIdxs)
  const keyNodes = identifyKeyNodes(ordering, forcedIdxs, sp, forcedSet, n, segCount)
  const K = keyNodes.length
  const maskCount = 1 << K

  // Set up keyBit (pre-allocated, all-zero; reset positions after call)
  const keyBit = dpw.keyBit
  for (let k = 0; k < K; k++) keyBit[keyNodes[k]] = 1 << k

  // Set up stopOf (pre-allocated, all −1; reset positions after call)
  const stopOf = dpw.stopOf
  for (let i = 1; i < segCount; i++) stopOf[stops[i]] = i
  stopOf[startDense] = segCount  // blocks start as future stop until the final return segment

  // Precompute per-segment SP rows and suffix lower bounds for B&B pruning.
  // spRows[s] = sp.spCost from stops[s+1] (= SP from stops[s+1] to all planets, used reversed by symmetry)
  // suffix[s] = abstract lower bound on remaining cost FROM stops[s] to destination
  const spRows: (Float64Array | undefined)[] = new Array(segCount)
  const suffix = new Float64Array(segCount + 1)
  for (let s = 0; s < segCount; s++) spRows[s] = sp.spCost.get(stops[s + 1])
  for (let s = segCount - 1; s >= 1; s--) {
    suffix[s] = (sp.spCost.get(stops[s])?.[stops[s + 1]] ?? 0) + suffix[s + 1]
  }

  // State encoding: (seg * n + planet) * maskCount + mask
  const encode = (seg: number, planet: number, mask: number) =>
    (seg * n + planet) * maskCount + mask

  const totalStates = (segCount + 1) * n * maskCount

  // Reset only the used slice of pre-allocated arrays
  const dist   = dpw.dist
  const parent = dpw.parent
  dist.fill(Infinity, 0, totalStates)
  parent.fill(-2, 0, totalStates)

  dpw.hSz = 0
  const startState = encode(0, startDense, 0)  // startDense is never a key node (filtered by forcedSet)
  dist[startState] = 0
  parent[startState] = -1
  hpush(dpw, 0, startState)

  let bestState = -1

  while (dpw.hSz > 0) {
    const d = dpw.hPri[0]  // peek priority before pop
    const state = hpop(dpw)
    if (d > dist[state]) continue

    const mask = state % maskCount
    const rem  = (state / maskCount) | 0
    const planet = rem % n
    const seg    = (rem / n) | 0

    if (seg === segCount) {
      bestState = state  // first pop at segCount is Dijkstra-optimal — stop immediately
      break
    }

    // B&B pruning: lower bound on remaining gross = SP(planet→nextStop) + suffix[seg+1].
    // If current gross + remaining lb ≥ cutoff, this state can't improve the current best.
    // (Graph is symmetric so spRows[seg][planet] = SP from planet to stops[seg+1].)
    const hRemain = (spRows[seg]?.[planet] ?? Infinity) + suffix[seg + 1]
    if (d + hRemain >= cutoff) continue

    const nextStop = stops[seg + 1]
    const base = planet * n

    for (let w = 0; w < n; w++) {
      if (w === planet) continue
      if (dpw.forbArr[w]) continue

      const wBit = keyBit[w]
      if (wBit && (mask & wBit)) continue  // key node already consumed in this path

      const ws = stopOf[w]
      if (ws !== -1) {
        if (ws <= seg) continue    // past forced stop — already visited
        if (ws > seg + 1) continue // future forced stop — premature transit
        // ws === seg + 1 → this is the next stop; allowed, advances segment below
      }

      const newMask = mask | wBit
      const newSeg  = w === nextStop ? seg + 1 : seg
      const nd = d + data[base + w]
      const ns = encode(newSeg, w, newMask)
      if (nd < dist[ns]) {
        dist[ns] = nd
        parent[ns] = state
        hpush(dpw, nd, ns)
      }
    }
  }

  // Restore pre-allocated arrays to their default values
  for (let i = 1; i < segCount; i++) stopOf[stops[i]] = -1
  stopOf[startDense] = -1
  for (let k = 0; k < K; k++) keyBit[keyNodes[k]] = 0

  if (bestState === -1) return null

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
  const { idToIdx, idxToId, n } = matrix

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

  // Pre-allocate working buffers shared across all realizeOrderingDP calls.
  // Eliminates per-call TypedArray allocation (GC pressure) and per-push object boxing.
  const dpw: DpWork = {
    dist:    new Float64Array(MAX_DP_STATES),
    parent:  new Int32Array(MAX_DP_STATES),
    stopOf:  new Int32Array(n).fill(-1),
    keyBit:  new Int32Array(n),
    forbArr: new Uint8Array(n),
    hPri:    new Float64Array(HEAP_CAP),
    hVal:    new Int32Array(HEAP_CAP),
    hSz:     0,
  }
  for (const idx of forbiddenDenseSet) dpw.forbArr[idx] = 1

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
        const dpWarm = realizeOrderingDP(dpOrdering, forcedIdxs, sp, matrix, bonusValueByDense, dpw, best.effectiveFuel + bonusCredit)
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
        const result = realizeOrderingDP(ordering, forcedIdxs, sp, matrix, bonusValueByDense, dpw, best.effectiveFuel + bonusCredit)
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
      const result = realizeOrderingDP(ordering, forcedDpIdxs, sp, matrix, bonusValueByDense, dpw, best.effectiveFuel + bonusCredit)
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
