# Cold Clear 2 (all-spin) — WASM build

The all-spin trainer's analysis is powered by **Cold Clear 2**
(<https://github.com/MinusKelvin/cold-clear-2>, MIT/Apache-2.0), the modern
Tetris bot. The vendored `cold_clear_2*.{js,wasm,d.ts}` here are build artifacts;
this file documents how to reproduce them.

Public CC2 is **T-spin only** — its move generator hard-codes
`if target.piece != Piece::T { spin = Spin::None }`. We patch that one site to
the tetr.io **all-spin** rule (a non-T piece rotated into an immobile spot
scores a spin) and add a small `wasm-bindgen` wrapper (`src/api.rs`) that drives
the single-threaded `Bot` API directly (no OS threads / TBP harness).

All source changes are in `cold-clear-2-allspin.patch`.

## Reproduce

```sh
# toolchain (once)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
  --default-toolchain stable --profile minimal --target wasm32-unknown-unknown
cargo install wasm-pack   # or grab the prebuilt binary

# source
git clone https://github.com/MinusKelvin/cold-clear-2   # base commit ed8b193
cd cold-clear-2
git apply /path/to/cold-clear-2-allspin.patch
rm -f Cargo.lock && cargo generate-lockfile             # bumps wasm-bindgen to a
                                                        # Rust-current version

# build + vendor
wasm-pack build --target web --out-dir pkg --release
cp pkg/cold_clear_2.js pkg/cold_clear_2_bg.wasm pkg/cold_clear_2*.d.ts \
   <repo>/src/engine/cc2/
```

## API (see `src/api.rs` in the patch)

`new ColdClear(cols: Uint32Array[10], queue: string, hold: string, b2b, combo, weights)`
→ `.work(iters)` to think → `.suggest()` returns the best move as JSON
(`{piece, spin:'n'|'m'|'f', lines, usesHold, x, y, cells}`), or null.

`weights` is a `BotConfig` JSON string overriding the built-in evaluation
(`""` = defaults). The LST-loop profile lives in `src/engine/cc2-weights.ts`
(`CC2_LST_LOOP`) — tune it there, no wasm rebuild needed; only adding a brand
new weight field requires reapplying the patch and rebuilding.

Consumed by `src/engine/cc2-worker.ts` + `src/ui/cc2-client.ts`.
