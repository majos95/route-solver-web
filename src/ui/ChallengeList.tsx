import type { ChallengeOut } from '../state/useChallenges'
import type { components } from '../api/schema'
import { Spinner } from './components/Spinner'

type PlaneMapSimple = components['schemas']['PlaneMapSimple']

interface Props {
  challenges: ChallengeOut[]
  onSolve: (challenge: ChallengeOut) => void
  solvingId: number | null
}

function PlanetList({ planets, label, colorClass }: { planets: PlaneMapSimple[] | undefined, label: string, colorClass: string }) {
  if (!planets?.length) return null
  return (
    <div className="planet-group">
      <span className="planet-group-label">{label}</span>
      <div className="planet-group-chips">
        {planets.map((p) => (
          <span key={p.PlanetId} className={`planet-chip ${colorClass}`}>
            {p.Name}
            {p.Bonus ? <span className="planet-bonus">−{p.Bonus}</span> : null}
          </span>
        ))}
      </div>
    </div>
  )
}

export function ChallengeList({ challenges, onSolve, solvingId }: Props) {
  return (
    <div className="challenge-list">
      <div className="challenge-list-header">
        <h2>Challenges</h2>
      </div>

      {challenges.length === 0 && (
        <p className="empty-state">No active challenges. Come back tomorrow.</p>
      )}

      {challenges.map((c) => (
        <div key={c.ChallengeId} className={`challenge-card${c.IsFinished ? ' finished' : ''}`}>
          <div className="challenge-card-header">
            <span className="challenge-name">{c.ChallengeName ?? 'Challenge'}</span>
            <span className="challenge-level">{c.Level ?? ''}</span>
            {c.IsFinished && <span className="badge">Finished</span>}
          </div>

          <div className="challenge-detail">
            <div className="planet-group">
              <span className="planet-group-label">Start</span>
              <div className="planet-group-chips">
                <span className="planet-chip chip-start">{c.StartPlanetId}</span>
              </div>
            </div>
            <PlanetList planets={c.MandatoryPlanets} label="Mandatory" colorClass="chip-mandatory" />
            <PlanetList planets={c.ForbiddenPlanets} label="Forbidden" colorClass="chip-forbidden" />
            <PlanetList planets={c.BonusPlanets} label="Bonus" colorClass="chip-bonus" />
          </div>

          <button
            className="btn-primary"
            disabled={solvingId !== null}
            onClick={() => onSolve(c)}
          >
            {solvingId === c.ChallengeId
              ? <><Spinner /> Solving…</>
              : 'Solve'}
          </button>
        </div>
      ))}
    </div>
  )
}
