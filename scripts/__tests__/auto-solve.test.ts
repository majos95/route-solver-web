import { describe, it, expect } from 'vitest'
import { hasActiveChallenges } from '../auto-solve'

// Case 1 — initial state: new day, all challenges present, none have IsFinished
const INITIAL_STATE = [
  {
    ChallengeId: 103,
    ChallengeName: 'This Is The Way: Direct Connection',
    StartPlanetId: '152',
    MandatoryPlanets: [
      { PlanetId: 60, Name: 'Ithor' },
      { PlanetId: 14, Name: 'Trellen' },
      { PlanetId: 19, Name: 'Constancia' },
    ],
    Level: '1',
  },
  {
    ChallengeId: 104,
    ChallengeName: 'This Is The Way: Fury Road',
    StartPlanetId: '152',
    MandatoryPlanets: [
      { PlanetId: 60, Name: 'Ithor' },
      { PlanetId: 14, Name: 'Trellen' },
      { PlanetId: 19, Name: 'Constancia' },
    ],
    Level: '2',
  },
  {
    ChallengeId: 105,
    ChallengeName: 'This Is The Way: Open Road',
    StartPlanetId: '152',
    MandatoryPlanets: [
      { PlanetId: 60, Name: 'Ithor' },
      { PlanetId: 14, Name: 'Trellen' },
      { PlanetId: 19, Name: 'Constancia' },
    ],
    Level: '3',
  },
]

// Case 2 — partial state: L1 and L2 done, L3 still pending (no IsFinished)
const PARTIAL_STATE = [
  {
    ChallengeId: 103,
    ChallengeName: 'This Is The Way: Direct Connection',
    StartPlanetId: '152',
    MandatoryPlanets: [
      { PlanetId: 60, Name: 'Ithor' },
      { PlanetId: 14, Name: 'Trellen' },
      { PlanetId: 19, Name: 'Constancia' },
    ],
    IsFinished: true,
    Level: '1',
  },
  {
    ChallengeId: 104,
    ChallengeName: 'This Is The Way: Fury Road',
    StartPlanetId: '152',
    MandatoryPlanets: [
      { PlanetId: 60, Name: 'Ithor' },
      { PlanetId: 14, Name: 'Trellen' },
      { PlanetId: 19, Name: 'Constancia' },
    ],
    IsFinished: true,
    Level: '2',
  },
  {
    ChallengeId: 105,
    ChallengeName: 'This Is The Way: Open Road',
    StartPlanetId: '152',
    MandatoryPlanets: [
      { PlanetId: 60, Name: 'Ithor' },
      { PlanetId: 14, Name: 'Trellen' },
      { PlanetId: 19, Name: 'Constancia' },
    ],
    Level: '3',
    // IsFinished intentionally absent — this challenge is available but not yet submitted
  },
]

// Case 3 — all finished: nothing to do, polling should continue
const ALL_FINISHED = PARTIAL_STATE.map((c) => ({ ...c, IsFinished: true as const }))

describe('hasActiveChallenges', () => {
  it('returns true for initial state (no IsFinished on any challenge)', () => {
    expect(hasActiveChallenges(INITIAL_STATE)).toBe(true)
  })

  it('returns true for partial state (L1+L2 done, L3 still pending)', () => {
    expect(hasActiveChallenges(PARTIAL_STATE)).toBe(true)
  })

  it('returns false when all challenges are finished — polling should keep waiting', () => {
    expect(hasActiveChallenges(ALL_FINISHED)).toBe(false)
  })

  it('returns false for an empty array — polling should keep waiting', () => {
    expect(hasActiveChallenges([])).toBe(false)
  })
})
