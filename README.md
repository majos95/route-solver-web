# Route Solver Web

A static web app for the **OutSystems Star Delivery** daily route-planning challenge. It fetches the game map and today's challenges from the Star Delivery API, solves the constrained shortest-route problem in a background Web Worker, lets you verify the result against the API's coaxium calculator, and submit your solution.

## What it does

1. Loads the 194-planet game map (cached in sessionStorage)
2. Fetches all three daily challenge levels
3. Solves each challenge — finding the minimum effective fuel route that visits all mandatory planets, avoids all forbidden planets, and optionally collects bonus planets — in a background thread so the UI stays responsive
4. Shows the ordered route, fuel breakdown (gross / bonus / effective), and raw API payloads
5. Lets you verify the solution with a one-click oracle check against `CalculateCoaxium`
6. Submits the solution behind a two-click confirmation

## Quick start

```bash
cd route-solver-web
cp .env.example .env.local
# Fill in your credentials in .env.local
npm install   # also runs codegen (swagger → types)
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Environment variables

```
VITE_PLAYER_GUID=...
VITE_PLAYER_EMAIL=...
VITE_API_BASE_URL=https://wecode.outsystems.com/StarDelivery_Ngin/rest/StarDeliveryServices
```

Copy `.env.example` to `.env.local` and fill in your credentials. The app shows a setup error screen if any variable is missing.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server (runs codegen first) |
| `npm run build` | Type-check + production build (runs codegen first) |
| `npm test` | Run the solver test suite (Vitest) |
| `npm run solve` | Auto-solve and submit today's active challenge via CLI |
| `npm run solve:dry` | Same, but without actually submitting |

## Auto-solve CLI

`scripts/auto-solve.ts` polls for the next unsolved daily challenge level, runs the solver, verifies with the oracle, and submits — fully automated. Useful for scheduled runs.

```bash
npm run solve        # solve and submit
npm run solve:dry    # solve, verify, but don't submit
```

## Solver algorithm

The solver runs in `src/solver/` — pure TypeScript, no DOM, fully unit-testable. It finds the minimum effective-fuel simple path through all forced stops while routing around forbidden planets and optionally collecting bonuses.

**Edge cost:** every planet pair has a base Euclidean cost. Explicit routes apply discounts: main routes ×0.5, other routes ×⅔. The graph is always fully connected.

**Algorithm outline:**

1. **Cost matrix** — dense `n×n` `Float64Array` of pairwise edge costs
2. **All-pairs shortest paths** — one Dijkstra per key node (start, mandatory stops, candidate bonus planets), with forbidden planets blocked
3. **Bonus subset enumeration** — tries all `2^b` bonus planet subsets, mandatory-only first to establish an initial bound, then remaining subsets by ascending abstract lower bound
4. **Held-Karp ordering generator** — yields all orderings of forced stops in non-decreasing abstract-cost order; breaks as soon as the lower bound exceeds the current best (branch and bound)
5. **Joint path DP** (`realizeOrderingDP`) — for each candidate ordering, runs Dijkstra over joint state `(segment, planet, bottleneck-node-mask)` to find the cheapest *simple* physical path through all forced stops in order. Tracks up to 6 bottleneck transit nodes per state to prevent cascading segment conflicts. Two levels of branch-and-bound pruning: per-state (after pop) and per-neighbor (before push), both using precomputed suffix lower bounds.

**Performance** (71 tests, 194-planet live map):

| Test | Challenge | Time |
|---|---|---|
| T16 | 5 mandatory + 2 bonuses | ~31 ms |
| C95 | 5 mandatory + 3 bonuses + forbidden | ~137 ms |
| C102 | 7 mandatory + 3 bonuses + forbidden | ~540 ms |
| All others | — | < 50 ms |

## Project layout

```
route-solver-web/
├── src/
│   ├── api/            # Generated types + typed API client
│   ├── solver/         # Pure solver (no DOM)
│   │   ├── heldKarpSolve.ts   # Core: bonus enumeration + path DP
│   │   ├── allPairsSP.ts      # Dijkstra from each key node
│   │   ├── costMatrix.ts      # Dense cost matrix
│   │   ├── heldKarp.ts        # HK ordering generator
│   │   ├── solve.ts           # Entry point
│   │   ├── solver.worker.ts   # Web Worker wrapper
│   │   └── __tests__/         # 71 unit + real-world tests
│   ├── state/          # React hooks (map load, challenge fetch)
│   └── ui/             # React components
├── scripts/
│   └── auto-solve.ts   # CLI auto-solver
├── swagger.json        # API contract (Swagger 2.0, source of truth)
├── .env.example
└── SPEC.md             # Full architecture + algorithm spec
```

## Tests

```bash
npm test
```

71 tests covering individual algorithm layers (cost matrix, shortest paths, HK generator) and end-to-end acceptance tests against the full live game map. Real-world test results are verified against the game leaderboard.

## Deployment

Deploys to GitHub Pages via GitHub Actions on every push to `main`. Credentials are injected from repository secrets:

- `VITE_PLAYER_GUID`
- `VITE_PLAYER_EMAIL`
- `VITE_API_BASE_URL`

See `.github/workflows/deploy.yml` for details.

## Further reading

`SPEC.md` contains the full architecture spec, algorithm walkthrough with edge cases, API surface documentation, and DTO definitions.
