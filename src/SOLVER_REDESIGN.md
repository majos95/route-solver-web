---

Rewrite `src/solver/` from scratch. Leave the rest of the project alone (deploy, API, UI, codegen, tests scaffolding are fine).

**Explicit departure from the previous design: Yen's K-shortest paths is gone.** The previous solver used Yen's to handle the global no-revisit constraint by generating alternative segment paths. This was expensive (K Dijkstras per pair, K unbounded) and it was patching over a decomposition that doesn't fit the problem. Do not port any Yen's code, lazy generator, or KSP-cache infrastructure into the new solver. The new design replaces all of it with Held-Karp's natural ordering enumeration plus a single repair step.

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

1. **Cost matrix precomputation.** At solver entry, build a flat `N×N` `Float64Array` of edge costs (Euclidean by default, route discounts applied where present), indexed by dense 0-based node indices mapped from sparse planet IDs. All downstream layers index this array — no map lookups in hot paths.

2. **All-pairs shortest paths from forced-stop nodes.** One Dijkstra per node in `{start, ...mandatories, ...bonuses}`, using the cost matrix. Stores both costs and reconstructed paths. This is the *only* path-finding work the solver does upfront.

3. **Dominated bonus filtering.** For each bonus, compute the cheapest possible detour using the all-pairs results. If detour cost > bonus value, drop it from consideration before enumeration.

4. **Bonus subset enumeration.** For each subset of surviving bonuses, treat them as additional mandatories. Compute `bonusCredit = sum of values`. Pass to the Held-Karp solver below.

5. **Held-Karp DP yielding orderings in ascending lower-bound cost.** State: `(visited_subset_bitmask, last_node)`. Edge weights: the unconstrained all-pairs SP costs from step 2. Standard Held-Karp finds the *single* optimal ordering — but here we extend it to yield orderings via a priority queue over DP states, popping in ascending cost order. Each yielded ordering has a lower-bound effective cost equal to (sum of unconstrained SP costs along the ordering) − bonusCredit.

6. **Realization with single-repair.** For each ordering yielded by Held-Karp:
    - Concatenate the precomputed shortest paths for each segment to form a candidate tour.
    - Check global no-revisit (any non-start node appears twice).
    - **If no conflict**: this ordering realizes. Compute its actual effective fuel (which equals its lower bound) and update `best`.
    - **If conflict**: identify the conflicting segment(s) — the ones containing already-used nodes from earlier segments. For each conflicting segment, run *one* Dijkstra with the conflicting nodes added to `forbiddenNodes`. If all conflicts resolve, accept the repaired tour at its (slightly higher) actual cost. If repair fails for any segment, discard this ordering.
    - **Branch-and-bound across orderings:** as soon as the next ordering's lower bound ≥ `best.effectiveFuel`, stop iterating — no further ordering can improve `best`.

7. **5-minute wall-clock timeout** checked at the entry of every Held-Karp pop and every realization attempt. On timeout: `best.timedOut = true`, return best route found. If no route was found before timeout, return `success: false`.

**Why this is exact:**
- Held-Karp orderings are emitted in ascending lower-bound order. The lower bound is a true lower bound on any realization of that ordering (since unconstrained SPs ≤ realized SPs). When the next lower bound ≥ best, no further ordering can beat best.
- Single-repair preserves exactness: if repair fails, we *don't* accept a suboptimal tour — we move on. We only accept repaired tours whose actual cost is computed correctly.
- Edge case: an ordering whose only realization requires multi-step repair (more than one Dijkstra per segment) will be rejected here, and we'll find the optimum via a different ordering. This is safe because Held-Karp will eventually emit any ordering whose lower bound is below best, including the one whose unconstrained SPs *naturally* avoid conflict.

**Subtleties:**
- Concatenating segments: drop the shared endpoint with `path.slice(1)`.
- Last segment ends at start, which is allowed to appear twice; don't flag this as a conflict.
- Held-Karp's priority queue is over DP states, not orderings directly. Each pop gives a (state, partial-path) which extends to a full ordering once all forced stops are visited.
- Cache the all-pairs shortest paths globally — they don't depend on the bonus subset (since forbidden nodes don't change between subsets, only the set of forced stops does).

**Edge cases that must be handled:**
- Empty mandatory + no bonuses → `[start, start]`, fuel 0, success.
- Mandatory contains start → dedupe, no-op.
- Mandatory ∩ forbidden non-empty → success: false with descriptive error.
- Start forbidden, start not in planet list, mandatory not in planet list → success: false.
- Mandatory pairwise unreachable (only possible if forbidden set isolates a node, which can't happen in the complete-graph model unless the planet itself is forbidden — but check defensively) → success: false.
- Bonus not in planet list, bonus value ≤ 0 → ignore that bonus, don't fail.
- Timeout with no valid route found → success: false.
- Timeout with at least one valid route found → return best, `timedOut: true`.

**Acceptance tests T1–T12 must all pass.** Add T13: solver completes the day-1 challenge (3 mandatory) in < 50ms and the day-3 challenge (4 mandatory + 2 bonuses) in < 500ms on a typical laptop.

**Before writing code**, push back on anything you'd implement differently — especially around the single-repair step, since "one Dijkstra per conflicting segment" is the part where exactness arguments are subtlest. Then propose the rewrite as a single PR.

---