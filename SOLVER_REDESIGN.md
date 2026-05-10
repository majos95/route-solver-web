---

Rewrite `src/solver/` from scratch. Leave the rest of the project alone (deploy, API, UI, codegen, tests scaffolding are fine).

**Explicit departure from the previous design: Yen's K-shortest paths is gone.** The previous solver used Yen's to handle the global no-revisit constraint by generating alternative segment paths. This was expensive (K Dijkstras per pair, K unbounded) and it was patching over a decomposition that doesn't fit the problem. Do not port any Yen's code, lazy generator, or KSP-cache infrastructure into the new solver. The new design replaces all of it with Held-Karp's natural ordering enumeration plus a forward-sweep repair step.

**The problem.** Generalized Prize-Collecting TSP with Forbidden Vertices and Discounted Edges. Single objective:

```
minimize: Σ(edge_costs_traveled) − Σ(bonus_values_collected)
```

Tour starts and ends at the start node, visits every mandatory exactly once, never enters a forbidden node, no node visited twice (except start/end), includes a bonus iff it lowers the objective.

**Constraint:** the leaderboard rewards exactness *and* speed. Provably-optimal solutions only — every constant-factor win matters.

**Crucial property of the network:** it is logically complete. Every star pair has an edge at full Euclidean cost. Routes are *discounts on edges that already exist* (main = ×0.5, other = ×2/3), not prerequisites. Mandatory stars are always reachable unless explicitly forbidden.

**Node roles:**
- Start: boundary condition.
- Mandatory: hard constraints.
- Forbidden: removed from the search graph at solver entry.
- Bonus: optional with negative effective cost. Filter *dominated* bonuses (cheapest detour cost > value) before subset enumeration.

**The new algorithm.**

1. **Cost matrix precomputation (`costMatrix.ts`).** At solver entry, build a flat `N×N` `Float64Array` of direct edge costs (`edgeCost`), indexed by dense 0-based node indices mapped from sparse planet IDs via `idToIdx`/`idxToId`. All downstream layers index this array — no map lookups in hot paths.

2. **All-pairs shortest paths from forced-stop nodes (`allPairsSP.ts`).** One Dijkstra per node in `{start, ...mandatories, ...bonuses}`, using the cost matrix. Stores both `spCost` (a `Float64Array` of costs) and `spPath` (an array of dense-index paths), keyed by source dense index. This is the *only* path-finding work the solver does upfront. Forbidden nodes are excluded from the Dijkstra neighbor loop.

3. **Dominated bonus filtering.** For each bonus, compute the cheapest possible detour using the all-pairs results. If detour cost > bonus value, drop it from consideration before enumeration.

4. **Bonus subset enumeration.** For each subset of surviving bonuses, treat them as additional mandatories. Compute `bonusCredit = sum of values`. Sort subsets by descending total bonus value so high-credit subsets are tried first. Pass to the Held-Karp solver below.

5. **Held-Karp DP yielding orderings in ascending lower-bound cost (`heldKarp.ts`).** State: `(visited_subset_bitmask, last_node_index)` where indices are into the forced-stops array for the current subset (index 0 = start). A min-heap priority queue drives a branch-and-bound search over partial orderings. `bestReach[mask * n + last]` tracks the cheapest cost to each state; stale heap entries are skipped on pop. A partial state is extended by pushing one entry per unvisited forced stop. **A state yields a complete ordering only when `mask === fullMask`** (all forced stops visited) — at that point the return-to-start cost is added and the full ordering is yielded. This guarantees orderings are emitted in non-decreasing lower-bound cost order. Each yielded ordering's lower-bound effective cost = (sum of `spCost` values along the ordering) − `bonusCredit`.

6. **Realization with forward-sweep repair (`heldKarpSolve.ts`).** For each ordering yielded by Held-Karp:
    - Maintain a `visitedDense` set initialised with the start node's dense index.
    - Process segments in order. For each segment `srcDense → dstDense`:
      - **Early rejection:** if `dstDense` is already in `visitedDense` (a future forced stop was transited by an earlier repair), discard the ordering immediately.
      - Retrieve the precomputed `spPath` for this segment.
      - **Conflict check:** if any *intermediate* node (i.e. `path.slice(1, -1)`) is in `visitedDense`, run one repair Dijkstra with `additionalForbidden = visitedDense \ {dstDense}`. Excluding `dstDense` ensures the last segment can always return to start (start is in `visitedDense` from initialisation). If repair fails, discard the ordering.
      - Add all nodes in the segment path (except the source) to `visitedDense`.
    - **Final no-revisit check:** after all segments are realized, scan the full concatenated route and reject if any non-start node appears more than once. This catches the edge case where a repair path transited through a future forced stop.
    - **If no conflict:** compute `gross` (sum of all segment costs) and `collected` (sum of `bonusValueByDense` for every dense index in the route — includes transit bonuses from all valid bonuses, not just the current subset). Compute `effective = gross − collected`. Update `best` if lower.
    - **Branch-and-bound across orderings:** as soon as the next ordering's lower bound − `bonusCredit` ≥ `best.effectiveFuel`, stop iterating — no further ordering in this subset can improve `best`.

7. **5-minute wall-clock timeout** checked at the entry of every Held-Karp pop and every realization attempt. On timeout: `best.timedOut = true`, return best route found. If no route was found before timeout, return `success: false`.

**Why this is exact:**
- Held-Karp orderings are emitted in non-decreasing lower-bound cost order. The lower bound is a true lower bound on any realization of that ordering (since unconstrained `spCost` values ≤ realized segment costs). When the next lower bound − `bonusCredit` ≥ `best.effectiveFuel`, no further ordering can beat best.
- Forward-sweep repair preserves exactness: for the globally optimal tour T\*, its induced ordering O\* has segments that are node-disjoint by construction. The forward sweep processes each segment with a growing forbidden set, and for each conflicting segment, the repair Dijkstra finds the cheapest path avoiding previously-used nodes. Since T\*'s actual segments are feasible solutions for each repair sub-problem, the repaired tour costs ≤ cost(T\*). Since T\* is optimal, repaired cost = cost(T\*).
- If repair fails or produces a revisit (the final check), we discard and move on. Held-Karp will eventually emit any ordering whose lower bound is below best, so no valid optimal tour is permanently missed.

**Subtleties:**
- Concatenating segments: drop the shared endpoint with `path.slice(1)`.
- Last segment ends at start, which is allowed to appear twice; excluded from the intermediate conflict check via `path.slice(1, -1)`, and excluded from `additionalForbidden` during repair via `visitedDense \ {dstDense}`.
- Transit bonuses: `bonusValueByDense` contains ALL valid bonuses. A bonus planet that appears as a transit node in any segment is credited automatically, even if it was not included in the current bonus subset.
- The `spCost`/`spPath` cache is computed once globally and reused across all bonus subsets, since forbidden nodes don't change between subsets.
- For `n = 1` forced stops (empty bonus subset with no mandatories): `heldKarpGen` yields the trivial `[0, 0]` ordering; the solver handles this as `effective = −bonusCredit`, `gross = 0`.

**Edge cases that must be handled:**
- Empty mandatory + no bonuses → `[start, start]`, fuel 0, success.
- Mandatory contains start → dedupe, no-op.
- Mandatory ∩ forbidden non-empty → success: false with descriptive error.
- Start forbidden, start not in planet list, mandatory not in planet list → success: false.
- Mandatory pairwise unreachable → fail-fast before enumeration → success: false.
- Bonus not in planet list, bonus value ≤ 0, bonus is forbidden → ignore that bonus, don't fail.
- Timeout with no valid route found → success: false.
- Timeout with at least one valid route found → return best, `timedOut: true`.

**Acceptance tests T1–T13 must all pass.**
- T1–T10, T12: correctness and edge-case tests in `src/solver/__tests__/solver.test.ts`.
- T11: adapter round-trip in `src/solver/__tests__/adapters.test.ts`.
- T13: performance — day-1 challenge (3 mandatory) in < 100ms, day-3 challenge (4 mandatory + 2 bonuses) in < 2s on a typical laptop.

**File map:**
- `costMatrix.ts` — step 1: dense cost matrix + index mapping
- `allPairsSP.ts` — step 2: all-pairs SP from forced-stop nodes
- `heldKarp.ts` — step 5: Held-Karp DP + ordered enumeration
- `heldKarpSolve.ts` — steps 3–7: main solver integrating all layers
- `solve.ts` — public entry point, delegates to `heldKarpSolve`
- `edgeCost.ts`, `heap.ts`, `types.ts`, `adapters.ts` — unchanged utilities

---
