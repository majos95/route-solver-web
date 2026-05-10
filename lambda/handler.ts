// AWS Lambda entry point for the daily challenge auto-solver.
// Triggered by EventBridge at 00:00 UTC; polls until the new challenge appears,
// solves it, and submits. Throws on fatal errors (Lambda retries on throw).

import { solve } from '../src/solver/solve.js'
import { adaptPlanet, adaptRoute, adaptChallenge } from '../src/solver/adapters.js'

const BASE_URL = process.env.VITE_API_BASE_URL
const PLAYER_GUID = process.env.VITE_PLAYER_GUID
const PLAYER_EMAIL = process.env.VITE_PLAYER_EMAIL

const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 5 * 60_000
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 3_000

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

interface SubmissionResult {
  IsSuccess?: boolean
  FeedbackMessage: string
  Coaxium?: number
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

function getAuth() {
  if (!BASE_URL || !PLAYER_GUID || !PLAYER_EMAIL) {
    throw new Error('Missing env vars: VITE_API_BASE_URL, VITE_PLAYER_GUID, VITE_PLAYER_EMAIL')
  }
  return { PlayerGuid: PLAYER_GUID, PlayerEmail: PLAYER_EMAIL }
}

async function apiGet<T>(path: string): Promise<T> {
  const auth = getAuth()
  const res = await fetch(`${BASE_URL}${path}`, { headers: { ...auth } })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`)
  return res.json()
}

async function apiPost<T>(path: string, query: Record<string, unknown>, body: unknown): Promise<T> {
  const auth = getAuth()
  const url = new URL(`${BASE_URL}${path}`)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`)
  return res.json()
}

async function pollUntilChallengesAvailable(): Promise<void> {
  console.log('Polling for new daily challenges...')
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const data = await apiGet<ChallengeOut[]>('/GetActiveLevelDailyChallenge')
    if (Array.isArray(data) && data.length > 0) {
      console.log(`Active challenge(s) found: ${data.map(c => c.ChallengeName).join(', ')}`)
      return
    }
    console.log(`No active challenges yet — retrying in ${POLL_INTERVAL_MS / 1000}s...`)
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('Timed out waiting for new challenges after 5 minutes')
}

async function submitWithRetry(
  challengeId: number,
  challengeName: string,
  route: { PlanetId?: number; Name: string }[],
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`Submitting "${challengeName}" (attempt ${attempt}/${MAX_RETRIES})...`)

    try {
      const result = await apiPost<SubmissionResult>(
        '/SubmitChallengeSolution',
        { ChallengeId: challengeId },
        route,
      )
      console.log(`  → ${result.FeedbackMessage} | Coaxium: ${result.Coaxium}`)
    } catch (err) {
      console.warn(`  → Submission request failed: ${err}`)
    }

    await sleep(1_000)

    const updated = await apiGet<ChallengeOut[]>('/GetDailyChallenge')
    const challenge = updated.find(c => c.ChallengeId === challengeId)
    if (challenge?.IsFinished) {
      console.log(`  → Confirmed finished ✓`)
      return
    }

    if (attempt < MAX_RETRIES) {
      console.warn(`  → Not marked finished, retrying in ${RETRY_DELAY_MS / 1000}s...`)
      await sleep(RETRY_DELAY_MS)
    }
  }

  throw new Error(`"${challengeName}" not confirmed finished after ${MAX_RETRIES} attempts`)
}

export const handler = async (): Promise<void> => {
  // Start fetching map data immediately — it's ready by the time the poll completes.
  const mapDataPromise = apiGet<MapData>('/GetPlanetsAndRoutes')
  await pollUntilChallengesAvailable()

  console.log('Fetching challenges and map data...')
  const [allChallenges, mapData] = await Promise.all([
    apiGet<ChallengeOut[]>('/GetDailyChallenge'),
    mapDataPromise,
  ])

  const planets = (mapData.Planets ?? []).map(adaptPlanet)
  const routes = (mapData.Routes ?? []).map(adaptRoute)

  const sorted = [...allChallenges].sort((a, b) => (a.ChallengeId ?? 0) - (b.ChallengeId ?? 0))
  const pending = sorted.filter(c => !c.IsFinished)

  if (pending.length === 0) {
    console.log('All challenges already finished — nothing to do.')
    return
  }
  console.log(`Pending: ${pending.map(c => c.ChallengeName).join(', ')}`)

  // Solve all up front so submission is as fast as possible
  console.log('Solving all challenges...')
  const solved = pending.map((challenge, i) => {
    if (challenge.ChallengeId === undefined) {
      throw new Error(`Challenge "${challenge.ChallengeName}" has no ChallengeId`)
    }
    const level = `#${challenge.ChallengeId} Level ${i + 1}`
    const t0 = performance.now()
    const input = adaptChallenge(challenge, planets, routes)
    const result = solve(input)
    const ms = (performance.now() - t0).toFixed(0)

    if (!result.success) throw new Error(`Solver failed for "${challenge.ChallengeName}": ${result.errorMessage}`)

    const tag = result.timedOut ? 'TIMED OUT' : 'ok'
    console.log(`  [${level}] "${challenge.ChallengeName}" → effectiveFuel=${result.effectiveFuel} (${ms}ms) [${tag}]`)

    return { challenge, result }
  })

  // Submit sequentially, each gated on IsFinished confirmation
  for (const { challenge, result } of solved) {
    const route = result.orderedRoute.map(p => ({ PlanetId: p.id, Name: p.name }))
    await submitWithRetry(challenge.ChallengeId!, challenge.ChallengeName, route)
  }

  console.log('Done — all challenges submitted successfully.')
}
