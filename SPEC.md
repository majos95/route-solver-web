# RouteSolver Web — Spec

## Purpose

A static web application for the OutSystems Star Delivery daily route-planning challenge. Fetches challenges and the game map from the Star Delivery API, runs a constrained-TSP solver in a background Web Worker, validates routes against the API's coaxium calculator, and displays the optimal solution for review and submission.

This is a development and debugging tool, not a production agent. It exists to let the algorithm and UX iterate independently of OutSystems ODC. A future port of the solver into an ODC External Library is possible but out of scope here.

## Scope

**In scope**
- Fetch the game map (planets and routes) and all daily challenges from the Star Delivery API
- Solve the constrained shortest-route problem in a background Web Worker (non-blocking)
- Validate the solver's output against the API's `CalculateCoaxium` endpoint on demand
- Display the resulting ordered route with computed effective fuel and raw API payloads
- Submit the solution via `SubmitChallengeSolution` behind a two-click confirmation
- Cache the game map locally (sessionStorage) since it's stable; refetch challenges per session
- Deploy as a static site via GitHub Pages with credentials protected as GitHub Actions secrets

**Out of scope**
- Any OutSystems integration
- Server-side compute or persistent backend
- Map/visualization (deferred — see "Phase 2 niceties")
- Manual override UI (alternate start, custom forbidden set) — deferred
- Multi-user support, credential rotation, encryption at rest

## Architecture

Static SPA, single bundle. Solver runs off the main thread in a Web Worker.

```
┌──────────────────────────────────────────────────────────────┐
│  Browser                                                       │
│                                                                │
│  ┌────────────┐    ┌────────────────────┐    ┌────────────┐   │
│  │   API      │───▶│  Web Worker        │───▶│   UI       │   │
│  │  Client    │    │  solver.worker.ts  │    │  (React)   │   │
│  │ (codegen)  │    │  └ solve()         │    │            │   │
│  └────────────┘    └────────────────────┘    └────────────┘   │
│        │                                           │           │
│        └───────────── oracle / submit ─────────────┘          │
└──────────────────────────────────────────────────────────────┘
                        │
                        ▼
                  Star Delivery API
```

Three layers, strictly separated:

1. **API client** — generated from `swagger.json` via `swagger2openapi` + `openapi-typescript`. Auth headers passed explicitly per call. No handwritten fetchers.
2. **Solver** — pure TypeScript, no DOM, no fetch. Runs in a Web Worker. Takes typed inputs (Planet[], Route[], constraints), returns typed outputs. Fully unit-testable in Node.
3. **UI** — React + Vite. Renders state; never computes solutions itself.

## Tech stack

- **Vite + React + TypeScript.** Fast dev loop, zero config for static deploy.
- **`swagger2openapi`** converts the Swagger 2.0 `swagger.json` to OAS3 at build time (openapi-typescript no longer supports Swagger 2.0).
- **`openapi-typescript`** generates types from the converted OAS3 schema at build time.
- **`openapi-fetch@0.13`** as the typed runtime client. Auth headers passed via explicit `params.header` on each call (the library requires typed headers at the call site, not via middleware).
- **Web Worker** (`solver.worker.ts`) runs the synchronous solver off the main thread so the UI stays responsive during long solves. The main thread shows a live elapsed-time counter and a Cancel button.
- **No state management library.** `useState` and prop-drilling are fine for this size.
- **Vitest** for solver unit tests.
- **Plain CSS.** No Tailwind, no component libraries.

## Configuration & credentials

Credentials live in environment variables, loaded by Vite from `.env.local` at dev time and from GitHub Actions secrets at build time (baked into the bundle):

```
VITE_PLAYER_GUID=...
VITE_PLAYER_EMAIL=...
VITE_API_BASE_URL=https://wecode.outsystems.com/StarDelivery_Ngin/rest/StarDeliveryServices
```

Repo ships a `.env.example` with placeholders and lists `.env.local` in `.gitignore`. If any var is missing, the app shows a one-screen setup error rather than failing silently.

The `client.ts` module reads these once at startup. Each API function passes `{ PlayerGuid, PlayerEmail }` as explicit `params.header` — this is required by openapi-fetch@0.13's typed header model.

## Codegen

The `swagger.json` at repo root is Swagger 2.0, which openapi-typescript@7 no longer accepts. The build pipeline converts it first:

```
swagger2openapi ../swagger.json -o .swagger-oas3.json
openapi-typescript ./.swagger-oas3.json -o ./src/api/schema.d.ts
```

Both output files (`.swagger-oas3.json`, `src/api/schema.d.ts`) are gitignored and regenerated on every `npm install`, `npm run dev`, and `npm run build` via `postinstall`/`predev`/`prebuild` hooks.

## Project layout

```
.github/
└── workflows/
    └── deploy.yml              # GitHub Pages deployment
swagger.json                    # source of truth for API contract (Swagger 2.0)
SPEC.md                         # this file
route-solver-web/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── .env.example
├── .gitignore                  # includes .env.local, schema.d.ts, .swagger-oas3.json
├── public/
│   └── CNAME                   # custom domain for GitHub Pages
└── src/
    ├── main.tsx
    ├── App.tsx                 # top-level: map load, challenge list, solve orchestration
    ├── App.css
    ├── api/
    │   ├── schema.d.ts         # generated — do not edit
    │   └── client.ts           # typed wrappers for all 5 endpoints
    ├── solver/
    │   ├── types.ts            # domain types (Planet, Route, Bonus, SolveInput, SolveResult)
    │   ├── adapters.ts         # API DTO ↔ domain conversions
    │   ├── edgeCost.ts         # edge cost formula with route discounts
    │   ├── heap.ts             # binary MinHeap (lazy-deletion Dijkstra)
    │   ├── costMatrix.ts       # dense n×n Float64Array of pairwise edge costs
    │   ├── allPairsSP.ts       # Dijkstra from each key node with forbidden set
    │   ├── heldKarp.ts         # HK ordering generator — yields orderings in LB order
    │   ├── heldKarpSolve.ts    # top-level solver: bonus enumeration + DP realization
    │   ├── solve.ts            # thin entry point calling heldKarpSolve
    │   ├── solver.worker.ts    # Web Worker wrapper around solve()
    │   └── __tests__/
    │       ├── adapters.test.ts
    │       ├── solver.test.ts  # unit tests for each layer + T1–T13 acceptance tests
    │       ├── realWorld.fixture.ts  # full 195-planet game map fixture
    │       └── realWorld.test.ts     # end-to-end tests against real challenge data
    ├── state/
    │   ├── useGameMap.ts       # hook: load planets+routes, cache in sessionStorage
    │   └── useChallenges.ts    # hook: fetch GetDailyChallenge + GetActiveLevelDailyChallenge
    └── ui/
        ├── ChallengeList.tsx   # renders all 3 challenge cards with full planet details
        ├── SolutionView.tsx    # fuel display, route chips, oracle check, submit flow
        └── components/
            ├── RawJson.tsx     # collapsible <details> panel for raw API payloads
            └── Spinner.tsx
```

## API surface

Five endpoints, all under the base path configured in `VITE_API_BASE_URL`. All require `PlayerGuid` and `PlayerEmail` headers.

| Endpoint | Method | Purpose |
|---|---|---|
| `/GetPlanetsAndRoutes` | GET | Returns the game map (planets + routes). Cached in sessionStorage. |
| `/GetDailyChallenge` | GET | Returns all 3 levels of today's challenge. Drives the challenge list. |
| `/GetActiveLevelDailyChallenge` | GET | Returns the next unfinished level only. Shown as raw data for status monitoring. |
| `/CalculateCoaxium` | POST | Validates a route and returns coaxium cost without persisting. Manual oracle check. |
| `/SubmitChallengeSolution` | POST | Submits a route, persists the result, advances to the next level. Gated. |

Both challenge endpoints are called on every load. `GetDailyChallenge` drives the UI (always shows all 3 challenges). `GetActiveLevelDailyChallenge` is displayed as a raw JSON panel for monitoring — useful to verify when the API starts returning results correctly again after anomalies.

### Domain DTOs (from swagger)

- **`PlanetOut`**: `{ Id, Name, Coordinate_X, Coordinate_Y }`. `Id` is int64; coordinates are numbers.
- **`RouteOut`**: `{ From_Planet, To_PlanetId, RouteType }`. Note the asymmetric field name (`From_Planet`, not `From_PlanetId`). `RouteType ∈ { "Main Route", "Other Route" }`.
- **`StarDeliveryMap`**: `{ Planets: PlanetOut[], Routes: RouteOut[] }`.
- **`ChallengeOut`**: `{ ChallengeId, ChallengeName, StartPlanetId (string), MandatoryPlanets, ForbiddenPlanets, BonusPlanets, IsFinished, Level }`. `Level ∈ { "Level1", "Level2", "Level3" }`. Array fields may be omitted when empty.
- **`PlaneMapSimple`**: `{ PlanetId, Name, Bonus }`. `Bonus` only meaningful on `BonusPlanets`.
- **`PlanetSimple`**: `{ PlanetId, Name }` — array element type for route submissions.
- **`SubmissionResult`**: `{ IsSuccess, FeedbackMessage, Coaxium }`.

### Adapter layer

API DTOs are kept at the boundary. The solver works with cleaner internal types:

```typescript
// solver/types.ts
export interface Planet { id: number; name: string; x: number; y: number; }
export interface Route { from: number; to: number; type: 'main' | 'other'; }
export interface Bonus { planetId: number; value: number; }

export interface SolveInput {
  planets: Planet[];
  routes: Route[];
  startPlanetId: number;
  mandatoryIds: number[];
  forbiddenIds: number[];
  bonuses: Bonus[];
}

export interface SolveResult {
  success: boolean;
  errorMessage?: string;
  orderedRoute: Planet[];      // includes start at both ends
  effectiveFuel: number;       // grossFuel − collectedBonus
  grossFuel: number;
  collectedBonus: number;
  timedOut?: boolean;
}
```

`adapters.ts` translates:
- `PlanetOut → Planet`
- `RouteOut → Route` (mapping `"Main Route" → 'main'`, `"Other Route" → 'other'`)
- `ChallengeOut → SolveInput` (`StartPlanetId` parsed from string to number; int64 precision risk documented; bonus values ≤ 0 filtered out)
- `Planet[] → PlanetSimple[]` for submission payloads

## User flow

1. **First load.** App reads env vars; renders main view.
2. **Game map fetch.** `useGameMap` checks sessionStorage (`routesolver:gamemap:v2`); if absent, calls `GetPlanetsAndRoutes` and caches. Raw response shown in a collapsible panel.
3. **Challenge list.** Both challenge endpoints are called in parallel. All 3 challenges are always shown with full detail: start planet, mandatory planets (green chips), forbidden planets (red chips), bonus planets (yellow chips with bonus value). `GetActiveLevelDailyChallenge` raw response shown for monitoring.
4. **Solve.** Click Solve on any challenge. The main thread starts a Web Worker and shows a live "Solving… Xs" counter with a Cancel button. The solver runs in the background; the UI stays responsive.
5. **Solution view.** Shows solver fuel (gross, bonus, effective), the ordered route as planet name chips, a Copy IDs button, and collapsible raw panels for solve input and solver output.
6. **Oracle check (manual).** Click "Calculate Coaxium" to call `CalculateCoaxium`. On match (within 1 unit): green "Oracle verified" banner. On mismatch: yellow warning with both values. On rejection: red banner with `FeedbackMessage`.
7. **Submit (gated).** After oracle verification, a "Submit solution" button appears. Clicking it shows an inline "Confirm submit" + "Cancel" + disclaimer. Confirming fires `SubmitChallengeSolution` and shows the result banner. The submit UI remains visible after submission.

State is ephemeral except for the game map cache. Refresh starts fresh.

## Solver architecture

The solver entry point (`solve.ts → heldKarpSolve`) runs synchronously in a Web Worker. The main thread communicates via `postMessage`:

- **Input:** `SolveInput` serialised via `postMessage` to the worker
- **Output:** `{ ok: true, result: SolveResult }` or `{ ok: false, error: string }`
- **Cancellation:** `worker.terminate()` — immediate, no cooperative cancellation needed

If the worker throws, the error surfaces as a red banner. The spinner always clears (no stuck loading states).

## Algorithm

### Edge cost

Every planet pair has an implicit edge at full Euclidean cost. Routes are **bidirectional** discounts applied when a matching entry exists (keyed on `min(fromId, toId)-max(fromId, toId)`):

```
cost(a, b):
  d = euclidean(a, b)
  if {a,b} in mainSet:  return 0.5 * d
  if {a,b} in otherSet: return (2/3) * d
  return d
```

**Critical:** complete connectivity is always guaranteed — routes only cheapen, never gate.

### Step 1 — Dense cost matrix (`costMatrix.ts`)

Build an `n×n` `Float64Array` (`data[i*n+j]`) covering all planet pairs. The matrix is symmetric because route keys are canonicalized. Forbidden planets are not removed from the matrix; they are excluded later during shortest-path computation.

### Step 2 — All-pairs shortest paths (`allPairsSP.ts`)

Run one Dijkstra per *key node* (start + mandatory + all valid bonus planets) with the forbidden planet set blocked. Produces:

- `spCost: Map<srcIdx, Float64Array>` — `spCost.get(s)[t]` = min cost from `s` to `t`
- `spPath: Map<srcIdx, (number[]|null)[]>` — corresponding dense-index paths

These are computed once per `heldKarpSolve` call and shared across all bonus subsets.

### Step 3 — Bonus subset enumeration (`heldKarpSolve.ts`)

With `b` valid bonus planets, enumerate all `2^b` subsets. Ordering:

1. **Empty subset first** — establishes an initial upper bound so the branch-and-bound cutoff in the HK generator fires early (without an initial bound, the generator would grow an O(n!) heap before yielding its first ordering).
2. **Remaining subsets descending by total bonus credit** — maximises the chance that high-value subsets beat the current best before expensive orderings are explored.

For each subset, `forcedIdxs = [startIdx, ...mandatoryIdxs, ...bonusSubsetIdxs]` and a small `fLen×fLen` Held-Karp cost matrix is built from the precomputed `spCost`.

### Step 4 — Held-Karp ordering generator (`heldKarp.ts`)

`heldKarpGen(n, costs)` is a generator that yields **all** orderings of `n` forced stops in non-decreasing lower-bound order, using a priority-queue over partial tours. Each yielded ordering is a complete round trip `[0, …permutation…, 0]` (index 0 = start).

Unlike classical Held-Karp DP (which keeps only the best partial tour per `(mask, last)` state), this generator keeps **all** prefixes. This is necessary because the realized cost after path-level DP can exceed the lower bound — the cheapest-LB ordering is not always the cheapest realized ordering.

**B&B cutoff in the caller:** once `lbCost − bonusCredit ≥ best.effectiveFuel`, all further orderings from the generator are at least as expensive and the inner loop breaks.

### Step 5 — Full path DP realization (`heldKarpSolve.ts: realizeOrderingDP`)

For each ordering, find the minimum-cost simple path that visits all forced stops in order via **joint DP across all segments** rather than greedy per-segment repair.

**Why greedy repair fails:** a greedy approach takes the precomputed SP for each segment in order, running Dijkstra repair when a conflict is found (SP intermediate ∈ visited set). This causes cascading failures: consuming a bottleneck transit node in segment *i* forces an expensive detour in segment *i+1*, which consumes a second bottleneck, forcing an even more expensive detour in segment *i+2*.

**DP formulation:**

State: `(seg, planet, keyMask)` where
- `seg` — which forced stop we're currently heading toward (0 → segCount)
- `planet` — current dense planet index
- `keyMask` — bitmask of which *bottleneck transit nodes* have been consumed

Key nodes are identified dynamically per ordering by scanning the precomputed SP paths and finding transit nodes that appear as intermediates on 2 or more segments (i.e., nodes whose consumption in one segment would block another). Up to 8 are tracked.

State space: `(segCount+1) × n × 2^K`. For typical challenges (segCount≈11, n≈200, K=2): ~8,800 states — one Dijkstra pass is fast.

Forbidden transitions from `(seg, planet, mask)` to neighbor `w`:
- `w` is in `baseForbidden` (challenge forbidden set)
- `w` is a key node with its bit already set in `mask`
- `w` ∈ `stops[1..seg]` — already-visited forced stop (no revisit)
- `w` ∈ `stops[seg+2..segCount]` — future forced stop (no premature transit)

When `w === stops[seg+1]` (the next target), `seg` advances in the new state.

After reconstruction, a simple-path check catches any non-key transit revisits (the bitmask approximation). Orderings that fail this check return `null` and are skipped.

The effective fuel of a realized route is `grossFuel − collectedBonus`, where `collectedBonus` credits every bonus planet appearing anywhere on the route (not just if it was in the forced subset — transit bonuses count).

### Summary flow

```
heldKarpSolve(input):
  matrix   ← buildCostMatrix(planets, routes)
  sp       ← computeAllPairsSP(matrix, keyNodes, forbiddenSet)

  for bonusSubset in [∅, then descending-by-value subsets]:
    forcedIdxs ← [start, ...mandatory, ...subset]
    hkCosts    ← fLen×fLen matrix from sp.spCost

    for { ordering, lbCost } in heldKarpGen(fLen, hkCosts):
      if lbCost − bonusCredit ≥ best.effectiveFuel: break   // B&B

      result ← realizeOrderingDP(ordering, ...)
      if result && result.gross − result.collected < best.effectiveFuel:
        update best

  return best
```

### Edge cases

- Mandatory list empty, no bonuses: return `[start, start]` with zero fuel.
- Mandatory list contains start: dedupe, treat as no-op.
- Mandatory contains a forbidden planet: `success: false`.
- Start planet forbidden: `success: false`.
- Start ID not in planet list: `success: false`.
- Mandatory planet not in planet list: `success: false` with message.
- Mandatory pairwise unreachable (checked via `spCost` before enumeration): `success: false`.
- Bonus planet not in planet list or value ≤ 0: ignore.
- Solver exceeds 5-minute wall-clock timeout: returns best-so-far with `timedOut: true`. If nothing was found yet: `success: false`.

## Oracle validation

The oracle is **manual** — triggered by clicking "Calculate Coaxium" after viewing a solution.

- The API's `Coaxium` value is the source of truth.
- Match (within 1 unit): green verified banner.
- Mismatch: yellow banner with both values. Signals an algorithm bug or cost-model change.
- Rejection (`IsSuccess: false`): red banner with `FeedbackMessage`.

## Submission flow

Gated to prevent accidental submission. Appears only after oracle verification:

1. Click **"Submit solution"** → inline confirmation appears.
2. Click **"Confirm submit"** → fires `POST /SubmitChallengeSolution`.
3. Result banner appears. The submit UI remains visible — you can re-submit if needed.

## Deployment

Static site deployed to GitHub Pages via GitHub Actions.

**Workflow** (`.github/workflows/deploy.yml`):
- Triggers on push to `main` or manual `workflow_dispatch`
- Runs `npm ci` in `route-solver-web/`, then `npm run build` with credentials injected from GitHub Actions secrets
- Uploads `route-solver-web/dist/` as the Pages artifact

**Secrets required** (Settings → Secrets and variables → Actions):
- `VITE_PLAYER_GUID`
- `VITE_PLAYER_EMAIL`
- `VITE_API_BASE_URL`

**Custom domain:** set via Settings → Pages → Custom domain and backed by `public/CNAME` so it survives every deploy.

## Tests

### Unit tests (`solver.test.ts`)

Layer-by-layer tests covering `buildCostMatrix`, `computeAllPairsSP`, and `heldKarpGen`, followed by acceptance tests T1–T13 against the top-level `solve()`:

| Test | What it checks |
|---|---|
| T1 | Trivial tour (no stops) returns `[start, start]` with zero fuel |
| T2 | One mandatory: correct round-trip cost |
| T3 | Two mandatories: both visited, globally optimal ordering |
| T4 | Forbidden: mandatory=forbidden → error; start=forbidden → error; forbidden transit avoided |
| T5 | Bonus inclusion: detour < bonus value → collected |
| T6 | Bonus exclusion: detour > bonus value → skipped |
| T7 | Route discounts: main ×0.5, other ×2/3, discount path preferred over direct full-cost |
| T8 | Mandatory equals start: no-op, trivial tour |
| T9 | Conflict detection: mandatory=forbidden → error |
| T10 | Transit node disjointness: cheapest SP paths share an intermediate; solver finds a disjoint route |
| T12 | Transit bonus: bonus planet on the natural path is credited without being in mandatory list |
| T13 | Performance: 3-mandatory in < 100 ms; 4-mandatory + 2-bonus in < 2 s |

### Real-world tests (`realWorld.test.ts`)

End-to-end regression suite on the full 195-planet live game map (fixture in `realWorld.fixture.ts`). Results verified against the game leaderboard:

| Test | Scenario | Expected effective fuel |
|---|---|---|
| T14 | Mandalore start, 5 mandatory, no forbidden/bonus | 3472 CX |
| T15 | Same + Chardaan/Agamar forbidden | 3634 CX |
| T16 | Same + forbidden + Brentaal(150)/Ryloth(450) bonuses | 3460 CX |
| T17 | Coruscant start, 3 mandatory, no forbidden/bonus | 1355.07 CX |
| T18 | Same + Tirahnn forbidden | 1610.31 CX |
| T19 | Same + Tirahnn forbidden + Loronar(300) bonus | 1592.21 CX |
| C100 | Loronar start, 7 mandatory, no forbidden/bonus | 2818 CX |
| C101 | Same + 4 forbidden | 3005 CX |
| C102 | Same + 4 forbidden + Ryloth(450)/Terminus(200)/Askaj(100) bonuses | 2915 CX |

C102 specifically exercises the cascading transit conflict fix: the greedy per-segment repair would yield 2931 CX because consuming Milagro (184) in the Loronar→Vendaxa segment forces Vendaxa→Ryloth onto a repair path through Mon Gazza, which then cascades into Ryloth→Farstine (+59 CX total). The full path DP identifies Milagro and Mon Gazza as bottleneck nodes and jointly routes all segments to avoid the cascade.

## Phase 2 niceties (deferred)

1. **2D map visualization** of the solved route over planet coordinates.
2. **Manual override UI** — alternate start planet, custom forbidden set for experimentation.
3. **Route comparison view** — solve with/without certain bonuses side-by-side.
4. **Performance HUD** — solve time, ordering count explored, bottleneck nodes identified per solve.
5. **Export/import JSON** for sharing inputs or building a regression-test corpus.

## Future work

If the OutSystems ODC delivery becomes the priority again, port `src/solver/` to .NET 8. The algorithm in this spec is language-agnostic and the layer separation maps cleanly to a class-library structure. The cost matrix, all-pairs SP, HK generator, and DP realization should each become their own class.
