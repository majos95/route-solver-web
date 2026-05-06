import type { SolveInput, SolveResult, Planet, Bonus } from './types'
import { buildRouteSets, edgeCost } from './edgeCost'
import { yenKsp, type KspPath } from './yenKsp'

const DEFAULT_K = 50

// Fewer paths per segment when there are many stops — the DFS branches at K^segments
function effectiveK(keyNodeCount: number, requestedK: number): number {
  if (keyNodeCount <= 4) return requestedK
  if (keyNodeCount <= 6) return Math.min(requestedK, 25)
  if (keyNodeCount <= 8) return Math.min(requestedK, 15)
  return Math.min(requestedK, 10)
}

function permutations(arr: number[]): number[][] {
  if (arr.length <= 1) return [arr.slice()]
  const result: number[][] = []
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
    for (const perm of permutations(rest)) result.push([arr[i], ...perm])
  }
  return result
}

function powerset<T>(arr: T[]): T[][] {
  const result: T[][] = [[]]
  for (const item of arr) {
    const len = result.length
    for (let i = 0; i < len; i++) result.push([...result[i], item])
  }
  return result
}

interface Best {
  effectiveFuel: number
  route: Planet[] | null
  gross: number
  collected: number
}

export function disjointTsp(input: SolveInput, requestedK = DEFAULT_K): SolveResult {
  const { planets, routes, startPlanetId, mandatoryIds, forbiddenIds, bonuses } = input

  const byId = new Map(planets.map((p) => [p.id, p]))
  const start = byId.get(startPlanetId)
  if (!start) return fail(`Start planet ${startPlanetId} not found in planet list`)

  const forbiddenSet = new Set(forbiddenIds)
  if (forbiddenSet.has(startPlanetId)) return fail('Start planet is forbidden')

  const mandatoryUnique = [...new Set(mandatoryIds.filter((id) => id !== startPlanetId))]

  for (const id of mandatoryUnique) {
    if (forbiddenSet.has(id)) return fail(`Mandatory planet ${byId.get(id)?.name ?? id} is also forbidden`)
    if (!byId.has(id)) return fail(`Mandatory planet ${id} not found in planet list — clear the session cache and retry`)
  }

  const { mainSet, otherSet } = buildRouteSets(routes)
  const allNodeIds = planets.map((p) => p.id)

  const validBonuses: Bonus[] = bonuses.filter(
    (b) => byId.has(b.planetId) && b.value > 0 && b.planetId !== startPlanetId,
  )

  if (mandatoryUnique.length === 0 && validBonuses.length === 0) {
    return { success: true, orderedRoute: [start, start], effectiveFuel: 0, grossFuel: 0, collectedBonus: 0 }
  }

  // Precompute KSP for ALL potential key nodes once, before the bonus-subset loop.
  // Recomputing per-subset would multiply work by 2^|bonuses|.
  const allKeyNodeIds = [startPlanetId, ...mandatoryUnique, ...validBonuses.map((b) => b.planetId)]
  const K = effectiveK(mandatoryUnique.length + 1, requestedK)
  const kspCache = new Map<string, KspPath[]>()

  for (const s of allKeyNodeIds) {
    for (const t of allKeyNodeIds) {
      if (s === t) continue
      const key = `${s}-${t}`
      if (kspCache.has(key)) continue
      kspCache.set(key, yenKsp(s, t, K, allNodeIds, forbiddenSet, mainSet, otherSet, byId))
    }
  }

  // Guarantee a direct (zero-intermediate) path exists for every key-node pair.
  // Yen's KSP returns paths sorted by cost, so a route-discounted multi-hop may appear
  // before the direct edge, pushing the direct path beyond position K. A direct path has
  // no intermediates, so it always satisfies the disjoint constraint — it's the fallback
  // that ensures the DFS can always complete a tour even for isolated or poorly-connected
  // mandatory planets.
  for (const s of allKeyNodeIds) {
    for (const t of allKeyNodeIds) {
      if (s === t) continue
      const key = `${s}-${t}`
      const paths = kspCache.get(key) ?? []
      if (!paths.some((p) => p.path.length === 2)) {
        const sNode = byId.get(s)!
        const tNode = byId.get(t)!
        paths.push({ cost: edgeCost(sNode, tNode, mainSet, otherSet), path: [s, t] })
        kspCache.set(key, paths)
      }
    }
  }

  // Fail fast if any mandatory pair is mutually unreachable
  const mandatoryNodes = [startPlanetId, ...mandatoryUnique]
  for (const s of mandatoryNodes) {
    for (const t of mandatoryNodes) {
      if (s === t) continue
      if ((kspCache.get(`${s}-${t}`) ?? []).length === 0) {
        return fail(`No reachable path from planet ${s} to ${t} — blocked by forbidden planets?`)
      }
    }
  }

  const best: Best = { effectiveFuel: Infinity, route: null, gross: 0, collected: 0 }

  for (const bonusSubset of powerset(validBonuses)) {
    const bonusCredit = bonusSubset.reduce((s, b) => s + b.value, 0)
    const bonusPlanetIds = bonusSubset.map((b) => b.planetId)
    const forcedStops = [...new Set([...mandatoryUnique, ...bonusPlanetIds])]

    if (forcedStops.length === 0) {
      if (-bonusCredit < best.effectiveFuel) {
        best.effectiveFuel = -bonusCredit
        best.route = [start, start]
        best.gross = 0
        best.collected = bonusCredit
      }
      continue
    }

    for (const perm of permutations(forcedStops)) {
      const segKsps: KspPath[][] = []
      let prev = startPlanetId
      for (const stop of perm) {
        segKsps.push(kspCache.get(`${prev}-${stop}`) ?? [])
        prev = stop
      }
      segKsps.push(kspCache.get(`${prev}-${startPlanetId}`) ?? [])

      if (segKsps.some((s) => s.length === 0)) continue

      dfsDisjoint(segKsps, 0, new Set([startPlanetId]), 0, [start], bonusCredit, best, byId)
    }
  }

  if (!best.route) return fail('No valid disjoint route found — try increasing K')

  return {
    success: true,
    orderedRoute: best.route,
    effectiveFuel: best.effectiveFuel,
    grossFuel: best.gross,
    collectedBonus: best.collected,
  }
}

function dfsDisjoint(
  segKsps: KspPath[][],
  idx: number,
  visited: Set<number>,
  costSoFar: number,
  pathSoFar: Planet[],
  bonusCredit: number,
  best: Best,
  byId: Map<number, Planet>,
): void {
  if (costSoFar - bonusCredit >= best.effectiveFuel) return

  if (idx === segKsps.length) {
    best.effectiveFuel = costSoFar - bonusCredit
    best.route = pathSoFar
    best.gross = costSoFar
    best.collected = bonusCredit
    return
  }

  const isLastSegment = idx === segKsps.length - 1

  for (const { cost, path } of segKsps[idx]) {
    if (costSoFar + cost - bonusCredit >= best.effectiveFuel) break

    const intermediates = path.slice(1, -1)
    if (intermediates.some((n) => visited.has(n))) continue

    const target = path[path.length - 1]
    if (!isLastSegment && visited.has(target)) continue

    const newVisited = new Set(visited)
    for (const n of intermediates) newVisited.add(n)
    if (!isLastSegment) newVisited.add(target)

    dfsDisjoint(
      segKsps,
      idx + 1,
      newVisited,
      costSoFar + cost,
      [...pathSoFar, ...path.slice(1).map((id) => byId.get(id)!)],
      bonusCredit,
      best,
      byId,
    )
  }
}

function fail(msg: string): SolveResult {
  return { success: false, errorMessage: msg, orderedRoute: [], effectiveFuel: 0, grossFuel: 0, collectedBonus: 0 }
}
