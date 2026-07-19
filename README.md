# tetr.lol

A practice client for **LST stacking** (via the **TKI opener**) with live,
per-placement feedback: the engine enumerates every reachable placement,
searches ahead over your real queue, and tells you the moment you make a
mistake - with ranked alternatives to browse.

Built from the diagrams on [four.lol/stacking/lst](https://four.lol/stacking/lst/)
and [four.lol/openers/tki](https://four.lol/openers/tki/).

## Run

```
npm install
npm run dev        # http://localhost:5199
npm run app        # desktop app (builds dist/, launches system electron)
npm run app:dev    # electron against the running vite dev server
npm test           # core + engine + opener-book tests
npm run build      # production build (dist/)
npm run gen:lst-db # regenerate src/data/*.json from tools/data snapshots
```

`tools/install-desktop.sh` installs an app-menu launcher (`tetr.lol`)
that runs the built app via the system electron package.

## Modes

- **LST drill** - the full flow on one board: build the TKI opener yourself
  (every placement checked against the four.lol flat-top book, exact
  per-piece matching), the first TSD drops you straight into the LST loop
  with engine grading biased toward the canonical LST structure (spin column
  stays column 3, plugging it is flagged as a loop killer). `R` rerolls.
  Tip: hold T when it comes early. Add `?seed=N` to the URL to pin a bag.
- **4-wide drill** - center 4-wide combo practice: the well sits on columns
  4–7 between "infinite" wall columns (they top themselves back up after
  every clear), starting from a random book residual. Every placement is
  graded against the 4-wide combo book: the 28 canonical 3-residual states
  (the set DDRKirby's 4-wide trainer enumerates) with every continuation
  re-derived by this engine's own SRS+ move generator
  (`tools/gen-fourwide-db.ts` → 144 continuations). Advice is hold-aware
  (parking a dead piece in an empty hold is a free non-lock) and
  **bag-aware**: it works out the exact undealt remainder of the current
  7-bag past your preview (`bagRemainder` - derivable from piece count and
  queue) and ranks moves not just by whether they survive the visible queue
  but by `guaranteedDepth`, a worst-case DP over every bag order that says
  how many more pieces the combo is guaranteed to survive from each landing
  state (a bag-exact version of DDRKirby's genericScore tie-break). Two
  lines that both reach the preview horizon are separated by which one is
  more bag-proof - this roughly triples sustained combo length over a plain
  horizon score. A toast warns when the queue provably cannot reach the
  horizon. Breaking the combo when a continuation existed is a **Combo
  breaker**; after a break, recovery clears are graded too (landing back on
  a canonical residual is Best). Combo counter sits on the board's left
  edge. (Note: zero-lookahead center 4-wide is not truly infinite - an
  adversarial bag always ends it eventually - so `guaranteedDepth` is a
  ranking signal, not a promise of immortality.)
- **40 Lines** - sprint on an empty board: the clock starts on your first
  input and stops at 40 cleared lines, with generic engine grading throughout.
- **Quick play** - a single-player simulator of TETR.IO QUICK PLAY (Zenith
  Tower): pick a starting floor (0–1650m). Base mode uses the standard
  500ms lock delay (guideline Extended Placement Lock Down, 15 move
  resets, grounded piece dims as the timer runs) and a mild approximate
  gravity curve; the documented per-floor speed table (0.48G→3.18G, lock
  30f→16f) is behind the Gravity-mod toggle. Simulated incoming garbage
  with per-floor messiness and a pressure knob, climb-speed ranks, B2B
  surge, and altitude scoring. Incoming garbage shows on a red meter on the board's left edge
  (solid = enters on your next lock, pulsing = telegraphed), with a B2B ×N
  counter above it. Attack cadence is calibrated against 1000 real QUICK
  PLAY records from the TETRA CHANNEL API (tools/calibrate-zenith.mjs;
  ≈5 lines/min on F1 up to ≈70 on F10 at normal pressure). No grading -
  this mode is for feeling out the speed.
- **Patterns** - the full four.lol diagram library (LST, TKI and 4-wide
  pages), rendered in-app; click a card to open it in the fumen viewer.

The **paths panel** is docked on the right side of the drill: after every
placement it shows your grade, the reasons, and the ranked alternatives -
hover a card to preview it on the field. `Tab` collapses it.

Grading treats **back-to-back as canon**: a plain 1–3 line clear breaks the
chain and is tolled in the search (so the engine never suggests one while
the loop is alive) and floored to a mistake when you had a chain-keeping
alternative. Forced burns (queue provably can't sustain the loop, or the
loop is already dead) are not punished. Every verdict is double-checked by
a deeper second-opinion search over the top candidates, and a clean
best/good verdict never carries advisory scolding.

A **learned evaluator** (14→16→1 MLP, `tools/train-lst-eval.ts`) adds a
residual correction on top of the hand-tuned weights in LST mode. It is
trained on engine self-play from the post-TKI board against Monte-Carlo
discounted returns, so a zero net is a strict no-op; toggle it off under
Settings → Neural evaluator. Retrain with
`npx tsx tools/train-lst-eval.ts 400` after changing eval features.

Piece/clear/garbage **sounds** are real TETR.IO samples extracted from a
tetrio-plus `.tpse` soundpack via `tools/extract-tpse-sfx.mjs` into
`public/sfx/` (personal use).

The UI is a tetr.io-style **application shell** (dark-first, glassy panels,
uppercase display type) with a juiced field: hard-drop beams, lock flashes,
line-clear particles and screen shake, action-text popups ("QUAD",
"T-SPIN DOUBLE", "B2B ×n", "ALL CLEAR", floor-ups and SURGE in Quick play),
and a red danger vignette as the stack climbs. All of it sits behind
Settings → Appearance → Board effects if you want a calmer field.

Rotating **backgrounds** (tetr.io style) sit behind the app: built-in
generated scenes by default, or your own pictures - Settings → Background →
"Add images…" / "Add folder…" stores them locally (IndexedDB) and cycles
through them; dim strength and cycle interval are sliders, and "aurora glow
only" turns images off.

**Stats** keeps per-session history (5+ graded placements) with accuracy
trend charts, quick-play altitude per run, and a session log - all local.

## Keys (rebindable in Settings, Ctrl/Alt chords supported)

arrows move · `↑`/`X` cw · `Z` ccw · `A` 180 · `Space` hard drop ·
`Shift`/`C` hold · `Ctrl+Z` undo · `R` retry · `Tab` toggle paths panel ·
`Esc` resume after stop-on-mistake

Handling (DAS/ARR/SDF in ms, tetr.io semantics - ARR 0 = instant,
SDF 41 = instant) is in Settings, applied live, saved locally.

## How grading works

On every lock the worker: (1) enumerates all reachable placements for the
piece you had (BFS over shifts/rotations/soft drops with SRS+ kicks - finds
tucks and spins), plus the hold option; (2) beam-searches 3 pieces ahead over
your actual preview ranking each candidate with an LST-aware evaluation
(T-slot integrity, holes, overhangs, burns, TSD rewards); (3) grades your
move by its gap to the best line and explains the biggest defect. Budget is
~50–300 ms in a worker; gameplay never blocks.

## Architecture

```
src/core/     pure game logic (bitboard, SRS+ w/ 180, 7-bag, handling, spins)
src/engine/   analysis (enumerate, eval, beam search, grading, opener book)
src/data/     generated knowledge base from four.lol page data
src/ui/       vanilla-TS views, canvas renderer, worker client
tools/        gen scripts (gen-lst-db, gen-lst-cover, gen-fourwide-db) + data snapshots
```

Planned next: more openers (DT cannon), deeper neural evaluator (bigger
self-play corpus, temporal-difference training).
