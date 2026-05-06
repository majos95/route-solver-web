import { useState, useCallback, useRef, useEffect } from 'react'
import { useGameMap } from './state/useGameMap'
import { useChallenges } from './state/useChallenges'
import type { ChallengeOut } from './state/useChallenges'
import { ChallengeList } from './ui/ChallengeList'
import { SolutionView } from './ui/SolutionView'
import { Spinner } from './ui/components/Spinner'
import { RawJson } from './ui/components/RawJson'
import { adaptChallenge } from './solver/adapters'
import type { SolveResult, SolveInput } from './solver/types'
import './App.css'

const REQUIRED_VARS = ['VITE_PLAYER_GUID', 'VITE_PLAYER_EMAIL', 'VITE_API_BASE_URL'] as const
const missing = REQUIRED_VARS.filter((k) => !import.meta.env[k])

export default function App() {
  if (missing.length > 0) {
    return (
      <div className="setup-error">
        <h1>Setup required</h1>
        <p>Create <code>.env.local</code> in <code>route-solver-web/</code> with:</p>
        <ul>{missing.map((k) => <li key={k}><code>{k}</code></li>)}</ul>
        <p>See <code>.env.example</code> for the template.</p>
      </div>
    )
  }
  return <AppInner />
}

interface SolutionState {
  result: SolveResult
  solveInput: SolveInput
  challengeId: number
  challengeName: string
}

function fmt(ms: number) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function AppInner() {
  const [solvingId, setSolvingId] = useState<number | null>(null)
  const [solution, setSolution] = useState<SolutionState | null>(null)
  const [solveError, setSolveError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  const workerRef = useRef<Worker | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }

  useEffect(() => () => { workerRef.current?.terminate(); stopTimer() }, [])

  const { data: gameMap, rawData: rawGameMap, loading: mapLoading, error: mapError, retry: retryMap } = useGameMap()
  const { data: challenges, rawAll, rawActive, loading: challengesLoading, error: challengesError, retry: retryChallenges } = useChallenges()

  const handleSolve = useCallback((challenge: ChallengeOut) => {
    if (!gameMap || !challenge.ChallengeId) return

    workerRef.current?.terminate()
    stopTimer()

    setSolvingId(challenge.ChallengeId)
    setSolveError(null)
    setElapsedMs(0)

    const solveInput = adaptChallenge(challenge, gameMap.planets, gameMap.routes)
    const startMs = Date.now()
    timerRef.current = setInterval(() => setElapsedMs(Date.now() - startMs), 250)

    const worker = new Worker(new URL('./solver/solver.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: SolveResult; error?: string }>) => {
      stopTimer()
      workerRef.current = null
      if (e.data.ok && e.data.result) {
        setSolution({ result: e.data.result, solveInput, challengeId: challenge.ChallengeId!, challengeName: challenge.ChallengeName ?? 'Challenge' })
      } else {
        setSolveError(e.data.error ?? 'Unknown solver error')
      }
      setSolvingId(null)
    }

    worker.onerror = (e) => {
      stopTimer()
      workerRef.current = null
      setSolveError(e.message)
      setSolvingId(null)
    }

    worker.postMessage(solveInput)
  }, [gameMap])

  const handleCancel = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = null
    stopTimer()
    setSolvingId(null)
    setSolveError('Cancelled after ' + fmt(elapsedMs))
  }, [elapsedMs])

  if (solution) {
    return (
      <div className="app">
        <SolutionView
          result={solution.result}
          solveInput={solution.solveInput}
          challengeId={solution.challengeId}
          challengeName={solution.challengeName}
          onBack={() => setSolution(null)}
        />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>RouteSolver</h1>
        {gameMap && (
          <span className="map-info">{gameMap.planets.length} planets · {gameMap.routes.length} routes</span>
        )}
      </header>

      {mapLoading && <div className="status-row"><Spinner /> Loading game map…</div>}
      {mapError && (
        <div className="banner banner-error">{mapError} <button onClick={retryMap}>Retry</button></div>
      )}
      {rawGameMap && <RawJson label="GET /GetPlanetsAndRoutes" data={rawGameMap} />}

      {!mapLoading && !mapError && gameMap && (
        <>
          {challengesLoading && <div className="status-row"><Spinner /> Loading challenges…</div>}
          {challengesError && (
            <div className="banner banner-error">{challengesError} <button onClick={retryChallenges}>Retry</button></div>
          )}
          {rawActive !== undefined && <RawJson label="GET /GetActiveLevelDailyChallenge" data={rawActive} />}
          {rawAll && <RawJson label="GET /GetDailyChallenge" data={rawAll} />}

          {solvingId !== null && (
            <div className="status-row">
              <Spinner /> Solving… {fmt(elapsedMs)}
              <button className="btn-back" style={{ marginLeft: 8 }} onClick={handleCancel}>Cancel</button>
            </div>
          )}
          {solveError && (
            <div className="banner banner-error">Solver: {solveError}</div>
          )}

          {challenges && (
            <ChallengeList
              challenges={challenges}
              onSolve={handleSolve}
              solvingId={solvingId}
            />
          )}
        </>
      )}
    </div>
  )
}
