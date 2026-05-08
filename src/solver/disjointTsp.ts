import type { SolveInput, SolveResult, Planet, Bonus } from './types'
import { buildRouteSets } from './edgeCost'
import { yenKsp, type KspPath } from './yenKsp'

const DEFAULT_K = 0       // 0 = auto: complexity-adaptive K selection
const TIMEOUT_MS = 30_000 // return best-so-far after 30 s

function adaptiveK(mandatoryCount: number, bonusCount: number): number {
  const stops = mandatoryCount + bonusCount
  if (stops <= 1) return 3
  if (stops <= 3) return 10
  if (stops <= 5) return 12
  return 15
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
  timedOut: boolean
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
  const K = requestedK === DEFAULT_K ? adaptiveK(mandatoryUnique.length, validBonuses.length) : requestedK
  const kspCache = new Map<string, KspPath[]>()

  for (const s of allKeyNodeIds) {
    for (const t of allKeyNodeIds) {
      if (s === t) continue
      const key = `${s}-${t}`
      if (kspCache.has(key)) continue
      kspCache.set(key, yenKsp(s, t, K, allNodeIds, forbiddenSet, mainSet, otherSet, byId))
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

  const best: Best = { effectiveFuel: Infinity, route: null, gross: 0, collected: 0, timedOut: false }
  const deadline = Date.now() + TIMEOUT_MS

  // Sort subsets highest-value first so branch-and-bound gets a tight upper
  // bound early and prunes low-value subsets aggressively.
  const sortedSubsets = powerset(validBonuses).sort(
    (a, b) => b.reduce((s, x) => s + x.value, 0) - a.reduce((s, x) => s + x.value, 0),
  )

  for (const bonusSubset of sortedSubsets) {
    if (best.timedOut) break
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

    // Build segment-KSP arrays for every permutation up front, compute each
    // permutation's lower bound (sum of cheapest first-path costs), then sort
    // ascending. This lets us break as soon as lb - bonusCredit >= best rather
    // than continuing to iterate permutations that can't possibly improve it.
    const orderedPerms = permutations(forcedStops).map((perm) => {
      const segKsps: KspPath[][] = []
      let prev = startPlanetId
      for (const stop of perm) {
        segKsps.push(kspCache.get(`${prev}-${stop}`) ?? [])
        prev = stop
      }
      segKsps.push(kspCache.get(`${prev}-${startPlanetId}`) ?? [])
      const lb = segKsps.reduce((s, paths) => s + (paths[0]?.cost ?? Infinity), 0)
      return { segKsps, lb }
    })
    orderedPerms.sort((a, b) => a.lb - b.lb)

    for (const { segKsps, lb } of orderedPerms) {
      if (best.timedOut) break
      if (segKsps.some((s) => s.length === 0)) continue
      if (lb - bonusCredit >= best.effectiveFuel) break  // sorted — all remaining worse

      dfsDisjoint(segKsps, 0, new Set([startPlanetId]), 0, [start], bonusCredit, best, byId, deadline)
    }
  }

  if (!best.route) return fail('No valid route found')

  // Credit bonus planets that were visited as route intermediates but weren't
  // planned forced stops — the DFS picks cheapest paths regardless of bonuses,
  // so a bonus planet may appear in the route "for free".
  const routeIds = new Set(best.route.map((p) => p.id))
  const actualBonus = validBonuses.filter((b) => routeIds.has(b.planetId)).reduce((s, b) => s + b.value, 0)
  if (actualBonus > best.collected) {
    best.collected = actualBonus
    best.effectiveFuel = best.gross - actualBonus
  }

  return {
    success: true,
    orderedRoute: best.route,
    effectiveFuel: best.effectiveFuel,
    grossFuel: best.gross,
    collectedBonus: best.collected,
    timedOut: best.timedOut || undefined,
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
  deadline: number,
): void {
  if (Date.now() >= deadline) { best.timedOut = true; return }
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

    // Only track planned stops (mandatory/bonus endpoints) in visited —
    // ordinary transit nodes may appear in multiple segments. The game API
    // enforces forbidden-planet avoidance and mandatory-planet visitation
    // but does not reject routes for revisiting transit hops.
    const target = path[path.length - 1]
    if (!isLastSegment && visited.has(target)) continue

    const newVisited = new Set(visited)
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
      deadline,
    )
  }
}

function fail(msg: string): SolveResult {
  return { success: false, errorMessage: msg, orderedRoute: [], effectiveFuel: 0, grossFuel: 0, collectedBonus: 0 }
}
