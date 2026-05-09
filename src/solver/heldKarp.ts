import { MinHeap } from './heap'

interface HkEntry {
  cost: number
  mask: number   // bitmask of visited forced-stop indices
  last: number   // index in forcedStops of last visited node
  path: number[] // sequence of forcedStops indices visited so far
}

// n        = number of forced stops (index 0 = start)
// costs    = flat n×n matrix; costs[i*n + j] = spCost from forcedStop[i] to forcedStop[j]
//
// Yields full orderings in non-decreasing lower-bound cost.
// Each ordering is a complete tour: [0, ...middle, 0] where middle is a permutation of 1..n-1.
// Stops emitting once the priority queue is exhausted.
// The caller is responsible for the B&B cutoff (stop pulling when next cost ≥ best).
export function* heldKarpGen(
  n: number,
  costs: Float64Array,
): Generator<{ ordering: number[]; cost: number }, void, void> {
  if (n === 1) {
    yield { ordering: [0, 0], cost: 0 }
    return
  }

  const stateCount = n * (1 << n)
  const bestReach = new Float64Array(stateCount).fill(Infinity)
  // bestReach[mask * n + last] = cheapest cost to reach state (mask, last)

  const pq = new MinHeap<HkEntry>()
  const init: HkEntry = { cost: 0, mask: 1, last: 0, path: [0] }
  pq.push(0, init)
  bestReach[/* mask=1 */ 1 * n + 0] = 0

  const fullMask = (1 << n) - 1

  while (pq.size > 0) {
    const [, entry] = pq.pop()!
    const { cost, mask, last, path } = entry

    // Stale entry: a cheaper path to (mask, last) was already processed.
    if (cost > bestReach[mask * n + last]) continue

    if (mask === fullMask) {
      // All forced stops visited — close the tour back to start.
      const returnCost = costs[last * n + 0]
      yield { ordering: [...path, 0], cost: cost + returnCost }
      continue
    }

    for (let v = 1; v < n; v++) {
      if (mask & (1 << v)) continue  // already visited
      const newMask = mask | (1 << v)
      const newCost = cost + costs[last * n + v]
      const stateIdx = newMask * n + v
      if (newCost >= bestReach[stateIdx]) continue
      bestReach[stateIdx] = newCost
      pq.push(newCost, { cost: newCost, mask: newMask, last: v, path: [...path, v] })
    }
  }
}
