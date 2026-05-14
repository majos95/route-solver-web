import type { SolveInput, SolveResult } from './types'
import { heldKarpSolve } from './heldKarpSolve'
import { trySolveSmallMandatoryOnly } from './mandatoryOnlySolve'

const SMALL_MANDATORY_ONLY_LIMIT = 3

export function solve(input: SolveInput): SolveResult {
  const mandatoryCount =
    new Set(input.mandatoryIds.filter(id => id !== input.startPlanetId)).size

  if (mandatoryCount <= SMALL_MANDATORY_ONLY_LIMIT && input.bonuses.length === 0) {
    const result = trySolveSmallMandatoryOnly(input)
    if (result !== null) return result
  }

  return heldKarpSolve(input)
}
