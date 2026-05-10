// Dry-run Lambda — invoke manually from the AWS console or CLI to verify
// the full pipeline (env vars, API connectivity, solver) without submitting.
// Fetches whatever challenges are currently active, solves them, and logs
// the routes that *would* be submitted, then returns a structured summary.

import { solve } from '../src/solver/solve.js'
import { adaptPlanet, adaptRoute, adaptChallenge } from '../src/solver/adapters.js'

const BASE_URL = process.env.VITE_API_BASE_URL
const PLAYER_GUID = process.env.VITE_PLAYER_GUID
const PLAYER_EMAIL = process.env.VITE_PLAYER_EMAIL

interface ChallengeOut {
  ChallengeId?: number
  ChallengeName: string
  StartPlanetId: string
  MandatoryPlanets?: { PlanetId?: number; Name: string }[]
  ForbiddenPlanets?: { PlanetId?: number; Name: string }[]
  BonusPlanets?: { PlanetId?: number; Name: string; Bonus?: number }[]
  IsFinished?: boolean
  Level: string
}

interface MapData {
  Planets?: { Id: number; Name: string; Coordinate_X?: number; Coordinate_Y?: number }[]
  Routes?: { From_Planet?: number; To_PlanetId?: number; RouteType: string }[]
}

interface DryRunResult {
  status: 'ok' | 'error'
  baseUrl: string
  challengesFound: number
  results: {
    challengeName: string
    challengeId: number | undefined
    isFinished: boolean
    solverSuccess: boolean
    effectiveFuel?: number
    grossFuel?: number
    collectedBonus?: number
    timedOut?: boolean
    solveMs?: number
    routeLength?: number
    route?: { PlanetId?: number; Name: string }[]
    errorMessage?: string
  }[]
  error?: string
}

function getAuth() {
  if (!BASE_URL || !PLAYER_GUID || !PLAYER_EMAIL) {
    throw new Error('Missing env vars: VITE_API_BASE_URL, VITE_PLAYER_GUID, VITE_PLAYER_EMAIL')
  }
  return { PlayerGuid: PLAYER_GUID, PlayerEmail: PLAYER_EMAIL }
}

async function apiGet<T>(path: string): Promise<T> {
  const auth = getAuth()
  console.log(`GET ${BASE_URL}${path}`)
  const res = await fetch(`${BASE_URL}${path}`, { headers: { ...auth } })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`)
  return res.json()
}

export const handler = async (): Promise<DryRunResult> => {
  console.log('=== DRY RUN — no submissions will be made ===')
  console.log(`API: ${BASE_URL ?? '(not set)'}`)
  console.log(`Player email: ${PLAYER_EMAIL ?? '(not set)'}`)
  console.log(`Player GUID set: ${Boolean(PLAYER_GUID)}`)

  const result: DryRunResult = {
    status: 'ok',
    baseUrl: BASE_URL ?? '(not set)',
    challengesFound: 0,
    results: [],
  }

  try {
    // Verify auth is configured before hitting the API
    getAuth()

    console.log('\nFetching challenges and map data...')
    const [allChallenges, mapData] = await Promise.all([
      apiGet<ChallengeOut[]>('/GetDailyChallenge'),
      apiGet<MapData>('/GetPlanetsAndRoutes'),
    ])

    const planets = (mapData.Planets ?? []).map(adaptPlanet)
    const routes = (mapData.Routes ?? []).map(adaptRoute)
    console.log(`Map: ${planets.length} planets, ${routes.length} routes`)

    const sorted = [...allChallenges].sort((a, b) => (a.ChallengeId ?? 0) - (b.ChallengeId ?? 0))
    result.challengesFound = sorted.length
    console.log(`Challenges found: ${sorted.length} (${sorted.filter(c => c.IsFinished).length} already finished)`)

    for (const challenge of sorted) {
      console.log(`\n--- "${challenge.ChallengeName}" (id=${challenge.ChallengeId}, finished=${challenge.IsFinished}) ---`)

      const t0 = performance.now()
      let challengeResult: DryRunResult['results'][number]

      try {
        const input = adaptChallenge(challenge, planets, routes)
        const solved = solve(input)
        const ms = Math.round(performance.now() - t0)

        if (solved.success) {
          const route = solved.orderedRoute.map(p => ({ PlanetId: p.id, Name: p.name }))
          console.log(`  Solver: OK in ${ms}ms`)
          console.log(`  effectiveFuel=${solved.effectiveFuel}  grossFuel=${solved.grossFuel}  bonus=${solved.collectedBonus}`)
          if (solved.timedOut) console.log('  WARNING: solver timed out — result may be suboptimal')
          console.log(`  Route (${route.length} stops): ${route.map(p => p.Name).join(' → ')}`)

          challengeResult = {
            challengeName: challenge.ChallengeName,
            challengeId: challenge.ChallengeId,
            isFinished: challenge.IsFinished ?? false,
            solverSuccess: true,
            effectiveFuel: solved.effectiveFuel,
            grossFuel: solved.grossFuel,
            collectedBonus: solved.collectedBonus,
            timedOut: solved.timedOut,
            solveMs: ms,
            routeLength: route.length,
            route,
          }
        } else {
          console.log(`  Solver FAILED: ${solved.errorMessage}`)
          challengeResult = {
            challengeName: challenge.ChallengeName,
            challengeId: challenge.ChallengeId,
            isFinished: challenge.IsFinished ?? false,
            solverSuccess: false,
            solveMs: ms,
            errorMessage: solved.errorMessage,
          }
        }
      } catch (err) {
        const ms = Math.round(performance.now() - t0)
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`  ERROR: ${msg}`)
        challengeResult = {
          challengeName: challenge.ChallengeName,
          challengeId: challenge.ChallengeId,
          isFinished: challenge.IsFinished ?? false,
          solverSuccess: false,
          solveMs: ms,
          errorMessage: msg,
        }
      }

      result.results.push(challengeResult)
    }

    console.log('\n=== DRY RUN COMPLETE — nothing was submitted ===')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Fatal error: ${msg}`)
    result.status = 'error'
    result.error = msg
  }

  return result
}
