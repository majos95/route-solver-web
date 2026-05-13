#!/usr/bin/env node
/// <reference types="node" />
// Run with: npx tsx scripts/auto-solve.ts

import { solve } from '../src/solver/solve.ts'
import { adaptPlanet, adaptRoute, adaptChallenge } from '../src/solver/adapters.ts'

const BASE_URL = process.env.VITE_API_BASE_URL
const PLAYER_GUID = process.env.VITE_PLAYER_GUID
const PLAYER_EMAIL = process.env.VITE_PLAYER_EMAIL

if (!BASE_URL || !PLAYER_GUID || !PLAYER_EMAIL) {
  console.error('Missing env vars: VITE_API_BASE_URL, VITE_PLAYER_GUID, VITE_PLAYER_EMAIL')
  process.exit(1)
}

const AUTH = { PlayerGuid: PLAYER_GUID, PlayerEmail: PLAYER_EMAIL }

const DRY_RUN = process.env.DRY_RUN === 'true'

const POLL_INTERVAL_MS = 200
const POLL_TIMEOUT_MS = 10 * 60_000

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
  return new Promise((r) => setTimeout(r, ms))
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { ...AUTH } })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`)
  return res.json()
}

async function apiPost<T>(path: string, query: Record<string, unknown>, body: unknown): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`)
  return res.json()
}

// Returns true when the API response contains at least one challenge that hasn't been
// completed yet. Missing IsFinished (new challenges) counts as pending.
export function hasActiveChallenges(data: ChallengeOut[]): boolean {
  return Array.isArray(data) && data.some((c) => !c.IsFinished)
}

// Poll /GetDailyChallenge (same endpoint as the solver) until at least one challenge is
// pending. Returns the full challenge list so the caller doesn't need a second fetch.
async function pollUntilChallengesAvailable(): Promise<ChallengeOut[]> {
  console.log('Polling for new daily challenges...')
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const data = await apiGet<ChallengeOut[]>('/GetDailyChallenge')
    if (hasActiveChallenges(data)) {
      console.log(`Challenges found: ${data.filter((c) => !c.IsFinished).map((c) => c.ChallengeName).join(', ')}`)
      return data
    }
    console.log(`No active challenges yet — retrying in ${POLL_INTERVAL_MS / 1000}s...`)
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('Timed out waiting for new challenges after 10 minutes')
}

async function submit(
  challengeId: number,
  challengeName: string,
  route: { PlanetId?: number; Name: string }[],
): Promise<void> {
  console.log(`Submitting "${challengeName}"...`)
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
}

async function main() {
  // Kick off map fetch immediately — it's ready before the poll completes
  const mapDataPromise = apiGet<MapData>('/GetPlanetsAndRoutes')

  const polledChallenges = DRY_RUN ? null : await pollUntilChallengesAvailable()

  console.log('Fetching challenges and map data...')
  const [allChallenges, mapData] = await Promise.all([
    polledChallenges ?? apiGet<ChallengeOut[]>('/GetDailyChallenge'),
    mapDataPromise,
  ])

  const planets = (mapData.Planets ?? []).map(adaptPlanet)
  const routes = (mapData.Routes ?? []).map(adaptRoute)

  // Sort by ChallengeId ascending to guarantee Level1 → Level2 → Level3 order
  const sorted = [...allChallenges].sort((a, b) => (a.ChallengeId ?? 0) - (b.ChallengeId ?? 0))
  const pending = DRY_RUN ? sorted : sorted.filter((c) => !c.IsFinished)
  if (pending.length === 0) {
    console.log('All challenges already finished — nothing to do.')
    return
  }
  console.log(`Pending: ${pending.map((c) => c.ChallengeName).join(', ')}`)

  // Process each challenge in ID order: solve → submit immediately
  for (const [i, challenge] of pending.entries()) {
    if (challenge.ChallengeId === undefined) {
      throw new Error(`Challenge "${challenge.ChallengeName}" has no ChallengeId — cannot submit`)
    }
    const level = `#${challenge.ChallengeId} Level ${i + 1}`

    console.log(`\nSolving [${level}] "${challenge.ChallengeName}"...`)
    const t0 = performance.now()
    const input = adaptChallenge(challenge, planets, routes)
    const result = solve(input)
    const ms = (performance.now() - t0).toFixed(0)

    if (!result.success) {
      throw new Error(`Solver failed for "${challenge.ChallengeName}": ${result.errorMessage}`)
    }
    if (result.timedOut) {
      console.warn(`  → TIMED OUT — submitting best-so-far: effectiveFuel=${result.effectiveFuel} (${ms}ms)`)
    } else {
      console.log(`  → effectiveFuel=${result.effectiveFuel} (${ms}ms)`)
    }

    const route = result.orderedRoute.map((p) => ({ PlanetId: p.id, Name: p.name }))

    if (DRY_RUN) {
      console.log(`  Gross fuel     : ${result.grossFuel}`)
      console.log(`  Bonus collected: ${result.collectedBonus}`)
      console.log(`  Route (${result.orderedRoute.length} planets): ${result.orderedRoute.map((p) => p.name).join(' → ')}`)
    }

    await submit(challenge.ChallengeId, challenge.ChallengeName, route)
  }

  console.log('\nDone — all challenges submitted.')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
