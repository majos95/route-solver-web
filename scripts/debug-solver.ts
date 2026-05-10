/**
 * Debug script — runs T14 (Mandalore, 5 mandatories) with full instrumentation.
 * Logs every ordering tried by Held-Karp, segment SP paths, conflicts, repairs, and realized costs.
 *
 * Usage:  npx tsx scripts/debug-solver.ts
 * Add --top=N to see the first N orderings tried (default 30).
 * Add --target=<effectiveFuel> to stop after finding the first ordering that beats the target.
 */

import { adaptPlanet, adaptRoute } from '../src/solver/adapters'
import { buildCostMatrix } from '../src/solver/costMatrix'
import { computeAllPairsSP } from '../src/solver/allPairsSP'
import { heldKarpGen } from '../src/solver/heldKarp'
import { MinHeap } from '../src/solver/heap'
import type { CostMatrix } from '../src/solver/costMatrix'
import type { AllPairsSP } from '../src/solver/allPairsSP'
import { PLANETS_RAW, ROUTES_RAW } from '../src/solver/__tests__/realWorld.fixture'

// ── Challenge config ────────────────────────────────────────────────────────
const START_ID    = 90                      // Mandalore
const MANDATORY   = [104, 2, 58, 44, 76]   // Dantooine, Alderaan, Naboo, Denon, Gizer
const FORBIDDEN   : number[] = []
const BONUSES     : { planetId: number; value: number }[] = []
const GAME_OPTIMAL = 3472

// ── CLI args ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] }),
)
const MAX_ORDERINGS = parseInt(args['top'] ?? '30', 10)
const TARGET        = parseFloat(args['target'] ?? String(GAME_OPTIMAL))

// ── Setup ───────────────────────────────────────────────────────────────────
const planets    = PLANETS_RAW.map(adaptPlanet)
const routes     = ROUTES_RAW.map(adaptRoute)
const byId       = new Map(planets.map(p => [p.id, p]))
const matrix     = buildCostMatrix(planets, routes)
const { idToIdx, idxToId } = matrix

function name(denseIdx: number): string {
  const id = idxToId[denseIdx]
  return `${byId.get(id)?.name ?? '?'}(${id})`
}

const startIdx      = idToIdx.get(START_ID)!
const forbiddenSet  = new Set(FORBIDDEN)
const forbiddenDense = new Set(
  [...forbiddenSet].flatMap(id => { const i = idToIdx.get(id); return i !== undefined ? [i] : [] })
)
const mandatoryIdxs = MANDATORY.map(id => idToIdx.get(id)!)
const validBonuses  = BONUSES.filter(b => byId.has(b.planetId) && b.value > 0 && !forbiddenSet.has(b.planetId))
const bonusIdxByPlanetId = new Map(validBonuses.map(b => [b.planetId, idToIdx.get(b.planetId)!]))
const bonusValueByDense  = new Map(validBonuses.map(b => [bonusIdxByPlanetId.get(b.planetId)!, b.value]))

const forcedIdxs = [startIdx, ...mandatoryIdxs]
const fLen = forcedIdxs.length
const bonusCredit = 0

console.log('=== Solver Debug ===')
console.log(`Start: ${name(startIdx)}`)
console.log(`Mandatory: ${mandatoryIdxs.map(name).join(', ')}`)
console.log(`Forced stops (${fLen}): ${forcedIdxs.map(name).join(', ')}`)
console.log(`Game optimal: ${GAME_OPTIMAL}  |  Scanning first ${MAX_ORDERINGS} orderings\n`)

// ── All-pairs SP ────────────────────────────────────────────────────────────
const sp = computeAllPairsSP(matrix, forcedIdxs, forbiddenDense)

console.log('SP costs between forced stops:')
for (const a of forcedIdxs) {
  for (const b of forcedIdxs) {
    if (a === b) continue
    const c = sp.spCost.get(a)![b]
    const p = sp.spPath.get(a)![b]
    const via = p && p.length > 2 ? ` via [${p.slice(1,-1).map(name).join(',')}]` : ''
    console.log(`  ${name(a)} → ${name(b)}: ${c.toFixed(2)}${via}`)
  }
}
console.log()

// ── Held-Karp cost matrix ───────────────────────────────────────────────────
const hkCosts = new Float64Array(fLen * fLen)
for (let i = 0; i < fLen; i++) {
  const row = sp.spCost.get(forcedIdxs[i])
  if (!row) continue
  for (let j = 0; j < fLen; j++) hkCosts[i * fLen + j] = row[forcedIdxs[j]]
}

// ── Repair Dijkstra (copy from solver) ─────────────────────────────────────
function repairDijkstra(
  src: number, dst: number,
  addForbidden: ReadonlySet<number>,
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
      if (v === u || forbiddenDense.has(v) || addForbidden.has(v)) continue
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

// ── Instrumented realize ────────────────────────────────────────────────────
function realizeOrdering(
  ordering: number[],
  lbCost: number,
  verbose: boolean,
): { route: number[]; gross: number; collected: number } | null {
  const stopNames = ordering.map(i => name(forcedIdxs[i])).join(' → ')
  if (verbose) console.log(`  Ordering: ${stopNames}  (lb=${lbCost.toFixed(2)})`)

  const allForcedDense = new Set(forcedIdxs)
  const visitedDense   = new Set<number>([startIdx])
  const segPaths: number[][] = []
  let gross = 0

  for (let i = 0; i < ordering.length - 1; i++) {
    const srcDense = forcedIdxs[ordering[i]]
    const dstDense = forcedIdxs[ordering[i + 1]]
    const isLastSeg = i === ordering.length - 2

    if (!isLastSeg && visitedDense.has(dstDense)) {
      if (verbose) console.log(`    Seg ${i}: EARLY REJECT — dst ${name(dstDense)} already visited`)
      return null
    }

    let path = sp.spPath.get(srcDense)?.[dstDense] ?? null
    let cost = path !== null ? sp.spCost.get(srcDense)![dstDense] : Infinity
    if (path === null) {
      if (verbose) console.log(`    Seg ${i}: NO PATH from ${name(srcDense)} to ${name(dstDense)}`)
      return null
    }

    const intermediates = path.slice(1, -1)
    const conflictNodes = intermediates.filter(v => visitedDense.has(v) || allForcedDense.has(v))
    const hasConflict   = conflictNodes.length > 0

    if (hasConflict) {
      const addForbidden = new Set(visitedDense)
      for (const f of allForcedDense) addForbidden.add(f)
      addForbidden.delete(dstDense)

      const repaired = repairDijkstra(srcDense, dstDense, addForbidden)
      if (repaired === null) {
        if (verbose) console.log(`    Seg ${i} (${name(srcDense)}→${name(dstDense)}): REPAIR FAILED. Conflict nodes: [${conflictNodes.map(name).join(',')}]`)
        return null
      }
      if (verbose) {
        const reason = conflictNodes.map(v =>
          visitedDense.has(v) ? `${name(v)}=visited` : `${name(v)}=future-forced`
        ).join(', ')
        console.log(`    Seg ${i} (${name(srcDense)}→${name(dstDense)}): REPAIRED  sp=${cost.toFixed(2)} → repaired=${repaired.cost.toFixed(2)}  (+${(repaired.cost - cost).toFixed(2)})  conflict:[${reason}]`)
        console.log(`      SP path:      [${path.map(name).join(' → ')}]`)
        console.log(`      Repaired path:[${repaired.path.map(name).join(' → ')}]`)
      }
      path = repaired.path
      cost = repaired.cost
    } else {
      if (verbose && path.length > 2) {
        console.log(`    Seg ${i} (${name(srcDense)}→${name(dstDense)}): ok  cost=${cost.toFixed(2)}  via [${intermediates.map(name).join(',')}]`)
      } else if (verbose) {
        console.log(`    Seg ${i} (${name(srcDense)}→${name(dstDense)}): ok  cost=${cost.toFixed(2)}`)
      }
    }

    gross += cost
    segPaths.push(path)
    for (const v of path.slice(1)) visitedDense.add(v)
  }

  // Concatenate route
  const routeDense: number[] = [startIdx]
  for (const path of segPaths) for (const v of path.slice(1)) routeDense.push(v)
  if (routeDense.length === 1) routeDense.push(startIdx)

  // Final no-revisit check
  const seen = new Set<number>()
  for (let k = 0; k < routeDense.length; k++) {
    const v = routeDense[k]
    const isEndpoint = k === 0 || k === routeDense.length - 1
    if (seen.has(v) && !(isEndpoint && v === startIdx)) {
      if (verbose) console.log(`    FINAL REVISIT CHECK FAILED at ${name(v)}`)
      return null
    }
    seen.add(v)
  }

  let collected = 0
  for (const d of routeDense) { const val = bonusValueByDense.get(d); if (val) collected += val }
  return { route: routeDense, gross, collected }
}

// ── Main loop ───────────────────────────────────────────────────────────────
let best    = Infinity
let tried   = 0
let found   = false

console.log('=== Ordering scan ===\n')

for (const { ordering, cost: lbCost } of heldKarpGen(fLen, hkCosts)) {
  if (lbCost - bonusCredit >= best) { console.log(`B&B cutoff at lb=${lbCost.toFixed(2)}, best=${best.toFixed(2)}`); break }

  tried++
  const verbose = tried <= MAX_ORDERINGS
  const result  = realizeOrdering(ordering, lbCost, verbose)

  if (result !== null) {
    const effective = result.gross - result.collected
    if (verbose) {
      console.log(`    → REALIZED  gross=${result.gross.toFixed(2)}  effective=${effective.toFixed(2)}${effective < best ? '  *** NEW BEST ***' : ''}`)
    }
    if (effective < best) {
      best = effective
      if (verbose) {
        const route = result.route.map(d => name(d)).join(' → ')
        console.log(`    ROUTE: ${route}`)
      }
    }
    if (effective <= TARGET) {
      console.log(`\n✓ Found ordering that reaches/beats target ${TARGET} at ordering #${tried}`)
      found = true
      break
    }
  } else {
    if (verbose) console.log(`    → REJECTED`)
  }
  if (verbose) console.log()
}

console.log(`\n=== Summary ===`)
console.log(`Orderings tried: ${tried}`)
console.log(`Best effective:  ${best.toFixed(2)}`)
console.log(`Game optimal:    ${GAME_OPTIMAL}`)
console.log(`Gap:             ${(best - GAME_OPTIMAL).toFixed(2)}`)
if (!found) console.log(`Target ${TARGET} not reached in first ${MAX_ORDERINGS} orderings`)
