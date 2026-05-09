import type { SolveInput, SolveResult } from './types'
import { heldKarpSolve } from './heldKarpSolve'

export function solve(input: SolveInput): SolveResult {
  return heldKarpSolve(input)
}
