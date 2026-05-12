---

# Route Solver — Design Reference

## The problem

Generalized Prize-Collecting TSP with Forbidden Vertices and Discounted Edges. Single objective:

```
minimize: Σ(edge_costs_traveled) − Σ(bonus_values_collected)
```

Tour starts and ends at the start node, visits every mandatory exactly once, never enters a forbidden node, no node visited twice (except start/end), includes a bonus planet iff it lowers the objective.

The leaderboard rewards exactness and speed — provably-optimal solutions only.

---

## Network properties

- Every planet pair has an implicit full-cost Euclidean edge — the graph is logically complete.
- Routes are **bidirectional discounts** on edges that already exist: `main` route = ×0.5, `other` route = ×2/3.
- The canonical edge key is `min(id)-max(id)` (undirected). Switching to directed routes produces far worse results and is wrong.
- Mandatory planets are always reachable unless explicitly forbidden.

---

## Algorithm

### Step 1 — Cost matrix (`costMatrix.ts`)

Build a flat `N×N` `Float64Array` of direct edge costs, indexed by dense 0-based node indices mapped from sparse planet IDs via `idToIdx`/`idxToId`. All downstream layers index this array — no map lookups in hot paths.

### Step 2 — All-pairs shortest paths (`allPairsSP.ts`)

One Dijkstra per node in `{start, ...mandatories, ...bonuses}`, using the cost matrix. Forbidden nodes are excluded from the neighbor loop. Stores both `spCost` (a `Float64Array` of costs) and `spPath` (an array of dense-index paths), keyed by source dense index. This is the only path-finding work done upfront. The result is reused across all bonus subsets.

### Step 3 — Bonus subset enumeration (`heldKarpSolve.ts`)

For each subset of valid bonuses, treat them as additional mandatory stops. Compute `bonusCredit = sum of values`. Sort subsets by descending total bonus value so high-credit subsets are tried first.

### Step 4 — Held-Karp ordering enumeration (`heldKarp.ts`)

State: `(visited_subset_bitmask, last_node_index)` where indices are into the forced-stops array (index 0 = start). A min-heap priority queue enumerates partial orderings in ascending cost order.

**Critical design point — no `bestReach` pruning:**
The original Held-Karp DP keeps only the cheapest path per `(mask, last)` state (`bestReach`). This is correct for standard TSP where lower bound = realized cost. It is **wrong here** because realized costs can exceed the lower bound due to forward-sweep repair. Specifically: if ordering A ends at node X with lb=3302 but needs expensive repair (realized=3495), and ordering B ends at the same node X with lb=3350 but is clean (realized=3350), the `bestReach` check would prune B entirely — making B unreachable even though it produces a better result.

Fix: `bestReach` is removed. Every distinct ordered prefix is pushed to the heap and explored. The heap grows as a search tree with ≈e·(n−1)! total entries (bounded by the B&B cutoff in the caller). For n ≤ 10 forced stops this is always fast; for larger n, B&B prunes the vast majority of branches early.

For full-mask states (all forced stops visited), the return-to-start cost is included in the priority so orderings are popped — and yielded — in true ascending total-cost order.

### Step 5 — Realization with forward-sweep repair (`heldKarpSolve.ts`)

For each ordering yielded by Held-Karp:

1. Maintain `visitedDense` initialised with the start node.
2. Maintain `allForcedDense` — the set of all forced-stop dense indices for this subset.
3. Process segments in order. For each segment `src → dst`:
   - **Early rejection:** if `dst` is already in `visitedDense`, discard immediately.
   - Retrieve the precomputed `spPath` for this pair.
   - **Conflict check:** if any intermediate node (i.e. `path.slice(1,-1)`) is in `visitedDense` OR in `allForcedDense`, run one repair Dijkstra with `additionalForbidden = visitedDense ∪ allForcedDense \ {dst}`. Forbidding future forced stops prevents them from being transited prematurely. Excluding `dst` keeps the target reachable.
   - If repair fails, discard the ordering.
   - Add all segment nodes (except source) to `visitedDense`.
4. **Final no-revisit check:** scan the full concatenated route; reject if any non-start node appears more than once. This catches cases where a repair path transited a future forced stop.
5. Compute `gross` (sum of segment costs) and `collected` (sum of `bonusValueByDense` for every node in route — transit bonuses credited automatically). Compute `effective = gross − collected`. Update `best` if lower.

**Why this is exact:** the globally optimal tour T\* is a simple path (no node revisits). Its segments are therefore node-disjoint by construction. When realizing the ordering of T\* with the forward sweep, no segment's intermediate nodes are in `visitedDense` (they haven't been visited yet) — so no repair is needed and the realized cost equals T\*'s cost exactly. Since we enumerate all orderings with lb < best (guaranteed by removing `bestReach` pruning), the ordering of T\* is always reached before the B&B cutoff fires.

### Step 6 — Branch-and-bound cutoff

As soon as the next ordering's lower bound minus `bonusCredit` ≥ `best.effectiveFuel`, stop iterating — no further ordering in this subset can improve best.

### Step 7 — Timeout

5-minute wall-clock timeout checked at every realization attempt. On timeout: return best route found with `timedOut: true`. If no route found before timeout: `success: false`.

---

## File map

| File | Purpose |
|---|---|
| `costMatrix.ts` | Dense N×N cost matrix + planet index mapping |
| `edgeCost.ts` | Euclidean distance + route discount logic + undirected `routeKey` |
| `allPairsSP.ts` | Dijkstra from each forced-stop node; stores cost + path |
| `heldKarp.ts` | Full permutation enumeration via min-heap; yields orderings in ascending lb order |
| `heldKarpSolve.ts` | Bonus subset loop, realization, repair Dijkstra, B&B cutoff |
| `solve.ts` | Public entry point — delegates to `heldKarpSolve` |
| `heap.ts` | Binary min-heap used by Dijkstra and Held-Karp |
| `types.ts` | `Planet`, `Route`, `SolveInput`, `SolveResult` interfaces |
| `adapters.ts` | Converts raw API shapes to solver types |
| `solver.worker.ts` | Web Worker wrapper so the UI doesn't block |

---

## Running things locally

### Unit and correctness tests

```bash
npm test
```

Runs all three test suites via Vitest:

| Suite | File | What it covers |
|---|---|---|
| Solver correctness (T1–T13) | `src/solver/__tests__/solver.test.ts` | Edge cases: empty mandatories, forbidden, bonuses, no-path, timeout, performance |
| Real-world challenges (T14–T19) | `src/solver/__tests__/realWorld.test.ts` | 6 verified-optimal challenges from the live game (Mandalore + Coruscant series) |
| Adapter round-trip (T11) | `src/solver/__tests__/adapters.test.ts` | API → solver type conversion |

To run a single suite:

```bash
npm test -- realWorld      # only real-world tests
npm test -- solver         # only unit tests
npm test -- adapters       # only adapter tests
```

### Debug a specific challenge (instrumented trace)

```bash
npx tsx scripts/debug-solver.ts
npx tsx scripts/debug-solver.ts --top=50          # show first 50 orderings
npx tsx scripts/debug-solver.ts --target=3400     # stop once a result beats 3400
```

Logs every ordering tried by Held-Karp with its lower bound, each segment's SP path, any conflict/repair with cost delta, and a final summary vs. game optimal. Hard-coded to the T14 Mandalore challenge. Edit the constants at the top of the script to test other challenges.

### Dry run against the live API (no submission)

```bash
npm run solve:dry
```

Reads `VITE_API_BASE_URL`, `VITE_PLAYER_GUID`, `VITE_PLAYER_EMAIL` from `.env.local`. Fetches live challenges and map data, solves all, prints the routes and fuel scores that **would** be submitted — but does not call the submission endpoint.

To run with env vars inline:

```bash
VITE_API_BASE_URL=https://... VITE_PLAYER_GUID=... VITE_PLAYER_EMAIL=... npm run solve:dry
```

### Submit manually (live, real submission)

```bash
npx tsx scripts/auto-solve.ts
```

Polls for active challenges, solves all, submits sequentially (Level 1 → 2 → 3), waits for `IsFinished` confirmation before moving to the next. Exits with code 1 if any submission fails after 3 attempts.

---

## Deploying to AWS

The Lambda is deployed via AWS SAM. Everything is pre-configured in `samconfig.toml` (stack name, region `eu-central-1`, S3 bucket, API base URL) and `template.yaml` (two functions: live solver + dry-run).

### First-time setup

Requires AWS CLI configured with credentials for account `224802931430`.

### Deploy (every time you push solver or Lambda changes)

```bash
# 1. Bundle both Lambda handlers
npm run build:lambda

# 2. Deploy — SAM reuses PlayerGuid and PlayerEmail already in the stack
sam deploy
```

SAM will show the changeset and ask for confirmation before applying.

### What gets deployed

| Lambda function | Trigger | Purpose |
|---|---|---|
| `route-solver-daily` | EventBridge cron `58 23 * * ? *` (23:58 UTC) | Live solver — polls, solves, submits |
| `route-solver-dry-run` | Manual only (`aws lambda invoke` or console) | Verifies API + solver without submitting |

### Verify the EventBridge rule is wired correctly

```bash
aws events list-rules --region eu-central-1 --query "Rules[?contains(Name, 'route-solver')]"
aws events list-targets-by-rule --rule route-solver-daily-trigger --region eu-central-1
```

---

## Testing in AWS

### Invoke the dry-run Lambda

```bash
aws lambda invoke --function-name route-solver-dry-run --region eu-central-1 out.json && cat out.json
```

Returns a JSON summary with per-challenge solver results, effectiveFuel, and the full route that would be submitted. Nothing is submitted. Use this to confirm API connectivity, env vars, and solver correctness after any deployment.

### Check live Lambda logs

```bash
aws logs tail /aws/lambda/route-solver-daily --region eu-central-1 --follow
```

To check whether the 00:00 UTC trigger fired (macOS date syntax):

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/route-solver-daily \
  --region eu-central-1 \
  --start-time $(date -v-1d -v23H -v50M -v0S +%s)000 \
  --end-time $(date -v0H -v10M -v0S +%s)000
```

Empty `events` + empty `searchedLogStreams` = Lambda was never invoked (likely not deployed before midnight). Log entries ending in a timeout error = Lambda ran but challenges weren't available within 5 minutes.
