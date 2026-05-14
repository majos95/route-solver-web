import { useState, useEffect, useRef, useCallback } from 'react'
import { getDailyChallenge, getPlanetsAndRoutes, submitChallengeSolution } from '../api/client'
import type { OracleResult } from '../api/client'
import { adaptPlanet, adaptRoute, adaptChallenge } from '../solver/adapters'
import type { SolveResult } from '../solver/types'
import type { ChallengeOut } from '../state/useChallenges'
import { Spinner } from './components/Spinner'

const POLL_MS = 200

function fmt(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

type Phase =
  | { type: 'polling'; attempts: number }
  | { type: 'solving'; name: string; idx: number; total: number; elapsed: number }
  | { type: 'submitting'; name: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

interface EntryResult {
  name: string
  fuel: number
  gross: number
  bonus: number
  route: string[]
  elapsed: number
  timedOut: boolean
  submitResult: OracleResult | null
  submitOk: boolean | null
}

interface Props {
  dryRun?: boolean
  onBack: () => void
}

export function PollingSolvePanel({ dryRun = false, onBack }: Props) {
  const killedRef = useRef(false)
  const workerRef = useRef<Worker | null>(null)
  const [phase, setPhase] = useState<Phase>({ type: 'polling', attempts: 0 })
  const [entries, setEntries] = useState<EntryResult[]>([])

  const handleKill = useCallback(() => {
    killedRef.current = true
    workerRef.current?.terminate()
    workerRef.current = null
    onBack()
  }, [onBack])

  useEffect(() => {
    killedRef.current = false

    async function run() {
      // Kick off map fetch immediately — it's ready before polling ends
      const mapPromise = getPlanetsAndRoutes()

      // Phase 1: poll until at least one unfinished challenge appears
      let pending: ChallengeOut[] = []
      let attempts = 0
      while (!killedRef.current) {
        attempts++
        setPhase({ type: 'polling', attempts })
        const { data } = await getDailyChallenge()
        const all = (data ?? []) as ChallengeOut[]
        const unfinished = all.filter((c) => !c.IsFinished && c.ChallengeId !== undefined)
        if (unfinished.length > 0) {
          pending = unfinished.sort((a, b) => (a.ChallengeId ?? 0) - (b.ChallengeId ?? 0))
          break
        }
        await new Promise((r) => setTimeout(r, POLL_MS))
      }
      if (killedRef.current) return

      const { data: mapData } = await mapPromise
      if (killedRef.current || !mapData) return

      const planets = ((mapData as { Planets?: unknown[] }).Planets ?? []).map(adaptPlanet as (p: unknown) => ReturnType<typeof adaptPlanet>)
      const routes = ((mapData as { Routes?: unknown[] }).Routes ?? []).map(adaptRoute as (r: unknown) => ReturnType<typeof adaptRoute>)

      // Phase 2: solve + optionally submit each challenge
      for (let i = 0; i < pending.length; i++) {
        if (killedRef.current) break
        const c = pending[i]
        const solveInput = adaptChallenge(c, planets, routes)
        const startMs = Date.now()

        setPhase({ type: 'solving', name: c.ChallengeName ?? '', idx: i, total: pending.length, elapsed: 0 })

        const timer = setInterval(
          () => setPhase((p) => p.type === 'solving' ? { ...p, elapsed: Date.now() - startMs } : p),
          250,
        )

        let result: SolveResult
        try {
          result = await new Promise<SolveResult>((resolve, reject) => {
            const w = new Worker(new URL('../solver/solver.worker.ts', import.meta.url), { type: 'module' })
            workerRef.current = w
            w.onmessage = (e: MessageEvent<{ ok: boolean; result?: SolveResult; error?: string }>) => {
              workerRef.current = null
              if (e.data.ok && e.data.result) resolve(e.data.result)
              else reject(new Error(e.data.error ?? 'Solver error'))
            }
            w.onerror = (e) => { workerRef.current = null; reject(new Error(e.message)) }
            w.postMessage(solveInput)
          })
        } catch (err) {
          clearInterval(timer)
          setPhase({ type: 'error', message: String(err) })
          return
        }

        clearInterval(timer)
        if (killedRef.current) break

        const elapsed = Date.now() - startMs
        let submitResult: OracleResult | null = null
        let submitOk: boolean | null = null

        if (!dryRun && c.ChallengeId) {
          setPhase({ type: 'submitting', name: c.ChallengeName ?? '' })
          submitResult = await submitChallengeSolution(c.ChallengeId, result.orderedRoute)
          submitOk = submitResult?.IsSuccess ?? false
        }

        if (killedRef.current) break

        setEntries((prev) => [
          ...prev,
          {
            name: c.ChallengeName ?? '',
            fuel: Math.round(result.effectiveFuel),
            gross: Math.round(result.grossFuel),
            bonus: result.collectedBonus,
            route: result.orderedRoute.map((p) => p.name),
            elapsed,
            timedOut: result.timedOut ?? false,
            submitResult,
            submitOk,
          },
        ])
      }

      if (!killedRef.current) setPhase({ type: 'done' })
    }

    run().catch((err) => {
      if (!killedRef.current) setPhase({ type: 'error', message: String(err) })
    })

    return () => {
      killedRef.current = true
      workerRef.current?.terminate()
    }
  }, [dryRun])

  return (
    <div className="auto-solve-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button className="btn-back" onClick={handleKill}>Kill</button>
        <h2 style={{ margin: 0 }}>{dryRun ? 'Dry Run' : 'Auto-Solve'}</h2>
      </div>

      {phase.type === 'polling' && (
        <div className="status-row">
          <Spinner /> Polling for new challenges… (attempt {phase.attempts})
        </div>
      )}
      {phase.type === 'solving' && (
        <div className="status-row">
          <Spinner /> Solving {phase.idx + 1}/{phase.total}: {phase.name} ({fmt(phase.elapsed)})
        </div>
      )}
      {phase.type === 'submitting' && (
        <div className="status-row">
          <Spinner /> Submitting {phase.name}…
        </div>
      )}
      {phase.type === 'error' && (
        <div className="banner banner-error">{phase.message}</div>
      )}
      {phase.type === 'done' && (
        <div className="banner" style={{ background: '#166534', color: '#dcfce7' }}>
          All done!
        </div>
      )}

      <div className="auto-solve-entries">
        {entries.map((e, i) => (
          <div key={i} className="auto-solve-entry as-status-done">
            <div className="auto-solve-entry-header">
              <span className="auto-solve-name">{e.name}</span>
              <span className="auto-solve-badge as-done">
                {fmt(e.elapsed)}{e.timedOut ? ' ⚠ timeout' : ''}
              </span>
            </div>
            <div className="auto-solve-result">
              <span className="as-fuel">
                effectiveFuel <strong>{e.fuel}</strong>
                <span className="as-detail"> · gross {e.gross} · bonus {e.bonus}</span>
              </span>
              {e.submitOk !== null && (
                <div className={`as-submit-status ${e.submitOk ? 'as-submit-done' : 'as-submit-failed'}`}>
                  {e.submitOk
                    ? `✓ ${e.submitResult?.Coaxium} coaxium${e.submitResult?.FeedbackMessage ? ' · ' + e.submitResult.FeedbackMessage : ''}`
                    : `✗ ${e.submitResult?.FeedbackMessage ?? 'Submit failed'}`}
                </div>
              )}
              <div className="route-chips">
                {e.route.map((name, idx) => (
                  <span key={idx} className="planet-chip">{name}</span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
