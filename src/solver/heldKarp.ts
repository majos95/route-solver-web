import { MinHeap } from './heap'

interface HkEntry {
  cost: number
  mask: number   // bitmask of visited forced-stop indices
  last: number   // index in forcedStops of last visited node
  nodeIdx: number // index into btNode/btParent for path reconstruction
}

// Backtrack arrays: form a linked list of visited nodes.
// btNode[i]   = forced-stop index visited at this step
// btParent[i] = nodeIdx of the previous step (-1 at root)
// Stored externally (not per-entry) to avoid O(k) copy on each heap push.

function buildPath(nodeIdx: number, btNode: number[], btParent: number[]): number[] {
  const path: number[] = []
  let i = nodeIdx
  while (i >= 0) {
    path.unshift(btNode[i])
    i = btParent[i]
  }
  return path
}

// n        = number of forced stops (index 0 = start)
// costs    = flat n×n matrix; costs[i*n + j] = spCost from forcedStop[i] to forcedStop[j]
//
// Yields ALL complete orderings in non-decreasing lower-bound cost.
// Each ordering is a complete tour: [0, ...middle, 0] where middle is a permutation of 1..n-1.
// Stops emitting once the priority queue is exhausted.
// The caller is responsible for the B&B cutoff (stop pulling when next cost ≥ best).
//
// No bestReach pruning is used: every distinct ordered prefix is explored so that
// the caller sees all orderings, not just the HK-DP-optimal one per (mask, last) pair.
// This is necessary because realized costs (after forward-sweep repair) can exceed the
// lower bound, so the cheapest-lb ordering per state is not always the best realized one.
export function* heldKarpGen(
  n: number,
  costs: Float64Array,
): Generator<{ ordering: number[]; cost: number }, void, void> {
  if (n === 1) {
    yield { ordering: [0, 0], cost: 0 }
    return
  }

  const btNode: number[] = [0]
  const btParent: number[] = [-1]

  const pq = new MinHeap<HkEntry>()
  pq.push(0, { cost: 0, mask: 1, last: 0, nodeIdx: 0 })

  const fullMask = (1 << n) - 1

  while (pq.size > 0) {
    const [, entry] = pq.pop()!
    const { cost, mask, last, nodeIdx } = entry

    if (mask === fullMask) {
      const path = buildPath(nodeIdx, btNode, btParent)
      path.push(0)
      yield { ordering: path, cost }
      continue
    }

    for (let v = 1; v < n; v++) {
      if (mask & (1 << v)) continue  // already visited
      const newMask = mask | (1 << v)
      const newCost = cost + costs[last * n + v]

      const newNodeIdx = btNode.length
      btNode.push(v)
      btParent.push(nodeIdx)

      if (newMask === fullMask) {
        const totalCost = newCost + costs[v * n + 0]
        pq.push(totalCost, { cost: totalCost, mask: newMask, last: v, nodeIdx: newNodeIdx })
      } else {
        pq.push(newCost, { cost: newCost, mask: newMask, last: v, nodeIdx: newNodeIdx })
      }
    }
  }
}
