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

// Live Long and Porsper challenge IDs
const FARSTINE   = 174
const UVENA      = 153
const KUAT       = 4
const ELROOD     = 102
const KHOMM      = 18
const TAWL       = 155
const VENDAXA    = 55
const KINYEN     = 52
const EXODEEN    = 183
const GHORMAN    = 23
const TATOOINE   = 78
const TERMINUS   = 154
const ASKAJ      = 137

const LLAP_MANDATORIES = [FARSTINE, UVENA, KUAT, ELROOD, KHOMM, TAWL, VENDAXA]
const LLAP_FORBIDDEN   = [KINYEN, EXODEEN, GHORMAN, TATOOINE]

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

// This Is The Way challenge IDs
const KATARR     = 152
const ITHOR      = 60
const TRELLEN    = 14
const CONSTANCIA = 19
const SALLICHE   = 9
const KIRA       = 187
const ATRAVIS    = 191
const MUSTAFAR   = 86
const ZYGERRIA   = 148
const MALACHOR   = 106
const CANTONICA  = 161
const BONADAN    = 140

const TITW_MANDATORIES = [ITHOR, TRELLEN, CONSTANCIA]
const TITW_FORBIDDEN   = [TIRAHNN, SALLICHE, CHARDAAN]

// ── Live Long and Porsper challenges (2026-05-12) ────────────────────────────
// Start: Loronar(30), Mandatory: Farstine(174), Uvena(153), Kuat(4), Elrood(102), Khomm(18), Tawl(155), Vendaxa(55)

// C100: Highway Galore — no forbidden, no bonuses
describe('C100: Live Long and Porsper — Highway Galore', () => {
  it('finds optimal route scoring 2818 CX', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: LORONAR,
      mandatoryIds: LLAP_MANDATORIES,
      forbiddenIds: [],
      bonuses: [],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(Math.round(result.effectiveFuel)).toBe(2818)
  }, 10_000)
})

// C101: Closed for Renovations — Kinyen, Exodeen, Ghorman, Tatooine forbidden
describe('C101: Live Long and Porsper — Closed for Renovations', () => {
  it('finds optimal route scoring 3005 CX', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: LORONAR,
      mandatoryIds: LLAP_MANDATORIES,
      forbiddenIds: LLAP_FORBIDDEN,
      bonuses: [],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(Math.round(result.effectiveFuel)).toBe(3005)
  }, 10_000)
})

// C102: Fuel Edge — forbidden + Ryloth(450), Terminus(200), Askaj(100) bonuses
describe('C102: Live Long and Porsper — Fuel Edge', () => {
  it('finds optimal route scoring 2915 CX', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: LORONAR,
      mandatoryIds: LLAP_MANDATORIES,
      forbiddenIds: LLAP_FORBIDDEN,
      bonuses: [
        { planetId: RYLOTH,   value: 450 },
        { planetId: TERMINUS, value: 200 },
        { planetId: ASKAJ,    value: 100 },
      ],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(Math.round(result.effectiveFuel)).toBe(2915)
  }, 10_000)
})

// ── This Is The Way challenges (2026-05-13) ──────────────────────────────────
// Start: Katarr(152), Mandatory: Ithor(60), Trellen(14), Constancia(19)

// C103: Direct Connection — no forbidden, no bonuses
describe('C103: This Is The Way — Direct Connection', () => {
  it('finds optimal route scoring 1887 CX', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: KATARR,
      mandatoryIds: TITW_MANDATORIES,
      forbiddenIds: [],
      bonuses: [],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(Math.round(result.effectiveFuel)).toBe(1887)
  }, 10_000)
})

// C104: Fury Road — Tirahnn, Salliche, Chardaan forbidden
describe('C104: This Is The Way — Fury Road', () => {
  it('finds optimal route scoring 1980 CX', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: KATARR,
      mandatoryIds: TITW_MANDATORIES,
      forbiddenIds: TITW_FORBIDDEN,
      bonuses: [],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(Math.round(result.effectiveFuel)).toBe(1980)
  }, 10_000)
})

// C105: Open Road — forbidden + 11 bonus planets
describe('C105: This Is The Way — Open Road', () => {
  it('finds optimal route scoring 1554 CX', () => {
    const result = solve({
      planets: PLANETS,
      routes: ROUTES,
      startPlanetId: KATARR,
      mandatoryIds: TITW_MANDATORIES,
      forbiddenIds: TITW_FORBIDDEN,
      bonuses: [
        { planetId: KINYEN,   value: 300 },
        { planetId: TERMINUS, value: 600 },
        { planetId: KIRA,     value: 400 },
        { planetId: ATRAVIS,  value:  50 },
        { planetId: MUSTAFAR, value:  50 },
        { planetId: ZYGERRIA, value: 400 },
        { planetId: MALACHOR, value: 400 },
        { planetId: CANTONICA,value: 400 },
        { planetId: BONADAN,  value: 200 },
        { planetId: DANTOOINE,value: 400 },
        { planetId: MANDALORE,value: 100 },
      ],
    })
    expect(result.success).toBe(true)
    expect(result.timedOut).toBeFalsy()
    expect(Math.round(result.effectiveFuel)).toBe(1554)
  }, 10_000)
})
