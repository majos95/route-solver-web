import type { SolveInput, SolveResult } from './types'
import { disjointTsp } from './disjointTsp'

export function solve(input: SolveInput): SolveResult {
  return disjointTsp(input)
}
