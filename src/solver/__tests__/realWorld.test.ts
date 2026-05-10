import { describe, it, expect } from 'vitest'
import { adaptPlanet, adaptRoute } from '../adapters'
import { solve } from '../solve'
import { PLANETS_RAW, ROUTES_RAW } from './realWorld.fixture'

const PLANETS = PLANETS_RAW.map(adaptPlanet)
const ROUTES = ROUTES_RAW.map(adaptRoute)

// Challenge IDs from actual game data
const MANDALORE  = 90
const DANTOOINE  = 104
const ALDERAAN   = 2
const NABOO      = 58
const DENON      = 44
const GIZER      = 76
const CHARDAAN   = 189
const AGAMAR     = 171
const BRENTAAL   = 6
const RYLOTH     = 80

// Coruscant challenge IDs
const CORUSCANT  = 1
const WAYLAND    = 100
const DORIN      = 47
const TIRAHNN    = 43
const LORONAR    = 30

const BASE_MANDATORIES = [DANTOOINE, ALDERAAN, NABOO, DENON, GIZER]

// T14: Light Resistance — no forbidden, no bonuses
describe('T14: Light Resistance', () => {
  it('finds optimal route scoring 3472 CX', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: MANDALORE,
      mandatoryIds: BASE_MANDATORIES,
      forbiddenIds: [],
      bonuses: [],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(Math.round(result.effectiveFuel)).toBe(3472)
  }, 10_000)
})

// T15: Heavy Pursuit — Chardaan + Agamar forbidden
describe('T15: Heavy Pursuit', () => {
  it('finds optimal route scoring 3634 CX', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: MANDALORE,
      mandatoryIds: BASE_MANDATORIES,
      forbiddenIds: [CHARDAAN, AGAMAR],
      bonuses: [],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(Math.round(result.effectiveFuel)).toBe(3634)
  }, 10_000)
})

// T16: Last Ship Standing — forbidden + Brentaal(150) + Ryloth(450) bonuses
describe('T16: Last Ship Standing', () => {
  it('finds optimal route scoring 3460 CX', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: MANDALORE,
      mandatoryIds: BASE_MANDATORIES,
      forbiddenIds: [CHARDAAN, AGAMAR],
      bonuses: [
        { planetId: BRENTAAL, value: 150 },
        { planetId: RYLOTH,   value: 450 },
      ],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(Math.round(result.effectiveFuel)).toBe(3460)
  }, 10_000)
})

// ── Coruscant challenges (verified against leaderboard) ──────────────────────
// Start: Coruscant(1), Mandatory: Gizer(76), Wayland(100), Dorin(47)

// T17: no forbidden, no bonus
describe('T17: Coruscant Level 1', () => {
  it('finds optimal route with effective fuel 1355.07', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: CORUSCANT,
      mandatoryIds: [GIZER, WAYLAND, DORIN],
      forbiddenIds: [],
      bonuses: [],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(result.effectiveFuel).toBeCloseTo(1355.07, 1)
  }, 10_000)
})

// T18: Tirahnn forbidden
describe('T18: Coruscant Level 2', () => {
  it('finds optimal route with effective fuel 1610.31', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: CORUSCANT,
      mandatoryIds: [GIZER, WAYLAND, DORIN],
      forbiddenIds: [TIRAHNN],
      bonuses: [],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(result.effectiveFuel).toBeCloseTo(1610.31, 1)
  }, 10_000)
})

// T19: Tirahnn forbidden + Loronar(30) bonus worth 300
describe('T19: Coruscant Level 3', () => {
  it('finds optimal route with effective fuel 1592.21 (gross 1892.21 − 300 bonus)', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: CORUSCANT,
      mandatoryIds: [GIZER, WAYLAND, DORIN],
      forbiddenIds: [TIRAHNN],
      bonuses: [{ planetId: LORONAR, value: 300 }],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(result.collectedBonus).toBe(300)
    expect(result.grossFuel).toBeCloseTo(1892.21, 1)
    expect(result.effectiveFuel).toBeCloseTo(1592.21, 1)
  }, 10_000)
})
