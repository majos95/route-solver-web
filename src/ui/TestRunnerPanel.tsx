import { useState, useCallback } from 'react'
import { PLANETS_RAW, ROUTES_RAW } from '../solver/__tests__/realWorld.fixture'
import { adaptPlanet, adaptRoute } from '../solver/adapters'
import type { SolveInput, SolveResult } from '../solver/types'
import { Spinner } from './components/Spinner'

const PLANETS = PLANETS_RAW.map(adaptPlanet)
const ROUTES = ROUTES_RAW.map(adaptRoute)

interface TestCase {
  id: string
  name: string
  input: SolveInput
  expected: number
  precision?: number  // decimal places for toBeCloseTo; undefined = Math.round
}

// IDs match realWorld.test.ts
const M = 90, DT = 104, AL = 2, NB = 58, DN = 44, GZ = 76
const CH = 189, AG = 171, BR = 6, RY = 80

const LR = 30
const FA = 174, UV = 153, KU = 4, EL = 102, KH = 18, TW = 155, VX = 55
const KI = 52, EX = 183, GH = 23, TT = 78
const WY = 100, DR = 47, TI = 43, LN = 30 as number // Loronar=30 reused as start too

const KA = 152, IT = 60, TR = 14, CO = 19, SA = 9
const KR = 187, AT = 191, MU = 86, ZY = 148, ML = 106, CT = 161, BO = 140
const TM = 154, DAN = 104, MAN = 90

const MYTUS = 170, CER = 69, HY = 107, PH = 111
const BE = 28, MG = 184, PM = 101, RO = 81, JA = 146, CN = 56

function tc(id: string, name: string, input: Omit<SolveInput, 'planets' | 'routes'>, expected: number, precision?: number): TestCase {
  return { id, name, input: { ...input, planets: PLANETS, routes: ROUTES }, expected, precision }
}

const TEST_CASES: TestCase[] = [
  tc('T14', 'Light Resistance',            { startPlanetId: M,  mandatoryIds: [DT,AL,NB,DN,GZ], forbiddenIds: [],       bonuses: [] }, 3472),
  tc('T15', 'Heavy Pursuit',               { startPlanetId: M,  mandatoryIds: [DT,AL,NB,DN,GZ], forbiddenIds: [CH,AG],  bonuses: [] }, 3634),
  tc('T16', 'Last Ship Standing',          { startPlanetId: M,  mandatoryIds: [DT,AL,NB,DN,GZ], forbiddenIds: [CH,AG],  bonuses: [{planetId:BR,value:150},{planetId:RY,value:450}] }, 3460),
  tc('T17', 'Coruscant L1',                { startPlanetId: 1,  mandatoryIds: [GZ,WY,DR],        forbiddenIds: [],        bonuses: [] }, 1355, 1),
  tc('T18', 'Coruscant L2',                { startPlanetId: 1,  mandatoryIds: [GZ,WY,DR],        forbiddenIds: [TI],     bonuses: [] }, 1610, 1),
  tc('T19', 'Coruscant L3',                { startPlanetId: 1,  mandatoryIds: [GZ,WY,DR],        forbiddenIds: [TI],     bonuses: [{planetId:LN,value:300}] }, 1592, 1),
  tc('C100', 'LLAP Highway Galore',        { startPlanetId: LR, mandatoryIds: [FA,UV,KU,EL,KH,TW,VX], forbiddenIds: [],   bonuses: [] }, 2818),
  tc('C101', 'LLAP Closed for Renovations',{ startPlanetId: LR, mandatoryIds: [FA,UV,KU,EL,KH,TW,VX], forbiddenIds: [KI,EX,GH,TT], bonuses: [] }, 3005),
  tc('C102', 'LLAP Fuel Edge',             { startPlanetId: LR, mandatoryIds: [FA,UV,KU,EL,KH,TW,VX], forbiddenIds: [KI,EX,GH,TT], bonuses: [{planetId:RY,value:450},{planetId:TM,value:200},{planetId:137,value:100}] }, 2915),
  tc('C103', 'TITW Direct Connection',     { startPlanetId: KA, mandatoryIds: [IT,TR,CO],          forbiddenIds: [],        bonuses: [] }, 1887),
  tc('C104', 'TITW Fury Road',             { startPlanetId: KA, mandatoryIds: [IT,TR,CO],          forbiddenIds: [TI,SA,CH], bonuses: [] }, 1980),
  tc('C105', 'TITW Open Road',             { startPlanetId: KA, mandatoryIds: [IT,TR,CO],          forbiddenIds: [TI,SA,CH], bonuses: [{planetId:KI,value:300},{planetId:TM,value:600},{planetId:KR,value:400},{planetId:AT,value:50},{planetId:MU,value:50},{planetId:ZY,value:400},{planetId:ML,value:400},{planetId:CT,value:400},{planetId:BO,value:200},{planetId:DAN,value:400},{planetId:MAN,value:100}] }, 1554),
  tc('C106', 'TMOS Stars\' End',           { startPlanetId: MYTUS, mandatoryIds: [CER,HY,PH],     forbiddenIds: [],        bonuses: [] }, 4978),
  tc('C107', 'TMOS Corporate Sector',      { startPlanetId: MYTUS, mandatoryIds: [CER,HY,PH],     forbiddenIds: [BE,MG,GZ], bonuses: [] }, 5091),
  tc('C108', 'TMOS Wild Space',            { startPlanetId: MYTUS, mandatoryIds: [CER,HY,PH],     forbiddenIds: [BE,MG,GZ], bonuses: [{planetId:PM,value:300},{planetId:RO,value:150},{planetId:JA,value:100},{planetId:GH,value:250},{planetId:CN,value:100}] }, 4721),
]

type TestStatus = 'idle' | 'running' | 'pass' | 'fail' | 'error'

interface TestResult {
  status: TestStatus
  actual?: number
  elapsed?: number
  error?: string
}

function fmt(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

interface Props {
  onBack: () => void
}

export function TestRunnerPanel({ onBack }: Props) {
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [running, setRunning] = useState(false)
  const [currentId, setCurrentId] = useState<string | null>(null)

  const runAll = useCallback(async () => {
    setRunning(true)
    setResults({})

    for (const tc of TEST_CASES) {
      setCurrentId(tc.id)
      setResults((r) => ({ ...r, [tc.id]: { status: 'running' } }))
      const startMs = Date.now()

      try {
        const result = await new Promise<SolveResult>((resolve, reject) => {
          const w = new Worker(new URL('../solver/solver.worker.ts', import.meta.url), { type: 'module' })
          w.onmessage = (e: MessageEvent<{ ok: boolean; result?: SolveResult; error?: string }>) => {
            w.terminate()
            if (e.data.ok && e.data.result) resolve(e.data.result)
            else reject(new Error(e.data.error ?? 'Solver error'))
          }
          w.onerror = (e) => { w.terminate(); reject(new Error(e.message)) }
          w.postMessage(tc.input)
        })

        const elapsed = Date.now() - startMs
        const actual = tc.precision !== undefined
          ? parseFloat(result.effectiveFuel.toFixed(tc.precision))
          : Math.round(result.effectiveFuel)
        const pass = tc.precision !== undefined
          ? Math.abs(result.effectiveFuel - tc.expected) < Math.pow(10, -tc.precision + 0.5)
          : actual === tc.expected

        setResults((r) => ({ ...r, [tc.id]: { status: pass ? 'pass' : 'fail', actual, elapsed } }))
      } catch (err) {
        setResults((r) => ({ ...r, [tc.id]: { status: 'error', elapsed: Date.now() - startMs, error: String(err) } }))
      }
    }

    setCurrentId(null)
    setRunning(false)
  }, [])

  const passed = Object.values(results).filter((r) => r.status === 'pass').length
  const failed = Object.values(results).filter((r) => r.status === 'fail' || r.status === 'error').length
  const total = Object.keys(results).length

  return (
    <div className="auto-solve-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button className="btn-back" onClick={onBack} disabled={running}>← Back</button>
        <h2 style={{ margin: 0 }}>Test Runner</h2>
        <button className="btn-primary" onClick={runAll} disabled={running}>
          {running ? <><Spinner /> Running…</> : 'Run All'}
        </button>
        {total > 0 && !running && (
          <span style={{ fontSize: 13, color: failed > 0 ? '#ef4444' : '#22c55e' }}>
            {passed}/{total} passed
          </span>
        )}
      </div>

      <div className="auto-solve-entries">
        {TEST_CASES.map((tc) => {
          const r = results[tc.id]
          const isCurrent = currentId === tc.id
          return (
            <div
              key={tc.id}
              className={`auto-solve-entry ${r ? `as-status-${r.status === 'pass' ? 'done' : r.status === 'idle' ? 'queued' : 'failed'}` : ''}`}
            >
              <div className="auto-solve-entry-header">
                <span className="auto-solve-name">
                  <span style={{ opacity: 0.5, marginRight: 6 }}>{tc.id}</span>
                  {tc.name}
                </span>
                <span className="auto-solve-badge">
                  {!r && <span className="as-queued">Idle</span>}
                  {r?.status === 'running' && <><Spinner /> {isCurrent ? 'Running…' : 'Queued'}</>}
                  {r?.status === 'pass' && (
                    <span className="as-done">✓ {r.actual} {r.elapsed !== undefined && fmt(r.elapsed)}</span>
                  )}
                  {r?.status === 'fail' && (
                    <span className="as-failed">✗ got {r.actual}, expected {tc.expected} {r.elapsed !== undefined && fmt(r.elapsed)}</span>
                  )}
                  {r?.status === 'error' && (
                    <span className="as-failed">Error: {r.error}</span>
                  )}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
