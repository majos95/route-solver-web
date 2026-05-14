import { useState, useEffect, useRef } from 'react'
import type { ChallengeOut } from '../state/useChallenges'
import type { Planet, Route, SolveResult, SolveInput } from '../solver/types'
import { adaptChallenge } from '../solver/adapters'
import { submitChallengeSolution } from '../api/client'
import type { OracleResult } from '../api/client'
import { Spinner } from './components/Spinner'

interface EntryStatus {
  result: SolveResult | null
  status: 'queued' | 'solving' | 'done' | 'failed'
  elapsed: number
  submitStatus: 'idle' | 'submitting' | 'done' | 'failed'
  submitResult: OracleResult | null
}

interface Props {
  challenges: ChallengeOut[]
  planets: Planet[]
  routes: Route[]
  dryRun?: boolean
  onBack: () => void
}

function fmt(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function AutoSolvePanel({ challenges, planets, routes, dryRun = false, onBack }: Props) {
  const itemsRef = useRef<{ challenge: ChallengeOut; solveInput: SolveInput }[]>([])
  if (itemsRef.current.length === 0) {
    itemsRef.current = challenges
      .filter((c) => c.ChallengeId !== undefined && (dryRun || !c.IsFinished))
      .sort((a, b) => (a.ChallengeId ?? 0) - (b.ChallengeId ?? 0))
      .map((c) => ({ challenge: c, solveInput: adaptChallenge(c, planets, routes) }))
  }

  const [statuses, setStatuses] = useState<EntryStatus[]>(() =>
    itemsRef.current.map(() => ({
      result: null,
      status: 'queued' as const,
      elapsed: 0,
      submitStatus: 'idle' as const,
      submitResult: null,
    })),
  )
  const [currentIdx, setCurrentIdx] = useState(0)
  const [submitConfirm, setSubmitConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startMsRef = useRef(0)

  useEffect(() => {
    const items = itemsRef.current
    if (currentIdx >= items.length) return

    setStatuses((prev) => prev.map((s, i) => (i === currentIdx ? { ...s, status: 'solving' } : s)))
    startMsRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setStatuses((prev) =>
        prev.map((s, i) => (i === currentIdx ? { ...s, elapsed: Date.now() - startMsRef.current } : s)),
      )
    }, 250)

    const worker = new Worker(new URL('../solver/solver.worker.ts', import.meta.url), { type: 'module' })

    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: SolveResult; error?: string }>) => {
      clearInterval(timerRef.current!); timerRef.current = null
      setStatuses((prev) =>
        prev.map((s, i) =>
          i === currentIdx
            ? { ...s, status: e.data.ok ? 'done' : 'failed', result: e.data.result ?? null, elapsed: Date.now() - startMsRef.current }
            : s,
        ),
      )
      setCurrentIdx((idx) => idx + 1)
    }

    worker.onerror = () => {
      clearInterval(timerRef.current!); timerRef.current = null
      setStatuses((prev) =>
        prev.map((s, i) => (i === currentIdx ? { ...s, status: 'failed', elapsed: Date.now() - startMsRef.current } : s)),
      )
      setCurrentIdx((idx) => idx + 1)
    }

    worker.postMessage(items[currentIdx].solveInput)

    return () => {
      worker.terminate()
      clearInterval(timerRef.current!); timerRef.current = null
    }
  }, [currentIdx])

  const allDone = itemsRef.current.length > 0 && currentIdx >= itemsRef.current.length
  const anySuccess = statuses.some((s) => s.status === 'done' && s.result?.success)
  const allSubmitted = statuses.length > 0 && statuses.every((s) => s.submitStatus !== 'idle')

  const handleSubmitAll = async () => {
    setSubmitting(true)
    setSubmitConfirm(false)
    const items = itemsRef.current
    const snap = statuses
    for (let i = 0; i < items.length; i++) {
      const s = snap[i]
      if (s.status !== 'done' || !s.result?.success || !items[i].challenge.ChallengeId) continue
      setStatuses((prev) => prev.map((st, idx) => (idx === i ? { ...st, submitStatus: 'submitting' } : st)))
      const res = await submitChallengeSolution(items[i].challenge.ChallengeId!, s.result!.orderedRoute)
      setStatuses((prev) =>
        prev.map((st, idx) =>
          idx === i ? { ...st, submitStatus: res?.IsSuccess ? 'done' : 'failed', submitResult: res } : st,
        ),
      )
      if (!res?.IsSuccess) break
    }
    setSubmitting(false)
  }

  return (
    <div className="auto-solve-panel">
      <button className="btn-back" onClick={onBack}>← Back</button>
      <h2>Auto-Solve All</h2>

      {itemsRef.current.length === 0 && (
        <p className="empty-state">No pending challenges — all done!</p>
      )}

      <div className="auto-solve-entries">
        {itemsRef.current.map(({ challenge }, i) => {
          const s = statuses[i]
          return (
            <div key={challenge.ChallengeId} className={`auto-solve-entry as-status-${s.status}`}>
              <div className="auto-solve-entry-header">
                <span className="auto-solve-name">{challenge.ChallengeName}</span>
                <span className="auto-solve-badge">
                  {s.status === 'queued' && <span className="as-queued">Queued</span>}
                  {s.status === 'solving' && <><Spinner /> {fmt(s.elapsed)}</>}
                  {s.status === 'done' && (
                    <span className="as-done">{fmt(s.elapsed)}{s.result?.timedOut ? ' ⚠ timeout' : ''}</span>
                  )}
                  {s.status === 'failed' && <span className="as-failed">Failed</span>}
                </span>
              </div>

              {s.status === 'done' && s.result?.success && (
                <div className="auto-solve-result">
                  <span className="as-fuel">
                    effectiveFuel <strong>{Math.round(s.result.effectiveFuel)}</strong>
                    <span className="as-detail"> · gross {Math.round(s.result.grossFuel)} · bonus {s.result.collectedBonus}</span>
                  </span>
                  <div className="route-chips">
                    {s.result.orderedRoute.map((p, idx) => (
                      <span key={`${p.id}-${idx}`} className="planet-chip">{p.name}</span>
                    ))}
                  </div>
                </div>
              )}

              {s.status === 'failed' && (
                <p className="as-error">{s.result?.errorMessage ?? 'Solver error'}</p>
              )}

              {s.submitStatus !== 'idle' && (
                <div className={`as-submit-status as-submit-${s.submitStatus}`}>
                  {s.submitStatus === 'submitting' && <><Spinner /> Submitting…</>}
                  {s.submitStatus === 'done' && `✓ Submitted — ${s.submitResult?.Coaxium} coaxium${s.submitResult?.FeedbackMessage ? ' · ' + s.submitResult.FeedbackMessage : ''}`}
                  {s.submitStatus === 'failed' && `✗ Failed — ${s.submitResult?.FeedbackMessage ?? 'unknown error'}`}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {allDone && anySuccess && !allSubmitted && !dryRun && (
        <div className="auto-solve-actions">
          {!submitConfirm ? (
            <button className="btn-primary" onClick={() => setSubmitConfirm(true)} disabled={submitting}>
              Submit All
            </button>
          ) : (
            <>
              <button className="btn-primary" onClick={handleSubmitAll} disabled={submitting}>
                {submitting ? <><Spinner /> Submitting…</> : 'Confirm Submit All'}
              </button>
              <button className="btn-back" onClick={() => setSubmitConfirm(false)}>Cancel</button>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>This will persist all results</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
