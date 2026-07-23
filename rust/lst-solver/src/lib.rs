//! Rust/wasm port of the tetr-ai LST full-queue solver.
//!
//! Layered to mirror the TypeScript source so each layer can be parity-checked
//! against fixtures dumped from TS before the next is trusted:
//!   board -> pieces -> masks/srs/spin -> enumerate -> eval -> solver.

pub mod api;
pub mod board;
pub mod enumerate;
pub mod eval;
pub mod masks;
pub mod pieces;
pub mod solver;
pub mod spin;
pub mod srs;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// wasm entry: JSON SolveRequest in, JSON SolveResult (or "null") out.
/// Mirrors solveLstRun; see api::solve_json.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn solve(input: &str) -> String {
    api::solve_json(input)
}
