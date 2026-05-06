import { useState } from 'react'
import type { SolveResult, SolveInput } from '../solver/types'
import type { OracleResult } from '../api/client'
import { calculateCoaxium, submitChallengeSolution } from '../api/client'
import { RawJson } from './components/RawJson'
import { Spinner } from './components/Spinner'

interface Props {
  result: SolveResult
  solveInput: SolveInput
  challengeId: number
  challengeName: string
  onBack: () => void
}

export function SolutionView({ result, solveInput, challengeId, challengeName, onBack }: Props) {
  const [oracle, setOracle] = useState<OracleResult | null>(null)
  const [oracleLoading, setOracleLoading] = useState(false)
  const [oracleError, setOracleError] = useState<string | null>(null)

  const [confirmingSubmit, setConfirmingSubmit] = useState(false)
  const [submitResult, setSubmitResult] = useState<OracleResult | null>(null)
  const [submitLoading, setSubmitLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const handleCalculate = async () => {
    setOracleLoading(true)
    setOracleError(null)
    const res = await calculateCoaxium(challengeId, result.orderedRoute)
    setOracleLoading(false)
    if (!res) { setOracleError('Oracle call failed — check console'); return }
    setOracle(res)
  }

  const handleSubmit = async () => {
    setSubmitLoading(true)
    setSubmitError(null)
    const res = await submitChallengeSolution(challengeId, result.orderedRoute)
    setSubmitLoading(false)
    if (!res) { setSubmitError('Submit call failed — check console'); return }
    setSubmitResult(res)
    setConfirmingSubmit(false)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(result.orderedRoute.map((p) => p.id).join(','))
  }

  const oracleMismatch =
    oracle?.IsSuccess === true &&
    Math.abs(result.effectiveFuel - (oracle.Coaxium ?? 0)) > 1

  const solveInputSummary = {
    startPlanetId: solveInput.startPlanetId,
    mandatoryIds: solveInput.mandatoryIds,
    forbiddenIds: solveInput.forbiddenIds,
    bonuses: solveInput.bonuses,
    planetCount: solveInput.planets.length,
    routeCount: solveInput.routes.length,
  }

  return (
    <div className="solution-view">
      <button className="btn-back" onClick={onBack}>← Back</button>
      <h2>{challengeName}</h2>

      {!result.success && (
        <div className="banner banner-error">Solver error: {result.errorMessage}</div>
      )}

      {result.success && (
        <>
          <div className="fuel-summary">
            <div className="fuel-row">
              <span className="fuel-label">Solver fuel</span>
              <span className="fuel-value">{Math.round(result.effectiveFuel)}</span>
            </div>
            {oracle?.IsSuccess === true && (
              <div className="fuel-row">
                <span className="fuel-label">Oracle fuel</span>
                <span className="fuel-value oracle">{oracle.Coaxium}</span>
              </div>
            )}
            <div className="fuel-breakdown">
              Gross: {Math.round(result.grossFuel)} · Bonus: {result.collectedBonus}
            </div>
          </div>

          <div className="route-chips">
            {result.orderedRoute.map((p, i) => (
              <span key={`${p.id}-${i}`} className="planet-chip">{p.name}</span>
            ))}
          </div>

          <button className="btn-primary" onClick={handleCopy}>Copy IDs</button>

          {/* Oracle section */}
          {!oracle && (
            <div className="oracle-bar">
              <button className="btn-primary" onClick={handleCalculate} disabled={oracleLoading}>
                {oracleLoading ? <><Spinner /> Calculating…</> : 'Calculate Coaxium'}
              </button>
              {oracleError && <span className="oracle-error">{oracleError}</span>}
            </div>
          )}

          {oracle && (
            <>
              {oracle.IsSuccess === false && (
                <div className="banner banner-error">
                  <strong>Oracle rejected route</strong>{oracle.FeedbackMessage ? ` — "${oracle.FeedbackMessage}"` : ''}
                </div>
              )}
              {oracle.IsSuccess === true && oracleMismatch && (
                <div className="banner banner-warn">
                  <strong>Mismatch</strong> — Solver: {Math.round(result.effectiveFuel)} · Oracle: {oracle.Coaxium}
                </div>
              )}
              {oracle.IsSuccess === true && !oracleMismatch && (
                <div className="banner banner-ok">Oracle verified ✓ — {oracle.Coaxium} coaxium</div>
              )}
            </>
          )}

          {oracle?.IsSuccess === true && !oracleMismatch && (
            <div className="oracle-bar">
              {!confirmingSubmit ? (
                <button className="btn-primary" onClick={() => setConfirmingSubmit(true)} disabled={submitLoading}>
                  Submit solution
                </button>
              ) : (
                <>
                  <button className="btn-primary" onClick={handleSubmit} disabled={submitLoading}>
                    {submitLoading ? <><Spinner /> Submitting…</> : 'Confirm submit'}
                  </button>
                  <button className="btn-back" onClick={() => setConfirmingSubmit(false)} disabled={submitLoading}>
                    Cancel
                  </button>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>This will persist your result</span>
                </>
              )}
              {submitError && <span className="oracle-error">{submitError}</span>}
            </div>
          )}

          {submitResult && (
            <>
              {submitResult.IsSuccess === false && (
                <div className="banner banner-error">
                  <strong>Submission rejected</strong>{submitResult.FeedbackMessage ? ` — "${submitResult.FeedbackMessage}"` : ''}
                </div>
              )}
              {submitResult.IsSuccess === true && (
                <div className="banner banner-ok">
                  Submitted ✓ — {submitResult.Coaxium} coaxium{submitResult.FeedbackMessage ? ` · ${submitResult.FeedbackMessage}` : ''}
                </div>
              )}
            </>
          )}
        </>
      )}

      <div className="raw-section">
        <RawJson label="Solve input (constraints)" data={solveInputSummary} defaultOpen />
        <RawJson label="Solver output" data={result} defaultOpen />
        {oracle && <RawJson label="POST /CalculateCoaxium response" data={oracle} defaultOpen />}
        {submitResult && <RawJson label="POST /SubmitChallengeSolution response" data={submitResult} defaultOpen />}
      </div>
    </div>
  )
}
